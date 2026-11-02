// 极简 ZIP 打包（store，不压缩）。.livp 和导出包都只是 ZIP。

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(v, arr) {
  arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

function u16(v, arr) {
  arr.push(v & 0xff, (v >>> 8) & 0xff);
}

function now() {
  const d = new Date();
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

/** @param {{name: string, data: Uint8Array}[]} files */
export function makeZip(files) {
  const enc = new TextEncoder();
  const { time, date } = now();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);

    const lh = [];
    u32(0x04034b50, lh);
    u16(20, lh);
    u16(0x0800, lh); // UTF-8 文件名
    u16(0, lh); // store
    u16(time, lh);
    u16(date, lh);
    u32(crc, lh);
    u32(f.data.length, lh);
    u32(f.data.length, lh);
    u16(name.length, lh);
    u16(0, lh);

    locals.push(new Uint8Array(lh), name, f.data);

    const ch = [];
    u32(0x02014b50, ch);
    u16(20, ch);
    u16(20, ch);
    u16(0x0800, ch);
    u16(0, ch);
    u16(time, ch);
    u16(date, ch);
    u32(crc, ch);
    u32(f.data.length, ch);
    u32(f.data.length, ch);
    u16(name.length, ch);
    u16(0, ch);
    u16(0, ch);
    u16(0, ch);
    u16(0, ch);
    u32(0, ch);
    u32(offset, ch);
    centrals.push(new Uint8Array(ch), name);

    offset += lh.length + name.length + f.data.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = [];
  u32(0x06054b50, eocd);
  u16(0, eocd);
  u16(0, eocd);
  u16(files.length, eocd);
  u16(files.length, eocd);
  u32(centralSize, eocd);
  u32(offset, eocd);
  u16(0, eocd);

  const all = [...locals, ...centrals, new Uint8Array(eocd)];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
