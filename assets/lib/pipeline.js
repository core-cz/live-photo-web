// 浏览器端完整流水线：分类 → 转码/直通 → 抽封面 → 写元数据 → 打包。
// 不联网、不上传，所有计算都在本机完成。
//
// 两个槽位可以混搭：
//   主素材 = 画面（照片 / 视频 / 实况照片）
//   副素材 = 声音或动态（语音 / 视频 / 照片）
// 典型组合：照片 + 语音（给老照片配上亲人的声音）、照片 + 视频、视频 + 语音。

import { FFmpeg } from "../vendor/ffmpeg/classes.js";
import { injectLivePhoto, randomUUID } from "./livephoto.js";
import { jpegForIos } from "./exif.js";
import { buildMotionPhoto } from "./motion.js";
import { makeZip } from "./zip.js";
import { makeCover } from "./cover.js";
import { extractMotionVideo, hasAudioTrack, isHeic, readMotionTimestamp } from "./embedded.js";

// 封面落到第 1.5 秒 —— 与剪映产物里 `MotionPhotoPresentationTimestampUs=1500000`
// 完全一致。这个值不是随便写的：播放器点开实况时先显示封面，再从这个时间点
// 起播视频。封面抽帧点和 XMP 时间戳必须严格对齐，错开就会看到画面「跳一下」。
export const STILL_TIME = 1.5;

// 单条实况的上限。朋友圈会截短，但微信聊天、系统相册都吃长片，
// 剪映能导出几十秒，我们没必要自己卡在 3.9 秒。
export const MAX_SECONDS = 60;

const VIDEO_EXT = ["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp"];
const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "heic", "heif", "bmp", "livp"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"];

let instance = null;
let loading = null;
let templateCache = null;
let progressHandler = null;
let downloadRatio = 0;
let downloadCb = null;

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

export function detectKind(file) {
  const ext = extOf(file.name);
  if (VIDEO_EXT.includes(ext) || (file.type || "").startsWith("video/")) return "video";
  if (IMAGE_EXT.includes(ext) || (file.type || "").startsWith("image/")) return "image";
  if (AUDIO_EXT.includes(ext) || (file.type || "").startsWith("audio/")) return "audio";
  return null;
}

export async function loadTemplate() {
  if (!templateCache) {
    const res = await fetch(new URL("../metadata_tpl.mov", import.meta.url));
    if (!res.ok) throw new Error("元数据模板加载失败");
    templateCache = new Uint8Array(await res.arrayBuffer());
  }
  return templateCache;
}

async function fetchWasm() {
  const url = new URL("../vendor/core/ffmpeg-core.wasm.gz", import.meta.url).href;
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前浏览器不支持 DecompressionStream，请升级到 iOS 16.4+ / Chrome 80+ 再试");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error("编码器下载失败，请检查网络后重试");

  const total = Number(res.headers.get("Content-Length") || 0);
  const chunks = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) {
      downloadRatio = Math.min(1, received / total);
      if (downloadCb) downloadCb(downloadRatio);
    }
  }
  const gz = new Blob(chunks, { type: "application/gzip" });
  const raw = await new Response(gz.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return URL.createObjectURL(new Blob([raw], { type: "application/wasm" }));
}

