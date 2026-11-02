// MP4 / QuickTime 的 box 解析与读写工具。
// 只做我们真正需要的事：遍历、查找、原地改字段。

export const CONTAINERS = new Set([
  "moov", "trak", "mdia", "minf", "stbl", "dinf", "edts", "udta",
]);

export function view(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

export function fourcc(u8, off) {
  return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
}

/** 解析 [start, end) 区间内的同级 box 列表 */
export function readBoxes(u8, start = 0, end = u8.length) {
  const dv = view(u8);
  const list = [];
  let off = start;
  while (off + 8 <= end) {
    let size = dv.getUint32(off);
    const type = fourcc(u8, off + 4);
    let header = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) break;
    list.push({ type, offset: off, size, header, dataOffset: off + header });
    off += size;
  }
  return list;
}

export function findBox(u8, type, start = 0, end = u8.length) {
  return readBoxes(u8, start, end).find((b) => b.type === type) || null;
}

/** 递归查找第一个匹配的子 box */
export function findDeep(u8, type, start = 0, end = u8.length) {
  for (const box of readBoxes(u8, start, end)) {
    if (box.type === type) return box;
    if (CONTAINERS.has(box.type)) {
      const hit = findDeep(u8, type, box.dataOffset, box.offset + box.size);
      if (hit) return hit;
    }
  }
  return null;
}

export function u32(u8, offset) {
  return view(u8).getUint32(offset);
}

export function putU32(u8, offset, value) {
  view(u8).setUint32(offset, value);
}

export function putU64(u8, offset, value) {
  view(u8).setBigUint64(offset, BigInt(value));
}

export function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** 文本 → 定长 ASCII 字节 */
export function ascii(text, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length && i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}
