// 封面 JPEG 的 Apple MakerNote。
// iOS 把配对 UUID 存在 MakerNote 的 0x0011 里；普通 JPEG 没有这段结构，
// 所以这里按 Apple 的二进制布局直接生成最小可用的 MakerNote，作为 APP1 插入。

const enc = new TextEncoder();

function u16(v) {
  return [(v >> 8) & 0xff, v & 0xff];
}

function u32(v) {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function appleMakerNote(uuid) {
  const value = enc.encode(`${uuid}\0`); // 37 字节
  const head = [...enc.encode("Apple iOS\0"), 0x00, 0x01, 0x4d, 0x4d]; // 'MM'
  const ifdOffset = head.length; // 14
  const valueOffset = ifdOffset + 2 + 12 + 4; // 32
  const ifd = [
    ...u16(1),
    ...u16(0x0011), ...u16(2), ...u32(value.length), ...u32(valueOffset),
    ...u32(0),
  ];
  return new Uint8Array([...head, ...ifd, ...value]);
}

function exifWithMakerNote(uuid) {
  const mn = appleMakerNote(uuid);
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]; // 'MM' + 42 + IFD0 @8
  const ifd0Offset = 8;
  const exifIfdOffset = ifd0Offset + 2 + 12 + 4; // 26
  const ifd0 = [...u16(1), ...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifIfdOffset), ...u32(0)];
  const mnOffset = exifIfdOffset + 2 + 12 + 4; // 44
  const exifIfd = [...u16(1), ...u16(0x927c), ...u16(7), ...u32(mn.length), ...u32(mnOffset), ...u32(0)];
  return new Uint8Array([...tiff, ...ifd0, ...exifIfd, ...mn]);
}

function buildApp1(uuid) {
  const body = exifWithMakerNote(uuid);
  const payloadLen = 6 + body.length; // 'Exif\0\0'
  const out = new Uint8Array(2 + 2 + payloadLen);
  out[0] = 0xff;
  out[1] = 0xe1;
  out[2] = (payloadLen + 2) >> 8;
  out[3] = (payloadLen + 2) & 0xff;
  out.set(enc.encode("Exif\0\0"), 4);
  out.set(body, 10);
  return out;
}

/** 去掉已有的 EXIF APP1，避免手机上出现两段互相冲突的 EXIF */
function stripExif(jpeg) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("不是 JPEG");
  const chunks = [jpeg.subarray(0, 2)];
  let pos = 2;
  while (pos + 4 <= jpeg.length) {
    if (jpeg[pos] !== 0xff) break;
    const marker = jpeg[pos + 1];
    const len = (jpeg[pos + 2] << 8) | jpeg[pos + 3];
    const isExif = marker === 0xe1
      && jpeg[pos + 4] === 0x45 && jpeg[pos + 5] === 0x78
      && jpeg[pos + 6] === 0x69 && jpeg[pos + 7] === 0x66;
    if (isExif) {
      pos += 2 + len;
      continue;
    }
    chunks.push(jpeg.subarray(pos));
    break;
  }
  return chunks.length === 1 ? jpeg : new Uint8Array([...chunks[0], ...chunks[1]]);
}

/** 在 SOI 之后插入带 MakerNote 的 APP1 */
export function jpegWithUUID(jpeg, uuid) {
  const clean = stripExif(jpeg);
  const app1 = buildApp1(uuid);
  const out = new Uint8Array(clean.length + app1.length);
  out.set(clean.subarray(0, 2), 0);
  out.set(app1, 2);
  out.set(clean.subarray(2), 2 + app1.length);
  return out;
}
