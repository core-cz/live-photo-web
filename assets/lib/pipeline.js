// 浏览器端完整流水线：转码 → 抽封面 → 写元数据 → 打包。
// 不联网、不上传，所有计算都在本机完成。

import { FFmpeg } from "../vendor/ffmpeg/classes.js";
import { injectLivePhoto, randomUUID } from "./livephoto.js";
import { jpegWithUUID } from "./exif.js";
import { buildMotionPhoto } from "./motion.js";
import { makeZip } from "./zip.js";
import { makeCover } from "./cover.js";

export const STILL_TIME = 0.5;

const VIDEO_EXT = ["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp"];
const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "heic", "heif", "bmp"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"];

let instance = null;
let templateCache = null;
let progressHandler = null;

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

async function fetchWasm(onProgress) {
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
    if (onProgress && total) onProgress(Math.min(1, received / total));
  }
  const gz = new Blob(chunks, { type: "application/gzip" });
  const raw = await new Response(gz.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return URL.createObjectURL(new Blob([raw], { type: "application/wasm" }));
}

export async function loadFFmpeg(onDownload) {
  if (instance) return instance;
  const ffmpeg = new FFmpeg();
  ffmpeg.on("progress", ({ progress }) => {
    if (progressHandler) progressHandler(Math.max(0, Math.min(1, progress || 0)));
  });
  const wasmURL = await fetchWasm(onDownload);
  await ffmpeg.load({
    coreURL: new URL("../vendor/core/ffmpeg-core.js", import.meta.url).href,
    wasmURL,
  });
  instance = ffmpeg;
  return ffmpeg;
}

function probe(file, kind) {
  const url = URL.createObjectURL(file);
  const cleanup = () => URL.revokeObjectURL(url);

  if (kind === "image") {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        cleanup();
        resolve({ width: img.naturalWidth, height: img.naturalHeight, duration: 0 });
      };
      img.onerror = () => {
        cleanup();
        reject(new Error("图片无法解析"));
      };
      img.src = url;
    });
  }

  return new Promise((resolve, reject) => {
    const el = document.createElement("video");
    el.preload = "metadata";
    el.muted = true;
    const done = () => {
      cleanup();
      resolve({
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
        duration: Number.isFinite(el.duration) ? el.duration : 0,
      });
    };
    el.onloadedmetadata = done;
    el.onerror = () => {
      cleanup();
      reject(new Error("媒体无法解析"));
    };
    el.src = url;
    setTimeout(() => {
      cleanup();
      reject(new Error("读取媒体信息超时"));
    }, 20000);
  });
}

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

export function targetSize(width, height, maxShort = 1080) {
  if (!width || !height) return { w: 1080, h: 1920 };
  const scale = Math.min(1, maxShort / Math.min(width, height));
  return { w: even(width * scale), h: even(height * scale) };
}

async function makeClip(ffmpeg, kind, size, opts, inputName) {
  const { coverTime, duration } = opts;
  const { w, h } = size;

  if (kind === "video") {
    const start = Math.max(0, coverTime - STILL_TIME);
    await ffmpeg.exec([
      "-hide_banner", "-y",
      "-ss", start.toFixed(3),
      "-i", inputName,
      "-t", String(duration),
      "-vf", `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},fps=30,setsar=1`,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "25", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "clip.mov",
    ]);
    return;
  }

  if (kind === "image") {
    const frames = Math.round(duration * 30);
    await ffmpeg.exec([
      "-hide_banner", "-y", "-i", inputName,
      "-vf", [
        `scale=${even(w * 1.5)}:-2:flags=lanczos`,
        `zoompan=z='min(zoom+0.0012,1.16)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=30`,
        "setsar=1",
      ].join(","),
      "-frames:v", String(frames),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p",
      "clip.mov",
    ]);
    return;
  }

  // audio：模糊封面做底 + 波形。没有封面时用深色纯色背景。
  const wave = `showwaves=s=${w}x${Math.round(h * 0.3)}:mode=cline:draw=full:scale=sqrt:rate=30:colors=0x5eead4[wv]`;
  const graph = opts.hasCover
    ? [
      `[1:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=26,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.5:t=fill[bg]`,
      wave,
      "[bg][wv]overlay=(W-w)/2:(H-h)/2:shortest=1[v]",
    ].join(";")
    : [
      `color=c=0x0b1220:s=${w}x${h}:r=30:d=${duration}[bg]`,
      wave,
      "[bg][wv]overlay=(W-w)/2:(H-h)/2:shortest=1[v]",
    ].join(";");

  await ffmpeg.exec([
    "-hide_banner", "-y",
    "-i", inputName,
    ...(opts.hasCover ? ["-loop", "1", "-i", "cover-src.jpg"] : []),
    "-t", String(duration),
    "-filter_complex", graph,
    "-map", "[v]", "-map", "0:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "25", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-shortest",
    "clip.mov",
  ]);
}

