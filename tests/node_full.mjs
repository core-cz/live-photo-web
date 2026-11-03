import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildMotionPhoto } from "../assets/lib/motion.js";

const jpg = new Uint8Array(readFileSync(process.argv[2] || "tests/sample.jpg"));
const mp4 = new Uint8Array(readFileSync(process.argv[3] || "/tmp/v2.mp4"));
const out = process.argv[4] || "/tmp/test.MP.jpg";

const mp = buildMotionPhoto(jpg, mp4, 1500000);
writeFileSync(out, mp);

const buf = Buffer.from(mp.buffer, mp.byteOffset, mp.byteLength);
// 视频长度直接由 XMP 里的 VideoLength 反推，避免在 MP4 熵数据里误撞 FFD9
const vlMatch = /OpCamera:VideoLength="(\d+)"/.exec(buf.toString("latin1"));
const videoLen = Number(vlMatch[1]);
const eoi = mp.length - videoLen - 2;
console.log("total:", mp.length, "EOI@", eoi, "video:", videoLen);

// JPEG 段序
const segs = [];
let p = 2;
while (p + 4 <= eoi) {
  if (buf[p] !== 0xff) break;
  const m = buf[p + 1];
  if (m === 0xda) break;
  const len = buf.readUInt16BE(p + 2);
  segs.push("0x" + m.toString(16));
  p += 2 + len;
}
console.log("段序:", segs.join(" "), "(期望 e1 e1 e0 e2 e2)");

const xmlStart = buf.indexOf(Buffer.from("<x:xmpmeta"));
const xml = buf.toString("utf8", xmlStart, buf.indexOf(Buffer.from("</x:xmpmeta>")) + 12);
const pick = (k) => (new RegExp(`${k}="([^"]*)"`).exec(xml) || [, ""])[1];
console.log("MotionPhoto:", pick("GCamera:MotionPhoto"), "ts:", pick("MotionPhotoPresentationTimestampUs"), "VideoLength:", pick("OpCamera:VideoLength"));

const uc = buf.indexOf(Buffer.from("ASCII\0\0\0"));
const ucEnd = buf.indexOf(0, uc + 8);
const parsed = JSON.parse(buf.toString("utf8", uc + 8, ucEnd));
console.log("UserComment.source_type:", parsed.source_type, "| oplustag:", parsed.oplustag, "| videoId:", parsed.data.videoId);

const video = buf.subarray(eoi + 2);
writeFileSync("/tmp/test_tail.mp4", video);

console.log("\n=== ffprobe ===");
console.log(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,duration:format=duration", "-of", "compact", "/tmp/test_tail.mp4"]).toString().trim());

console.log("\n=== udta ===");
console.log(execFileSync("python3", ["-c", `
import struct
d=open('/tmp/test_tail.mp4','rb').read()
off=0; moov=None
while off+8<=len(d):
    sz=struct.unpack('>I',d[off:off+4])[0]; ty=d[off+4:off+8].decode('latin1','replace')
    if sz<8: break
    if ty=='moov': moov=(off,sz)
    off+=sz
o,s=moov
p=o+8
while p+8<=o+s:
    sz=struct.unpack('>I',d[p:p+4])[0]; ty=d[p+4:p+8].decode('latin1','replace')
    print(' ',ty,sz)
    if ty=='udta':
        q=p+8
        while q+8<=p+sz:
            s2=struct.unpack('>I',d[q:q+4])[0]; t2=d[q+4:q+8].decode('latin1','replace')
            print('   ',t2,s2)
            q+=s2
    p+=sz
`]).toString().trim());
