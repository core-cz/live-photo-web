// Android Motion Photo（单文件动态照片）。
//
// 结构以「剪映 21.8.0 的 live_photo_export 产物」为唯一基准，逐字节对齐：
//
//   SOI
//   APP1  Exif    极简 IFD0（宽/高/Orientation），**没有 Make / Model**
//   APP1  XMP     GCamera + OpCamera(OLivePhotoVersion=2) + Container
//   APP0  JFIF    （沿用原图）
//   APP2  ICC     （沿用原图）
//   APP2  MPF     NumberOfImages = 1，只有 Primary 一条
//   ...图像数据... EOI
//   MP4           紧贴 EOI，无填充、无第二张图
//
// 三个曾经踩过的坑：
// 1. 不要伪造 GainMap。真实剪映产物里 MPF 只有一条 Primary，
//    「NumberOfImages=2 + 主图副本 + 16B 填充」会让播放器把副本当成第二张图，
//    结果就是「识别成实况、开关自动打开、但一点就播不出来」。
// 2. 视频必须紧贴主图 EOI。播放器定位视频有两种算法：
//    EOF − Item:Length，或「扫到主图 EOI 之后」。中间多塞任何字节都会让后者读到垃圾。
// 3. 不要写 Make/Model。写 "Apple" 会进 iOS 配对分支；写 "Google"/"Pixel"
//    会让微信把它当 Pixel Motion Photo，实况开关默认打开。真实剪映产物这两个字段是空的。

import {
  concat, insertAppAfterExif, insertApp2, jpegForAndroid, lastAppAnyEnd,
  oplusMetaJson, oplusVideoId,
} from "./exif.js";
import { CONTAINERS, fourcc, readBoxes, u32 } from "./box.js";

const enc = new TextEncoder();
const XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0";

