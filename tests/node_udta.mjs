import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { injectUdta } from "../assets/lib/motion.js";
import { oplusMetaJson, oplusVideoId } from "../assets/lib/exif.js";

const mp4 = new Uint8Array(readFileSync(process.argv[2] || "/tmp/v2.mp4"));
const vid = oplusVideoId();
const metaJson = oplusMetaJson(vid);

const out = injectUdta(mp4, { metaJson });
writeFileSync("/tmp/udta_only.mp4", out);

function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    else if (size === 0) size = end - off;
    if (size < header || off + size > end) break;
    out.push({ type, offset: off, size, dataOffset: off + header });
    if (["moov", "trak", "mdia", "minf", "stbl", "udta", "meta", "ilst"].includes(type)) {
      out.push(...boxes(buf, off + header + (type === "meta" ? 4 : 0), off + size));
    }
    off += size;
  }
  return out;
}

const buf = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
const list = boxes(buf);
console.log("=== 顶层 ===");
for (const b of list.filter((b) => b.offset === 0 || b.type === "mdat" || b.type === "moov" || b.type === "free")) {
  console.log(` ${b.offset} ${b.size} ${b.type}`);
}

const udta = list.find((b) => b.type === "udta");
console.log("\nudta:", udta ? `offset=${udta.offset} size=${udta.size} ✓` : "缺失 ✗");

const kids = boxes(buf, udta.dataOffset, udta.offset + udta.size);
const meta = kids.find((b) => b.type === "meta");
const metaKids = boxes(buf, meta.dataOffset + 4, meta.offset + meta.size);
console.log("meta 子盒:", metaKids.map((b) => b.type).join(" "));

const keys = metaKids.find((b) => b.type === "keys");
const n = buf.readUInt32BE(keys.dataOffset + 4);
const names = [];
let p = keys.dataOffset + 8;
for (let i = 0; i < n; i += 1) {
  const ks = buf.readUInt32BE(p);
  names.push(buf.toString("utf8", p + 8, p + ks));
  p += ks;
}
console.log("keys:", names.join(", "));

const ilst = metaKids.find((b) => b.type === "ilst");
let q = ilst.dataOffset;
while (q + 8 <= ilst.offset + ilst.size) {
  const es = buf.readUInt32BE(q);
  const idx = buf.readUInt32BE(q + 4);
  const ds = buf.readUInt32BE(q + 8);
  const payload = buf.toString("utf8", q + 24, q + 8 + ds);
  console.log(`  [${idx}] ${names[idx - 1]} = ${payload.slice(0, 60)}${payload.length > 60 ? "…" : ""}`);
  q += es;
}

console.log("\n长度:", mp4.length, "→", out.length, `(+${out.length - mp4.length})`);
console.log("\n=== ffprobe ===");
console.log(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "compact", "/tmp/udta_only.mp4"]).toString());

console.log("=== moov 里 meta 是否被 ffmpeg 认可 ===");
try {
  const r = execFileSync("ffprobe", ["-v", "trace", "-i", "/tmp/udta_only.mp4"], { stdio: ["ignore", "ignore", "pipe"] });
  void r;
} catch (e) {
  const err = String(e.stderr || "");
  console.log(err.includes("udta") ? "trace 里出现 udta" : "trace 无 udta（正常，ffmpeg 不解析私有元数据）");
}