export async function readFileBytes(ffmpeg, name) {
  const data = await ffmpeg.readFile(name);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * @param {{file: File, coverFile?: File|null, duration: number, coverTime: number,
 *          onStage?: (name: string, progress?: number) => void}} opts
 */
export async function generate(opts) {
  const { file, coverFile = null, duration = 3, coverTime = 1.5, onStage = () => {} } = opts;
  const kind = detectKind(file);
  if (!kind) throw new Error("不支持的文件类型");

  onStage("准备编码器", 0);
  const ffmpeg = await loadFFmpeg((p) => onStage("下载编码器", p));
  onStage("准备编码器", 0);

  onStage("读取素材");
  const info = await probe(file, kind);

  onStage("写入文件");
  const inputName = `input.${extOf(file.name) || "bin"}`;
  await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
  if (kind === "audio" && coverFile) {
    await ffmpeg.writeFile("cover-src.jpg", new Uint8Array(await coverFile.arrayBuffer()));
  }

  const size = targetSize(info.width, info.height);

  onStage("转码", 0);
  progressHandler = (p) => onStage("转码", p);
  await makeClip(ffmpeg, kind, size, { coverTime, duration, hasCover: Boolean(coverFile) }, inputName);
  progressHandler = null;

  onStage("生成封面");
  const cover = await makeCover({
    kind, file, coverFile, coverTime, width: size.w, height: size.h,
  });

  onStage("写入实况元数据");
  const clip = await readFileBytes(ffmpeg, "clip.mov");
  const template = await loadTemplate();
  const uuid = randomUUID();

  const mov = injectLivePhoto(clip, template, uuid);
  const jpg = jpegWithUUID(cover, uuid);
  const motion = buildMotionPhoto(cover, mov, Math.round(STILL_TIME * 1e6));

  onStage("打包");
  const livp = makeZip([
    { name: "IMG_0001.JPG", data: jpg },
    { name: "IMG_0001.MOV", data: mov },
  ]);
  const bundle = makeZip([
    { name: "ios/IMG_0001.livp", data: livp },
    { name: "android/IMG_0001.MP.jpg", data: motion },
    { name: "README.txt", data: new TextEncoder().encode(readmeText(kind)) },
  ]);

  for (const name of ["clip.mov", inputName, "cover-src.jpg"]) {
    await ffmpeg.deleteFile(name).catch(() => {});
  }

  return {
    kind, uuid, info, duration, coverTime,
    cover, mov, jpg, motion, livp, bundle,
  };
}

function readmeText(kind) {
  return `Live Photo Studio 导出说明
==========================

iPhone / iPad：
  1. 下载 ios/IMG_0001.livp
  2. AirDrop 到手机，或在「文件」App 中打开
  3. 导入到「照片」，长按应能播放
  4. 微信发朋友圈时从相册选择这张照片

Android：
  1. 下载 android/IMG_0001.MP.jpg
  2. 保存到相册目录（DCIM/Pictures）
  3. 在系统相册中长按查看动态效果

注意：iOS 与 Android 是两套互不兼容的容器，一个文件无法同时被两端识别。
源类型：${kind}
`;
}