// OPPO/ColorOS 私有命名空间。MotionPhotoOwner 沿用剪映写入的 "VESDK"，
// 这是真机验证过能被 ColorOS 相册与微信同时接受的值。
const XMP = (tsUs, videoLen) => `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.1.0-jc003">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"
        xmlns:OpCamera="http://ns.oplus.com/photos/1.0/camera/"
        xmlns:Container="http://ns.google.com/photos/1.0/container/"
        xmlns:Item="http://ns.google.com/photos/1.0/container/item/"
      GCamera:MotionPhoto="1"
      GCamera:MotionPhotoVersion="1"
      GCamera:MotionPhotoPresentationTimestampUs="${tsUs}"
      OpCamera:MotionPhotoPrimaryPresentationTimestampUs="${tsUs}"
      OpCamera:MotionPhotoOwner="VESDK"
      OpCamera:OLivePhotoVersion="2"
      OpCamera:VideoLength="${videoLen}">
      <Container:Directory>
        <rdf:Seq>
          <rdf:li rdf:parseType="Resource">
            <Container:Item
              Item:Mime="image/jpeg"
              Item:Semantic="Primary"/>
          </rdf:li>
          <rdf:li rdf:parseType="Resource">
            <Container:Item
              Item:Mime="video/mp4"
              Item:Semantic="MotionPhoto"
              Item:Length="${videoLen}"/>
          </rdf:li>
        </rdf:Seq>
      </Container:Directory>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;

const u32b = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

/** MP Entry: 属性(4) + 尺寸(4) + 偏移(4) + 依赖1(2) + 依赖2(2) */
function mpfEntry(attrs, size, offset) {
  return Uint8Array.from([...u32b(attrs), ...u32b(size), ...u32b(offset), 0, 0, 0, 0]);
}

/**
 * 单条目 MPF，整段（含 "MPF\0"）固定 70 字节，加上 FFE2 头正好 74，
 * 与剪映产物 `FF E2 00 48` 完全一致。
 */
export function buildMpf(primarySize) {
  const header = Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a, ...u32b(8)]);
  const n = 3;
  const ifdLen = 2 + n * 12 + 4;
  const dataOff = 8 + ifdLen; // 50

  const ifd = [];
  ifd.push(0, n);
  ifd.push(0xb0, 0x00, 0, 7, ...u32b(4), 0x30, 0x31, 0x30, 0x30);      // "0100"
  ifd.push(0xb0, 0x01, 0, 4, ...u32b(1), ...u32b(1));                   // NumberOfImages = 1
  ifd.push(0xb0, 0x02, 0, 7, ...u32b(16), ...u32b(dataOff));            // MPEntry
  ifd.push(...u32b(0));                                                 // next IFD

  const data = mpfEntry(0x00030000, primarySize, 0);

  return concat([enc.encode("MPF\0"), header, Uint8Array.from(ifd), data]);
}

// ---------------------------------------------------------------- ftyp

function walkBoxes(u8, start, end, visit) {
  for (const b of readBoxes(u8, start, end)) {
    visit(b);
    if (CONTAINERS.has(b.type)) walkBoxes(u8, b.dataOffset, b.offset + b.size, visit);
  }
}

function sampleEntryTag(mp4) {
  let tag = "avc1";
  walkBoxes(mp4, 0, mp4.length, (b) => {
    if (b.type === "stsd") {
      // stsd 是 FullBox：version/flags(4) + entry_count(4)，之后才是第一个 sample entry。
      // 而 sample entry 自己也是「size(4) + format(4)」，所以 fourcc 在 +12 而不是 +8。
      // 这里曾经读错一个字段，导致 HEVC 视频也被标成 avc1 brand。
      const four = fourcc(mp4, b.dataOffset + 12);
      if (["avc1", "avc3", "hvc1", "hev1", "vp09", "av01"].includes(four)) tag = four;
    }
  });
  return tag;
}

/**
 * 把 ftyp 重建成 32 字节的标准 Android 版式：
 *   major = isom, minor = 512, compatible = isom / iso2 / <codec> / mp41
 * 与剪映产物一致（它写的是 isom+iso2+hvc1+mp41，我们只是把 hvc1 换成实际用的 avc1）。
 *
 * ffmpeg 默认写的是 `qt  ` 单 brand 头，部分国内相册与微信的探测逻辑会因此
 * 认成 QuickTime 而不是 mp4，直接跳过动图分支。所以必须重建。
 *
 * 重建会让后面所有 box 整体后移，stco/co64 里的 chunk 偏移要同步加 delta。
 */
export function canonicalFtyp(mp4) {
  if (mp4.length < 16 || fourcc(mp4, 4) !== "ftyp") return mp4;
  const size = u32(mp4, 0);
  if (size < 16 || size > mp4.length) return mp4;

  // 已经是标准版式就一个字节都别动。
  // 源文件（比如剪映导出的实况照片）在 ftyp 后面还有一个 8 字节 free 盒，
  // 重写 ftyp 会把 free 吃掉、整体前移 8 字节并改写 stco——
  // 结构上没错，但和原片不再逐字节一致，微信对这类改动很挑。
  if (size === 32 && fourcc(mp4, 8) === "isom") {
    const compat = [fourcc(mp4, 16), fourcc(mp4, 20), fourcc(mp4, 24), fourcc(mp4, 28)];
    if (compat.includes("isom") && (compat.includes("mp41") || compat.includes("mp42"))) {
      return mp4;
    }
  }

  // 紧跟 ftyp 的 8 字节空盒（wide / free）可以直接吃掉
  let consume = 0;
  if (size + 8 <= mp4.length && u32(mp4, size) === 8) {
    const t = fourcc(mp4, size + 4);
    if (t === "wide" || t === "free") consume = 8;
  }

  const WANT = 32;
  if (size === WANT && !consume) {
    // 尺寸正好，只改内容
    const out = mp4.slice();
    writeFtyp(out, WANT, sampleEntryTag(mp4));
    return out;
  }
  if (size > WANT) return mp4;                 // 异常，别动

  const avail = size + consume;
  const delta = WANT - avail;
  const out = new Uint8Array(mp4.length + delta);
  writeFtyp(out, WANT, sampleEntryTag(mp4));
  out.set(mp4.subarray(avail), WANT);

  if (delta !== 0) shiftChunks(out, WANT, delta);
  return out;
}

function writeFtyp(buf, size, codec) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint32(0, size);
  buf[4] = 0x66; buf[5] = 0x74; buf[6] = 0x79; buf[7] = 0x70;  // 'ftyp'
  dv.setUint32(8, 0x69736f6d);                                  // major 'isom'
  dv.setUint32(12, 0x00000200);                                 // minor 512
  const brands = ["isom", "iso2", codec, "mp41"];
  let p = 16;
  for (const b of brands) {
    if (p + 4 > size) break;
    dv.setUint32(p, (b.charCodeAt(0) << 24) | (b.charCodeAt(1) << 16)
      | (b.charCodeAt(2) << 8) | b.charCodeAt(3));
    p += 4;
  }
}

/** 把 out 里（从 from 起）的所有 stco/co64 条目 +delta，源数据在 src[srcFrom..] */
function shiftChunks(out, from, delta) {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  walkBoxes(out, from, out.length, (b) => {
    if (b.type !== "stco" && b.type !== "co64") return;
    const n = dv.getUint32(b.dataOffset + 4);
    if (b.dataOffset + 8 + n * (b.type === "stco" ? 4 : 8) > b.offset + b.size) return;
    for (let i = 0; i < n; i += 1) {
      const at = b.dataOffset + 8 + i * (b.type === "stco" ? 4 : 8);
      if (b.type === "stco") dv.setUint32(at, dv.getUint32(at) + delta);
      else dv.setBigUint64(at, dv.getBigUint64(at) + BigInt(delta));
    }
  });
}

// ---------------------------------------------------------------- moov/udta

/**
 * 剪映产物的 moov 尾部有一段 `udta → meta(mdta) → keys + ilst`，七个私有键：
 *
 *   DreaminaMetaInfo = {}          Hw = "1"           LvMetaInfo = {UserComment 同款 JSON}
 *   bitrate = "6000000"            maxrate = "30000000"
 *   te_is_reencode = "1"           encoder = "Lavf57.71.100"
 *
 * 这段东西是 ffmpeg 重封装时第一个被丢掉的部分，也正好是「ColorOS 相册认、
 * 微博认、微信不认」分叉的地方：微信走的是 OPPO 原厂解析器，它要求 moov 里
 * 带着这份原厂自述。缺了不是降级，是直接判成「格式不全」。
 */
const UDTA_KEYS = [
  "DreaminaMetaInfo", "Hw", "LvMetaInfo", "bitrate",
  "maxrate", "te_is_reencode", "encoder",
];

function w32(b, o, v) {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

function mkBox(type, ...parts) {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  w32(out, 0, out.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

/** hdlr 33 字节：ver/flags(4) + pre_defined(4) + 'mdta'(4) + reserved(12) + name(1) */
function mdtaHdlr() {
  const body = new Uint8Array(25);
  body.set(enc.encode("mdta"), 8);
  return mkBox("hdlr", body);
}

function keysBox(names) {
  const parts = [];
  for (const n of names) {
    const raw = enc.encode(n);
    const b = new Uint8Array(8 + raw.length);
    w32(b, 0, b.length);
    b.set(enc.encode("mdta"), 4);
    b.set(raw, 8);
    parts.push(b);
  }
  const head = new Uint8Array(8);
  w32(head, 4, names.length);
  return mkBox("keys", head, ...parts);
}

/** ilst 单条：size + index(4) + [size + 'data' + type(4,=1 UTF-8) + locale(4) + utf8] */
function ilstEntry(index, text) {
  const val = enc.encode(text);
  const data = new Uint8Array(16 + val.length);
  w32(data, 0, data.length);
  data.set(enc.encode("data"), 4);
  w32(data, 8, 1);
  w32(data, 12, 0);
  data.set(val, 16);

  const out = new Uint8Array(8 + data.length);
  w32(out, 0, out.length);
  w32(out, 4, index);
  out.set(data, 8);
  return out;
}

function buildMeta({ metaJson }) {
  const values = [
    "{}",                                  // DreaminaMetaInfo
    "1",                                   // Hw
    metaJson,                              // LvMetaInfo
    "6000000",                             // bitrate
    "30000000",                            // maxrate
    "1",                                   // te_is_reencode
    "Lavf59.37.100",                       // encoder
  ];
  const ilst = mkBox("ilst", ...values.map((v, i) => ilstEntry(i + 1, v)));
  return mkBox("meta", new Uint8Array(4), mdtaHdlr(), keysBox(UDTA_KEYS), ilst);
}

/**
 * 在 moov 里补 udta/meta。
 *
 * 注意不能只判断「有没有 udta」：ffmpeg 自己会写一个 33 字节的空 udta（只含
 * `©swr Lavf59.27.100`），直接跳过就等于什么都没做 —— 这正是上一版微信掉图标
 * 的原因。正确做法是把原 udta 里的其他子盒保留下来，再把 meta 拼进去。
 *
 * moov 在 mdat 之后是最常见布局，此时改动不影响任何 chunk 偏移；
 * 万一 moov 在前（faststart），后面整体后移，必须同步修 stco/co64。
 */
export function injectUdta(mp4, opts = {}) {
  const boxes = readBoxes(mp4, 0, mp4.length);
  const moov = boxes.find((b) => b.type === "moov");
  if (!moov) return mp4;

  const kids = readBoxes(mp4, moov.dataOffset, moov.offset + moov.size);
  const existing = kids.find((b) => b.type === "udta");

  let keep = [];
  if (existing) {
    const inner = readBoxes(mp4, existing.dataOffset, existing.offset + existing.size);
    // ffmpeg 6.x 会写一个 handler 为 `mdirappl` 的 iTunes meta（含 ©too），那不是我们的。
    // 只有 handler == mdta 才是已经注入过的剪映式元数据，可以原样放过。
    const ours = inner.some((b) => b.type === "meta" && fourcc(mp4, b.offset + 28) === "mdta");
    if (ours) return mp4;
    keep = inner.filter((b) => b.type !== "meta")
      .map((b) => mp4.subarray(b.offset, b.offset + b.size));
  }

  const udta = mkBox("udta", ...keep, buildMeta(opts));
  const insertAt = existing ? existing.offset : moov.offset + moov.size;
  const removeLen = existing ? existing.size : 0;

  const moovBody = concat([
    mp4.subarray(moov.dataOffset, insertAt),
    udta,
    mp4.subarray(insertAt + removeLen, moov.offset + moov.size),
  ]);
  const newMoov = new Uint8Array(8 + moovBody.length);
  w32(newMoov, 0, newMoov.length);
  for (let i = 0; i < 4; i += 1) newMoov[4 + i] = "moov".charCodeAt(i);
  newMoov.set(moovBody, 8);

  const out = concat([
    mp4.subarray(0, moov.offset),
    newMoov,
    mp4.subarray(moov.offset + moov.size),
  ]);

  const delta = newMoov.length - moov.size;
  if (delta !== 0 && boxes.some((b) => b.type === "mdat" && b.offset > moov.offset)) {
    // stco/co64 存的是绝对文件偏移。moov 在 mdat 之前（faststart）时，
    // 插入 udta 会把后面的 mdat 整体后移，必须从新 moov 内部开始修。
    shiftChunks(out, moov.offset, delta);
  }
  return out;
}

/**
 * @param {Uint8Array} jpeg  封面图（会被替换 EXIF，去 Apple 化、去 Make/Model）
 * @param {Uint8Array} video MP4
 * @param {number} tsUs      封面时间戳（微秒），剪映固定写 1500000
 */
export function buildMotionPhoto(jpeg, video, tsUs = 1500000) {
  const videoId = oplusVideoId();
  const metaJson = oplusMetaJson(videoId);

  // 0. 视频容器补 udta/meta —— 剪映产物 moov 尾部有一段 1265 字节私有元数据，
  //    重封装（ffmpeg 一定丢）之后微信就认不出来。这里按原样写回去。
  let v = injectUdta(video, { metaJson });

  v = canonicalFtyp(v);

  // 1. EXIF 极简化：只留 宽/高/Orientation，不带 Make / Model
  let out = jpegForAndroid(jpeg, metaJson);

  // 2. XMP 紧跟 Exif 段（与剪映的段序一致）
  const xmp = enc.encode(XMP_HEADER + XMP(tsUs, v.length));
  out = insertAppAfterExif(out, xmp);

  // 3. MPF 单条目，主图长度含 MPF 自身
  const mpfLen = 4 + 8 + 42 + 16;              // "MPF\0" + TIFF 头 + IFD + 1×MPEntry = 70
  const insertPos = lastAppAnyEnd(out);
  const jpegLen = out.length + 4 + mpfLen;
  const mpf = buildMpf(jpegLen);
  out = insertApp2(out, mpf);

  // 4. 主图 | 视频，中间零字节间隔
  return concat([out, v]);
}
