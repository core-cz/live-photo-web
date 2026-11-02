import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { injectLivePhoto, randomUUID } from "../assets/lib/livephoto.js";

const base = new Uint8Array(readFileSync(process.argv[2] || "/tmp/clip.mov"));
const tpl = new Uint8Array(readFileSync("/workspace/live-photo-web/assets/metadata_tpl.mov"));
const uuid = randomUUID();

const out = injectLivePhoto(base, tpl, uuid);
writeFileSync("/tmp/js_out.mov", out);
console.log("uuid", uuid, "size", out.length);

const still = execFileSync("exiftool", ["-ee3", "-s3", "-StillImageTime", "/tmp/js_out.mov"]).toString().trim();
const cid = execFileSync("exiftool", ["-ee3", "-s3", "-Keys:ContentIdentifier", "/tmp/js_out.mov"]).toString().trim();
const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_tag_string", "-of", "csv=p=0", "/tmp/js_out.mov"]).toString().trim();
const pts = execFileSync("ffprobe", ["-v", "error", "-select_streams", "2", "-show_entries", "packet=pts_time", "-of", "csv=p=0", "/tmp/js_out.mov"]).toString().trim();
console.log({ streams, still, cid, pts });
console.log(still === "-1" && cid === uuid ? "PASS" : "FAIL");
