// 从「已有的实况照片 / Motion Photo」里把内嵌视频原样取出来。
//
// 这是整条流水线里最容易踩的坑：JPEG 的 MIME 和扩展名都只是 image/jpeg，
// 但文件尾其实还挂着一段完整 MP4（带 AAC）。如果只按扩展名判断类型，
// 就会把一段有声音、有运镜的视频当成一张静态图，重新做 3 秒推镜，
// 结果就是「能认出来是实况，但没声音、只有几秒」。

/** 解析 JPEG 段，返回 EOI 的偏移；不是合法 JPEG 时返回 -1。 */
function findEoi(u8) {
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return -1;
  let i = 2;
  while (i < u8.length - 1) {
    if (u8[i] !== 0xff) return -1;
    const m = u8[i + 1];
    if (m === 0xd9) return i;
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    const len = (u8[i + 2] << 8) | u8[i + 3];
    if (len < 2) return -1;
    if (m === 0xda) {
      // 跳过熵编码数据，直到遇见下一个真正的标记
      let j = i + 2 + len;
      while (j < u8.length - 1) {
        if (u8[j] === 0xff) {
          const n = u8[j + 1];
          if (n !== 0x00 && !(n >= 0xd0 && n <= 0xd7)) break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    i += 2 + len;
  }
  return -1;
}

function readU32(u8, at) {
  return ((u8[at] << 24) | (u8[at + 1] << 16) | (u8[at + 2] << 8) | u8[at + 3]) >>> 0;
}

/**
 * 取出 JPEG 尾部的内嵌视频。
 * @returns {{video: Uint8Array, offset: number}|null}
 */
export function extractMotionVideo(u8) {
  const eoi = findEoi(u8);
  if (eoi < 0) return null;
  let start = eoi + 2;
  if (start + 8 > u8.length) return null;

  // 正常情况视频紧贴 EOI；少数实现会插几字节对齐填充，往后找一小段兜底。
  const limit = Math.min(u8.length - 8, start + 512);
  let found = -1;
  for (let i = start; i <= limit; i += 1) {
    if (u8[i + 4] === 0x66 && u8[i + 5] === 0x74 && u8[i + 6] === 0x79 && u8[i + 7] === 0x70) {
      found = i;
      break;
    }
  }
  if (found < 0) return null;

  const size = readU32(u8, found);
  if (size < 8 || found + size > u8.length) return null;

  const video = u8.subarray(found);
  // 兜底：至少得像个 MP4，别把随机字节当视频喂给 ffmpeg
  if (!hasBox(video, "moov") && !hasBox(video, "moof")) return null;
  if (video.length < 1024) return null;
  return { video, offset: found };
}

function hasBox(u8, type) {
  const pat = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
  for (let i = 0; i < u8.length - 4; i += 1) {
    if (u8[i] === pat[0] && u8[i + 1] === pat[1] && u8[i + 2] === pat[2] && u8[i + 3] === pat[3]) return true;
  }
  return false;
}

/**
 * 判断 MP4 里有没有音轨。
 *
 * 没有音轨是「实况照片能识别、但点开没声/播放异常」的常见原因：剪映导出的每一条
 * 实况都带 AAC，播放器（尤其微信的）按有声媒体的路径初始化音频输出，遇到纯视频
 * 容器容易直接放弃。所以纯静音的素材我们补一条 anullsrc。
 *
 * 找不到 moov/hdlr 的情况（webm / mkv）一律当作有音轨，不额外补。
 */
export function hasAudioTrack(u8) {
  if (!u8 || u8.length < 32) return true;
  const isMp4 = u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70;
  if (!isMp4) return true;

  // 依次找 hdlr，看 handler_type 是否为 'soun'
  const soun = [0x73, 0x6f, 0x75, 0x6e];
  for (let i = 0; i < u8.length - 12; i += 1) {
    if (u8[i] === 0x68 && u8[i + 1] === 0x64 && u8[i + 2] === 0x6c && u8[i + 3] === 0x72) {
      // hdlr: size(4) type(4) version+flags(4) pre_defined(4) handler_type(4)
      const h = i + 12;
      if (u8[h] === soun[0] && u8[h + 1] === soun[1] && u8[h + 2] === soun[2] && u8[h + 3] === soun[3]) {
        return true;
      }
    }
  }
  return false;
}

/** 粗略识别 HEIC/HEIF：浏览器 <img> 大多解不了，需要给出明确提示。 */
export function isHeic(u8) {
  if (u8.length < 12) return false;
  const brand = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
  if (brand !== "ftyp") return false;
  const b = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
  return ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(b);
}

/**
 * 读出源实况照片写在 XMP 里的「定格帧时间戳」。
 *
 * 这个值很关键：复用别人的视频时，封面静图对应的是**视频里的第几秒**，
 * 全靠它。剪映写 1500000（1.5s），我们如果一律按 0.5s 写，
 * 播放器就会从错误的位置起播，看起来像「格式不对」。
 */
export function readMotionTimestamp(u8) {
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return null;
  // XMP 是明文，直接在 APP1 里找
  const head = u8.subarray(0, Math.min(u8.length, 65536));
  const text = String.fromCharCode.apply(null, head);
  const m = /MotionPhotoPresentationTimestampUs\s*=\s*"(\d+)"/.exec(text)
    || /MotionPhotoPresentationTimestampUs>(\d+)</.exec(text);
  if (!m) return null;
  const us = Number(m[1]);
  return Number.isFinite(us) && us >= 0 ? us : null;
}
