// EXIF 构造：iOS 与 Android 两份 profile。
//
// iOS    Make="Apple" + Apple MakerNote(tag 0x0011 = UUID)，相册靠 UUID 配对同名 MOV。
// Android **一个 Make/Model 都不写**。这不是省略，是必需：
//         - 写 "Apple" 会让相册走「找同名 MOV」的配对分支，对内嵌视频视而不见；
//         - 写 "Google"/"Pixel" 会让微信把它当成 Pixel Motion Photo，
//           实况开关默认打开，然后去解一段并不存在的 HDR+ 增益图，表现为「播不出来」。
//         剪映 21.8.0 的真实产物里 IFD0 只有 宽 / 高 / Orientation 三项，照抄。
//
// 普通 JPEG 没有 MakerNote，ExifTool 也没法凭空造，所以这里手写整段 TIFF。

const enc = new TextEncoder();

const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

const ASCII = (tag, s) => {
  const raw = [...enc.encode(s), 0];
  return { tag, type: 2, count: raw.length, raw: Uint8Array.from(raw) };
};
const SHORT = (tag, v) => ({ tag, type: 3, count: 1, raw: Uint8Array.from(u16(v)) });
const LONG = (tag, v) => ({ tag, type: 4, count: 1, raw: Uint8Array.from(u32(v)) });
const RATIONAL = (tag, num, den = 1) => ({
  tag, type: 5, count: 1, raw: Uint8Array.from([...u32(num), ...u32(den)]),
});
const SRATIONAL = (tag, num, den = 1) => {
  const s = (v) => [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  return { tag, type: 10, count: 1, raw: Uint8Array.from([...s(num), ...s(den)]) };
};
const BYTES = (tag, arr) => ({ tag, type: 7, count: arr.length, raw: Uint8Array.from(arr) });

function packIfd(entries, start) {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const ifdLen = 2 + sorted.length * 12 + 4;
  let cursor = start + ifdLen;
  const ifd = [];
  const values = [];
  ifd.push(...u16(sorted.length));
  for (const e of sorted) {
    if (e.raw.length <= 4) {
      const pad = new Uint8Array(4);
      pad.set(e.raw);
      ifd.push(...u16(e.tag), ...u16(e.type), ...u32(e.count), ...pad);
    } else {
      ifd.push(...u16(e.tag), ...u16(e.type), ...u32(e.count), ...u32(cursor));
      values.push(...e.raw);
      if (e.raw.length & 1) values.push(0);
      cursor = start + ifdLen + values.length;
    }
  }
  ifd.push(...u32(0));
  return { ifd: Uint8Array.from(ifd), values: Uint8Array.from(values) };
}

// ---------------------------------------------------------------- MakerNote

export function appleMakerNote(uuid) {
  const value = enc.encode(`${uuid}\0`);
  const head = [...enc.encode("Apple iOS\0"), 0x00, 0x01, 0x4d, 0x4d];
  const valueOffset = 14 + 2 + 12 + 4; // 32
  const ifd = [
    ...u16(1),
    ...u16(0x0011), ...u16(2), ...u32(value.length), ...u32(valueOffset),
    ...u32(0),
  ];
  return new Uint8Array([...head, ...ifd, ...value]);
}

// ---------------------------------------------------------------- 两套 EXIF

function nowString() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function offsetString() {
  const m = -new Date().getTimezoneOffset();
  const sign = m >= 0 ? "+" : "-";
  const a = Math.abs(m);
  const p = (n) => String(n).padStart(2, "0");
  return `${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

export function buildAppleExif(w, h, uuid) {
  const dt = nowString();
  const off = offsetString();
  const exifEntries = [
    RATIONAL(0x829a, 1, 120),
    RATIONAL(0x829d, 178, 100),
    SHORT(0x8822, 2),
    SHORT(0x8827, 100),
    BYTES(0x9000, [...enc.encode("0232")]),
    ASCII(0x9003, dt),
    ASCII(0x9004, dt),
    ASCII(0x9010, off),
    ASCII(0x9011, off),
    BYTES(0x9101, [1, 2, 3, 0]),
    SRATIONAL(0x9201, 690, 100),
    RATIONAL(0x9202, 166, 100),
    SRATIONAL(0x9204, 0, 1),
    SHORT(0x9207, 5),
    SHORT(0x9209, 16),
    RATIONAL(0x920a, 693, 100),
    BYTES(0x927c, appleMakerNote(uuid)),     // ← 关键
    BYTES(0xa000, [...enc.encode("0100")]),
    SHORT(0xa001, 1),
    LONG(0xa002, w),
    LONG(0xa003, h),
    SHORT(0xa402, 0),
    SHORT(0xa403, 0),
    SHORT(0xa405, 24),
    SHORT(0xa406, 0),
    ASCII(0xa433, "Apple"),
    ASCII(0xa434, "iPhone 15 Pro back camera 6.765mm f/1.78"),
  ];

  let ifd0Entries = [
    ASCII(0x010f, "Apple"),
    ASCII(0x0110, "iPhone 15 Pro"),
    SHORT(0x0112, 1),
    RATIONAL(0x011a, 72),
    RATIONAL(0x011b, 72),
    SHORT(0x0128, 2),
    ASCII(0x0131, "17.5.1"),
    ASCII(0x0132, dt),
    SHORT(0x0213, 1),
    LONG(0x8769, 0),
  ];

  let p0 = packIfd(ifd0Entries, 8);
  const exifStart = 8 + p0.ifd.length + p0.values.length;
  ifd0Entries = ifd0Entries.map((e) => (e.tag === 0x8769 ? LONG(0x8769, exifStart) : e));
  p0 = packIfd(ifd0Entries, 8);
  const p1 = packIfd(exifEntries, exifStart);

  return new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, ...u32(8),
    ...p0.ifd, ...p0.values, ...p1.ifd, ...p1.values,
  ]);
}

/**
 * Android 版 EXIF：与剪映 21.8.0 产物同构。
 *
 * IFD0 只有 宽 / 高 / ExifIFD 指针 / Orientation —— **没有 Make、没有 Model**。
 * 写 "Apple" 会让相册走「找同名 MOV」的配对分支；写 "Google"/"Pixel" 会让微信
 * 把它当 Pixel Motion Photo，实况开关默认打开却去解一段不存在的增益图。
 * 剪映的真实产物这两个字段就是空的。
 *
 * 但 **ExifIFD 里的 UserComment 不能删**。它是厂商解析器进「原生动态照片」
 * 分支的钥匙：剪映写含 oplustag 的 JSON，ColorOS 写 oplus_11534336，两者都带 oplus 标记。删掉这一个字段，ColorOS 相册与微信就都认不出来了。
 */
// 形状照抄剪映 21.8.0 的完整 payload（appVersion / did / uid / videoId / videoParams…），
// 一个字段都不省。差值实测很敏感：
//   - `source_type` 剪映写的是 "douyin_beauty_me"，不是 "live_photo_export"。
//     写成后者时 ColorOS 相册能认、微信直接掉图标 —— 这个字段是厂商分流键。
//   - `data` 里外各有一份 oplustag，缺一份就会被当成非原厂产物。
//   - videoId 是 UUID 形状，缺了微信的结构校验不过。
const hex4 = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");

export function oplusVideoId() {
  return `${hex4()}${hex4()}-${hex4()}-${hex4()}-${hex4()}-${hex4()}${hex4()}${hex4()}`;
}

/**
 * 剪映写进 UserComment 与 udta:LvMetaInfo 的是同一段 JSON。
 * 两处必须完全一致，否则微信会认为容器与 EXIF 描述不符。
 */
export function oplusMetaJson(videoId = oplusVideoId()) {
  return JSON.stringify({
    data: {
      appVersion: "21.8.0",
      capabilityName: "live_photo_export",
      did: "iqpwrewueeoqtqro",
      editSource: "",
      editType: "edit",
      effect_id: "live_photo_export",
      effect_type: "tool",
      enterFrom: "",
      exportType: "export",
      extendTemplateId: "",
      extendTemplateType: 0,
      firstLaunchMethod: "enter_launch",
      global_data_for_metadata_write: "",
      infoStickerId: "",
      is_ai_template_recreation: 0,
      launchMode: "launch",
      lock_cnt_list: "",
      movie3dTextTemplateId: "",
      oplustag: 8388608,
      os: "android",
      product: "lv",
      room_id: "",
      slowMotion: "none",
      stickerId: "",
      templateId: "",
      theme_params: "",
      transferMethod: "",
      uid: "uwiewtyewqwyiiqi",
      videoEffectId: "",
      videoId,
      videoParams: {
        st: 0, ef: 0, be: 0, tx: 0, mu: 0, ft: 0, te: 0, re: 0,
        ma: 0, v: 0, me: 0, vs: 0, sp: 0,
      },
    },
    has_cover: "0",
    oplustag: 8388608,
    source_type: "douyin_beauty_me",
  });
}

export function buildAndroidExif(w, h, metaJson = oplusMetaJson()) {
  const exifEntries = [
    SHORT(0x9208, 0),                                              // LightSource
    BYTES(0x9286, [...enc.encode("ASCII\0\0\0"), ...enc.encode(metaJson)]),
  ];

  let ifd0Entries = [
    LONG(0x0100, w),        // ImageWidth
    LONG(0x0101, h),        // ImageLength
    LONG(0x8769, 0),        // ExifIFD 指针，回填
    SHORT(0x0112, 1),       // Orientation
  ];

  let p0 = packIfd(ifd0Entries, 8);
  const exifStart = 8 + p0.ifd.length + p0.values.length;
  ifd0Entries = ifd0Entries.map((e) => (e.tag === 0x8769 ? LONG(0x8769, exifStart) : e));
  p0 = packIfd(ifd0Entries, 8);
  const p1 = packIfd(exifEntries, exifStart);

  return new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, ...u32(8),
    ...p0.ifd, ...p0.values, ...p1.ifd, ...p1.values,
  ]);
}

// ---------------------------------------------------------------- JPEG 段操作

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function jpegSize(jpeg) {
  let pos = 2;
  while (pos + 9 <= jpeg.length) {
    if (jpeg[pos] !== 0xff) break;
    const marker = jpeg[pos + 1];
    if (SOF.has(marker)) {
      return [(jpeg[pos + 7] << 8) | jpeg[pos + 8], (jpeg[pos + 5] << 8) | jpeg[pos + 6]];
    }
    if (marker === 0xda) break;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
    pos += 2 + ((jpeg[pos + 2] << 8) | jpeg[pos + 3]);
  }
  throw new Error("读不出 JPEG 尺寸");
}

/** 逐段遍历到 SOS 为止。绝不全文搜 FFD9 —— 缩略图里全是假 EOI。 */
export function segments(jpeg) {
  const out = [];
  let pos = 2;
  while (pos + 4 <= jpeg.length) {
    if (jpeg[pos] !== 0xff) break;
    const marker = jpeg[pos + 1];
    if (marker === 0xda) break;
    if (marker === 0xd8 || marker === 0xd9
        || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2;
      continue;
    }
    const len = (jpeg[pos + 2] << 8) | jpeg[pos + 3];
    out.push({ marker, start: pos, total: 2 + len });
    pos += 2 + len;
  }
  return out;
}

export function lastAppEnd(jpeg) {
  let end = 2;
  for (const s of segments(jpeg)) {
    if (s.marker === 0xe1 || s.marker === 0xe2) end = s.start + s.total;
  }
  return end;
}

/** 最后一个 APPn（含 JFIF 的 APP0 与 ICC 的 APP2）之后的位置。 */
export function lastAppAnyEnd(jpeg) {
  let end = 2;
  for (const s of segments(jpeg)) {
    if (s.marker >= 0xe0 && s.marker <= 0xef) end = s.start + s.total;
  }
  return end;
}

function isExifApp1(jpeg, s) {
  return s.marker === 0xe1
    && jpeg[s.start + 4] === 0x45 && jpeg[s.start + 5] === 0x78
    && jpeg[s.start + 6] === 0x69 && jpeg[s.start + 7] === 0x66;
}

function isXmpApp1(jpeg, s) {
  if (s.marker !== 0xe1) return false;
  const head = String.fromCharCode(...jpeg.subarray(s.start + 4, s.start + 9));
  return head === "http:" || head.startsWith("<?xpa");
}

function isMpfApp2(jpeg, s) {
  return s.marker === 0xe2
    && jpeg[s.start + 4] === 0x4d && jpeg[s.start + 5] === 0x50
    && jpeg[s.start + 6] === 0x46 && jpeg[s.start + 7] === 0x00;
}

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** 剥掉旧 EXIF / XMP / MPF / COM。 */
function stripMeta(jpeg) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("不是 JPEG");
  const keep = [jpeg.subarray(0, 2)];
  let pos = 2;
  for (const s of segments(jpeg)) {
    const drop = isExifApp1(jpeg, s) || isXmpApp1(jpeg, s)
      || isMpfApp2(jpeg, s) || s.marker === 0xfe;
    if (!drop) keep.push(jpeg.subarray(s.start, s.start + s.total));
    pos = s.start + s.total;
  }
  keep.push(jpeg.subarray(findSos(jpeg, pos)));
  return concat(keep);
}

function findSos(jpeg, from) {
  for (let i = from; i + 1 < jpeg.length; i += 1) {
    if (jpeg[i] === 0xff && jpeg[i + 1] === 0xda) return i;
  }
  return from;
}

function appSegment(markerByte, body) {
  const head = new Uint8Array(4);
  head[0] = 0xff;
  head[1] = markerByte;
  const len = body.length + 2;
  head[2] = (len >> 8) & 0xff;
  head[3] = len & 0xff;
  return concat([head, body]);
}

/** 整段替换 EXIF：清掉旧 EXIF/XMP/MPF/COM，把新 EXIF 插到 SOI 之后。 */
function withExif(jpeg, tiff) {
  const payload = concat([enc.encode("Exif\0\0"), tiff]);
  if (payload.length + 2 > 0xffff) throw new Error("EXIF 过大");
  const app1 = appSegment(0xe1, payload);
  const clean = stripMeta(jpeg);
  return concat([clean.subarray(0, 2), app1, clean.subarray(2)]);
}

export function jpegForIos(jpeg, uuid) {
  const [w, h] = jpegSize(jpeg);
  return withExif(jpeg, buildAppleExif(w, h, uuid));
}

export function jpegForAndroid(jpeg, metaJson) {
  const [w, h] = jpegSize(jpeg);
  return withExif(jpeg, buildAndroidExif(w, h, metaJson));
}

/** XMP 作为 APP1 紧跟 Exif 段（剪映的段序就是 Exif → XMP → JFIF → ICC → MPF）。 */
export function insertAppAfterExif(jpeg, payload) {
  const seg = appSegment(0xe1, payload);
  let pos = 2;
  for (const s of segments(jpeg)) {
    if (isExifApp1(jpeg, s)) { pos = s.start + s.total; break; }
    pos = s.start + s.total;
    if (s.marker !== 0xe1) break;
  }
  return concat([jpeg.subarray(0, pos), seg, jpeg.subarray(pos)]);
}

/** XMP 作为 APP1 插在最后一个 APP1/APP2 之后。 */
export function insertApp1(jpeg, payload) {
  const seg = appSegment(0xe1, payload);
  const pos = lastAppEnd(jpeg);
  return concat([jpeg.subarray(0, pos), seg, jpeg.subarray(pos)]);
}

/** MPF 作为 APP2 紧跟最后一段。 */
export function insertApp2(jpeg, payload) {
  const seg = appSegment(0xe2, payload);
  const pos = lastAppAnyEnd(jpeg);
  return concat([jpeg.subarray(0, pos), seg, jpeg.subarray(pos)]);
}
