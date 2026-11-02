// 在浏览器里完成「给任意 MOV/MP4 装上实况照片元数据」的全部工作。
//
// 两处改造用的是两份从真实 Live Photo 里取出的二进制模板：
//   1. still-image-time 轨（trak）：整块搬过来，只改 stco / tkhd / elst
//   2. meta 盒（keys + ilst）：UUID 是等长 36 字符，直接覆盖
// 这样既不依赖 MP4Box，也不依赖 ExifTool。

import {
  readBoxes, findBox, findDeep, u32, putU32, putU64, concat, ascii, view,
} from "./box.js";

// meta(hdlr mdta + keys com.apple.quicktime.content.identifier + ilst UUID)
const META_B64 =
  "AAAAqm1ldGEAAAAgaGRscgAAAAAAAAAAbWR0YQAAAAAAAAAAAAAAAAAAAD5rZXlzAAAAAAAAAAEAAAAubWR0YWNvbS5hcHBsZS5xdWlja3RpbWUuY29udGVudC5pZGVudGlmaWVyAAAARGlsc3QAAAA8AAAAAQAAADRkYXRhAAAAAQAAAABENzlFM0JEMC1CNUM2LTQzNzEtQUIzRC0yQzVBN0UyNzRGNzE=";

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function metaBox(uuid) {
  const box = fromBase64(META_B64);
  box.set(ascii(uuid, 36), box.length - 36);
  return box;
}

/**
 * 给 base（ffmpeg 输出的 MOV，moov 在文件尾部）注入：
 *   - still-image-time 元数据轨（封面时间 0.5s）
 *   - com.apple.quicktime.content.identifier = uuid
 * 返回新的 Uint8Array，原始音视频轨一个字节都不动。
 */
export function injectLivePhoto(base, template, uuid) {
  if (uuid.length !== 36) throw new Error("UUID 长度必须是 36");

  const moov = findBox(base, "moov");
  if (!moov) throw new Error("不是有效的 MP4/MOV：找不到 moov");

  const top = readBoxes(base, 0, base.length);
  const last = top[top.length - 1];
  if (last.type !== "moov") {
    throw new Error(`moov 必须在文件尾部（当前最后一个 box 是 ${last.type}）`);
  }

  const tplMoov = findBox(template, "moov");
  if (!tplMoov) throw new Error("元数据模板损坏");
  const tplTraks = readBoxes(template, tplMoov.dataOffset, tplMoov.offset + tplMoov.size)
    .filter((b) => b.type === "trak");
  if (tplTraks.length < 2) throw new Error("元数据模板缺少 still-image-time 轨");

  const src = tplTraks[1];
  const trak = template.slice(src.offset, src.offset + src.size);

  const stco = findDeep(trak, "stco", 8, trak.length);
  const stsz = findDeep(trak, "stsz", 8, trak.length);
  if (!stco || !stsz) throw new Error("模板的样本表缺失");
  if (u32(trak, stco.offset + 12) !== 1) throw new Error("模板 stco 块数量异常");

  const sampleAbs = u32(trak, stco.offset + 16);
  const sampleLen = u32(trak, stsz.offset + 12);
  if (!sampleLen) throw new Error("模板样本长度为 0");
  const payload = template.slice(sampleAbs, sampleAbs + sampleLen);

  const mvhd = findBox(base, "mvhd", moov.dataOffset, moov.offset + moov.size);
  const mvhdVer = base[mvhd.dataOffset];
  const mvhdTs = mvhdVer === 0 ? u32(base, mvhd.offset + 20) : u32(base, mvhd.offset + 28);
  const nextIdOffset = mvhdVer === 0 ? 104 : 116;
  const nextId = u32(base, mvhd.offset + nextIdOffset);

  const tplMvhd = findBox(template, "mvhd", tplMoov.dataOffset, tplMoov.offset + tplMoov.size);
  const tplMvhdTs = u32(template, tplMvhd.offset + 20);

  // ---- 先算新 moov 大小，才能确定样本在新文件里的绝对偏移 ----
  const meta = metaBox(uuid);
  const children = readBoxes(base, moov.dataOffset, moov.offset + moov.size)
    .filter((b) => b.type !== "meta" && b.type !== "udta");
  const keptSize = children.reduce((n, b) => n + b.size, 0);
  const newMoovSize = moov.header + keptSize + trak.length + meta.length;
  const tailSize = base.length - (moov.offset + moov.size);
  const mdatOffset = moov.offset + newMoovSize + tailSize;
  const sampleOffset = mdatOffset + 8;

  // ---- 改样本偏移 ----
  putU32(trak, stco.offset + 16, sampleOffset);

  // ---- 改 track_id / duration（换算到基片的 mvhd timescale）----
  const tkhd = findDeep(trak, "tkhd", 8, trak.length);
  const tver = trak[tkhd.offset + 8];
  const tplDur = tver === 0
    ? u32(trak, tkhd.offset + 28)
    : Number(view(trak).getBigUint64(tkhd.offset + 40));
  const newDur = Math.round((tplDur / tplMvhdTs) * mvhdTs);
  if (tver === 0) {
    putU32(trak, tkhd.offset + 20, nextId);
    putU32(trak, tkhd.offset + 28, newDur);
  } else {
    putU32(trak, tkhd.offset + 28, nextId);
    putU64(trak, tkhd.offset + 40, newDur);
  }

  // ---- elst 的 segment_duration 用的是 movie timescale，同样要换算 ----
  const elst = findDeep(trak, "elst", 8, trak.length);
  if (elst) {
    const ever = trak[elst.offset + 8];
    const count = u32(trak, elst.offset + 12);
    let p = elst.offset + 16;
    for (let i = 0; i < count; i += 1) {
      if (ever === 0) {
        putU32(trak, p, Math.round((u32(trak, p) / tplMvhdTs) * mvhdTs));
        p += 12;
      } else {
        const sd = Number(view(trak).getBigUint64(p));
        putU64(trak, p, Math.round((sd / tplMvhdTs) * mvhdTs));
        p += 20;
      }
    }
  }

  // ---- 重建 moov：原有子盒（去掉 meta/udta）+ 新 trak + 新 meta ----
  const newMoov = new Uint8Array(newMoovSize);
  newMoov.set(base.subarray(moov.offset, moov.offset + moov.header), 0);
  putU32(newMoov, 0, newMoovSize);

  let at = moov.header;
  for (const b of children) {
    newMoov.set(base.subarray(b.offset, b.offset + b.size), at);
    if (b.type === "mvhd") putU32(newMoov, at + nextIdOffset, nextId + 1);
    at += b.size;
  }
  newMoov.set(trak, at);
  at += trak.length;
  newMoov.set(meta, at);

  const mdatHeader = new Uint8Array(8);
  new DataView(mdatHeader.buffer).setUint32(0, 8 + payload.length);
  mdatHeader.set(ascii("mdat", 4), 4);

  return concat([
    base.subarray(0, moov.offset),
    newMoov,
    base.subarray(moov.offset + moov.size),
    mdatHeader,
    payload,
  ]);
}

/** 生成 Apple 用的大写 UUID */
export function randomUUID() {
  if (crypto.randomUUID) return crypto.randomUUID().toUpperCase();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase();
}