export function loadFFmpeg(onDownload) {
  if (instance) return Promise.resolve(instance);
  if (onDownload) {
    downloadCb = onDownload;
    onDownload(downloadRatio);
  }
  if (!loading) {
    loading = (async () => {
      const ffmpeg = new FFmpeg();
      ffmpeg.on("progress", ({ progress }) => {
        if (progressHandler) progressHandler(Math.max(0, Math.min(1, progress || 0)));
      });
      const wasmURL = await fetchWasm();
      await ffmpeg.load({
        coreURL: new URL("../vendor/core/ffmpeg-core.js", import.meta.url).href,
        wasmURL,
      });
      instance = ffmpeg;
      downloadRatio = 1;
      return ffmpeg;
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** 预热：用户选完文件就开始下载编码器，不用等点生成 */
export function warmup() {
  loadFFmpeg().catch(() => {});
}

function probeUrl(url, tag) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(tag);
    el.preload = "metadata";
    el.muted = true;
    const done = () => resolve({
      width: el.videoWidth || 0,
      height: el.videoHeight || 0,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
    });
    el.onloadedmetadata = done;
    el.onerror = () => reject(new Error("媒体无法解析"));
    el.src = url;
    setTimeout(() => reject(new Error("读取媒体信息超时")), 20000);
  });
}

async function probeVideo(bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
  try {
    return await probeUrl(url, "video");
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function probeImage(file) {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, duration: 0 });
      img.onerror = () => reject(new Error("图片无法解析"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function probeAudio(file) {
  const url = URL.createObjectURL(file);
  try {
    return await probeUrl(url, "audio");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

// 剪映导出的实况视频是 480×852（短边 480）。ColorOS 相册对超过这个尺寸的
// 实况会提示「该实况照片规格较高，播放时可能会卡顿」，然后切到降级播放路径
// ——表现就是画面能动、声音没了。所以这里把短边死死卡在 480。
export const MAX_SHORT_SIDE = 480;

export function targetSize(width, height, maxShort = MAX_SHORT_SIDE) {
  if (!width || !height) return { w: 480, h: 852 };
  const scale = Math.min(1, maxShort / Math.min(width, height));
  return { w: even(width * scale), h: even(height * scale) };
}

const SILENT = "anullsrc=channel_layout=stereo:sample_rate=44100";

/**
 * 把两个槽位分类成「画面来源 / 声音来源 / 封面来源」。
 * 不碰 ffmpeg，纯字节判断，用来决定后面走哪条路。
 */
export async function buildPlan(primary, secondary) {
  if (!primary) throw new Error("请先选主素材");
  const bytesA = new Uint8Array(await primary.arrayBuffer());
  if (isHeic(bytesA)) {
    throw new Error("这是 HEIC 原图，浏览器解不了。请在相册里先「导出为 JPG」");
  }

  const kindA = detectKind(primary);
  if (!kindA) throw new Error("主素材格式不支持");

  let A = { kind: kindA, file: primary, bytes: bytesA };
  if (kindA === "image") {
    const mv = extractMotionVideo(bytesA);
    if (mv) {
      A = {
        kind: "motion", file: primary, bytes: bytesA, video: mv.video,
        tsUs: readMotionTimestamp(bytesA),
      };
    }
  } else if (kindA === "video") {
    A.video = bytesA;
  }

  let B = null;
  if (secondary) {
    const bytesB = new Uint8Array(await secondary.arrayBuffer());
    if (isHeic(bytesB)) throw new Error("副素材是 HEIC 原图，请先转成 JPG");
    const kindB = detectKind(secondary);
    if (!kindB) throw new Error("副素材格式不支持");
    B = { kind: kindB, file: secondary, bytes: bytesB };
    if (kindB === "image") {
      const mv = extractMotionVideo(bytesB);
      if (mv) B = { kind: "motion", file: secondary, bytes: bytesB, video: mv.video };
    } else if (kindB === "video") {
      B.video = bytesB;
    }
  }

  const videoOf = (x) => (x && (x.kind === "video" || x.kind === "motion") ? x : null);
  const vA = videoOf(A);
  const vB = videoOf(B);

  // 画面优先取主素材；主素材是静态图时，副素材的视频就是动态来源
  const video = vA || vB;
  // 封面优先取主素材的静图；主素材是音频时退到副素材
  const still = A.kind === "image" ? primary : (B && B.kind === "image" ? secondary : null);
  // 声音优先取副素材；副素材是另一段视频时，取那段视频的音轨
  const audioFile = B && B.kind === "audio" ? secondary : null;
  const audioVideo = !audioFile && vB && vB !== video ? vB : null;

  let videoInfo = null;
  if (video) {
    videoInfo = await probeVideo(video.video).catch(() => null);
    if (!videoInfo || !videoInfo.width) {
      // 浏览器解不了这个编码（例如 HEVC）：尺寸退回封面，时长保持 0 由调用方兜底
      const fallback = still ? await probeImage(still) : { width: 0, height: 0, duration: 0 };
      videoInfo = { ...fallback, duration: videoInfo ? videoInfo.duration : 0 };
    }
  }
  const stillInfo = still ? await probeImage(still) : null;
  const audioInfo = audioFile ? await probeAudio(audioFile) : null;

  return {
    A, B, video, videoFromSecondary: !vA && Boolean(vB),
    audioFile, audioVideo, still,
    videoInfo, stillInfo, audioInfo,
    hasOwnAudio: video ? hasAudioTrack(video.video) : false,
  };
}

function sourceSize(plan) {
  if (plan.videoInfo && plan.videoInfo.width) {
    return targetSize(plan.videoInfo.width, plan.videoInfo.height);
  }
  if (plan.stillInfo) return targetSize(plan.stillInfo.width, plan.stillInfo.height);
  return { w: 1080, h: 1920 };
}

function naturalDuration(plan) {
  if (plan.videoInfo && plan.videoInfo.duration) return Math.min(MAX_SECONDS, plan.videoInfo.duration);
  if (plan.audioInfo && plan.audioInfo.duration) return Math.min(MAX_SECONDS, plan.audioInfo.duration);
  return 0;
}

async function makeClip(ffmpeg, plan, size, opts, names) {
  const { duration, start } = opts;
  const { w, h } = size;
  const audioIn = plan.audioFile ? "audio-in" : null;

  // 有画面：主素材或副素材里的视频
  if (plan.video) {
    const vw = plan.videoInfo && plan.videoInfo.width ? plan.videoInfo.width : 0;
    const vh = plan.videoInfo && plan.videoInfo.height ? plan.videoInfo.height : 0;
    // 实况原件直通时尺寸通常已经是 480×852，一个字节都别动；
    // 用户自己传的 1080p 视频必须压下来，否则 ColorOS 会提示「规格较高」并丢掉音轨。
    const needScale = plan.video.kind === "motion"
      ? (vw > 0 && Math.min(vw, vh) > MAX_SHORT_SIDE)
      : (vw === 0 || Math.min(vw, vh) > MAX_SHORT_SIDE);

    const args = ["-hide_banner", "-y"];
    if (start > 0.01) args.push("-ss", start.toFixed(3));
    args.push("-i", names.video);
    if (audioIn) args.push("-i", audioIn);
    else if (!plan.hasOwnAudio) args.push("-f", "lavfi", "-i", SILENT);

    args.push("-t", String(duration), "-map", "0:v:0");
    args.push("-map", audioIn ? "1:a:0" : (plan.hasOwnAudio ? "0:a:0" : "1:a:0"));

    if (needScale) {
      args.push(
        "-vf", `scale=${w}:${h}:flags=lanczos,setsar=1`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24",
        "-pix_fmt", "yuv420p", "-profile:v", "baseline", "-level", "3.1",
        "-r", "30",
      );
    } else {
      // 画面原样直通：剪映的 HEVC 我们编不动，也没必要编。
      // 更重要的是 copy 不会改动视频里的 udta/meta。
      args.push("-c:v", "copy");
    }

    if (audioIn || !plan.hasOwnAudio) {
      args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
    } else {
      args.push("-c:a", "copy");
    }
    args.push("-shortest", "clip.mov");
    await ffmpeg.exec(args);
    return;
  }

  // 没有画面：用封面静图做缓慢推近
  const frames = Math.max(2, Math.round(duration * 30));
  const args = ["-hide_banner", "-y", "-i", names.still];
  if (audioIn) args.push("-i", audioIn);
  else args.push("-f", "lavfi", "-i", SILENT);

  args.push(
    "-vf", [
      `scale=${even(w * 1.5)}:-2:flags=lanczos`,
      `zoompan=z='min(zoom+0.0012,1.16)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=30`,
      "setsar=1",
    ].join(","),
    "-frames:v", String(frames),
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-t", String(duration),
    "-shortest",
    "clip.mov",
  );
  await ffmpeg.exec(args);
}

export async function readFileBytes(ffmpeg, name) {
  const data = await ffmpeg.readFile(name);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * @param {{primary: File, secondary?: File|null, duration?: number, start?: number,
 *          coverAt?: number|null, onStage?: (name: string, progress?: number) => void}} opts
 *        duration = 0 表示「全长」；start = 从原视频第几秒开始截（默认 0）
 *        coverAt  = 封面定格在片段里的第几秒，也写进 XMP 的 PresentationTimestamp
 */
export async function generate(opts) {
  const {
    primary, secondary = null, duration: want = 0, start = 0, coverAt = null,
    onStage = () => {},
  } = opts;

  onStage("分析素材", 0);
  const plan = await buildPlan(primary, secondary);
  const size = sourceSize(plan);
  const natural = naturalDuration(plan);

  let duration = want > 0 ? (natural ? Math.min(want, natural) : want) : (natural || 3);
  duration = Math.max(0.6, Math.min(MAX_SECONDS, duration));

  // 纯直通：整段实况照片 + 没有换声音 → 一个字节都不碰 ffmpeg。
  // 这样视频里的 udta/meta、编码参数、音轨全部原封不动，和剪映原件一致。
  const pure =
    plan.video && plan.video.kind === "motion" &&
    !plan.audioFile && !plan.audioVideo &&
    start <= 0.01 &&
    duration >= (plan.videoInfo?.duration || 0) - 0.05;

  let clip;
  if (pure) {
    onStage("复用原始片段", 1);
    clip = plan.video.video;
  } else {
    onStage("准备编码器", 0);
    const ffmpeg = await loadFFmpeg((p) => onStage("下载编码器", p));
    onStage("准备编码器", 0);

    onStage("写入素材");
    const names = {};
    if (plan.video) {
      names.video = plan.video.kind === "motion" ? "motion.mp4" : `video.${extOf(plan.video.file.name) || "mp4"}`;
      await ffmpeg.writeFile(names.video, plan.video.video);
    } else {
      names.still = `still.${extOf(plan.still.name) || "jpg"}`;
      await ffmpeg.writeFile(names.still, new Uint8Array(await plan.still.arrayBuffer()));
    }
    if (plan.audioFile) {
      await ffmpeg.writeFile("audio-in", new Uint8Array(await plan.audioFile.arrayBuffer()));
    }

    onStage("转码", 0);
    progressHandler = (p) => onStage("转码", p);
    await makeClip(ffmpeg, plan, size, { duration, start }, names);
    progressHandler = null;

    clip = await readFileBytes(ffmpeg, "clip.mov");
    for (const name of [names.video, names.still, "audio-in", "clip.mov"]) {
      if (name) await ffmpeg.deleteFile(name).catch(() => {});
    }
  }

  onStage("生成封面");
  // 封面来源：照片优先；其次是实况照片自带的静图；最后才是从视频里抽帧
  const stillFromLive = !plan.still && plan.video && plan.video.kind === "motion";
  // 封面可以比视频大：剪映产物就是 720×1280 的封面配 480×852 的视频。
  // 视频卡在 480 是为了让相册走流畅播放路径，封面不必跟着降。
  // 但**比例必须和视频严格一致**，否则播放器在封面与首帧之间切换时会看到拉伸，
  // 有些机型据此判定「封面与视频不匹配」直接不认。
  const coverScale = 720 / Math.min(size.w, size.h);
  const coverSize = { w: even(size.w * coverScale), h: even(size.h * coverScale) };
  // 定格点：用户拖的滑块优先；复用别人的实况时沿用原片写好的时间戳；
  // 都没有就落在 1.5s（剪映的默认值）。不超过片长的 60%，避免短片抽不到帧。
  const wantAt = coverAt != null ? coverAt
    : (plan.video && plan.video.tsUs != null ? plan.video.tsUs / 1e6 : STILL_TIME);
  const stillPoint = Math.max(0, Math.min(wantAt, Math.max(0.1, duration * 0.6)));
  const cover = await makeCover({
    kind: plan.still || stillFromLive ? "image" : "video",
    file: plan.still || plan.video.file,
    coverFile: null,
    coverTime: start + stillPoint,
    width: coverSize.w,
    height: coverSize.h,
  });

  onStage("写入实况元数据");
  const template = await loadTemplate();
  const uuid = randomUUID();

  const mov = injectLivePhoto(clip, template, uuid);
  const jpg = jpegForIos(cover, uuid);
  // Android 版用未注入 mebx 轨的原始片段：多轨结构会让 OPPO 播放器"识别正常但播放失败"
  const motionPhoto = buildMotionPhoto(cover, clip, Math.round(stillPoint * 1e6));
  const stillAt = stillPoint;

  onStage("打包");
  const iosZip = makeZip([
    { name: "IMG_0001.JPG", data: jpg },
    { name: "IMG_0001.MOV", data: mov },
  ]);
  const livp = makeZip([
    { name: "IMG_0001.JPG", data: jpg },
    { name: "IMG_0001.MOV", data: mov },
  ]);
  const bundle = makeZip([
    { name: "IMG_0001.zip", data: iosZip },
    { name: "IMG_0001.MP.jpg", data: motionPhoto },
    { name: "ios-备用.livp", data: livp },
    { name: "README.txt", data: new TextEncoder().encode(readmeText(plan)) },
  ]);

  const kindLabel = plan.video
    ? (plan.video.kind === "motion" ? "motion" : "video")
    : "image";

  return {
    kind: kindLabel, uuid, size, duration, start, stillAt, pure,
    audio: Boolean(plan.audioFile || plan.hasOwnAudio || plan.audioVideo),
    cover, mov, jpg, motion: motionPhoto, livp, iosZip, bundle,
  };
}

function readmeText(plan) {
  const visual = plan.video
    ? (plan.video.kind === "motion" ? "已有的实况照片" : "视频")
    : "照片（缓慢推近）";
  const sound = plan.audioFile ? "副素材的音频"
    : plan.audioVideo ? "副素材视频的音轨"
      : plan.hasOwnAudio ? "画面自带音轨" : "静音（补空 AAC 轨）";
  return `Live Photo Studio 导出说明
==========================

【iPhone / iPad】
  用 IMG_0001.zip 那份，不要用 .livp（iOS 文件 App 导不进 .livp）：
    1. 下载 IMG_0001.zip
    2. 打开「文件」App，点 ZIP 解压，得到 IMG_0001.JPG 和 IMG_0001.MOV
    3. 点右上角「选择」，把这两个文件一起勾上
    4. 点「分享」→「存储到照片」
       —— 必须同一次操作里选中两个文件，iOS 靠配对标识符合并成一张实况照片
    5. 打开「照片」，长按照片应能播放

【Android】
  用 IMG_0001.MP.jpg：
    1. 下载后移动到 DCIM/Camera 或 Pictures 目录
       —— 相册只索引这几个目录，留在 Download 里不会出现
    2. 打开系统相册，长按照片查看动态效果

【共同注意】
  - iOS 与 Android 是两套互不兼容的容器，一个文件无法被两端同时识别
  - 微信/QQ 普通传输会重新压缩图片并剥掉全部元数据，务必用「原图」或数据线
  - 朋友圈实况有时长上限，超了会被转成静态图；聊天里发不受这个限制
画面来源：${visual}
声音来源：${sound}
`;
}
