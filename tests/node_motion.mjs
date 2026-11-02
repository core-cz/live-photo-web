import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildMotionPhoto, buildMpf } from "../assets/lib/motion.js";
import { jpegForIos, jpegForAndroid } from "../assets/lib/exif.js";

const jpg = new Uint8Array(readFileSync("/tmp/cmp/frame.jpg"));
const mp4 = new Uint8Array(readFileSync("/tmp/cmp/clip.mov"));
const uuid = "A140CA6D-DA81-45A1-BD33-3AC0C3F588DC";

writeFileSync("/tmp/js_ios.jpg", jpegForIos(jpg, uuid));
writeFileSync("/tmp/js_android.jpg", jpegForAndroid(jpg));
const mp = buildMotionPhoto(jpg, mp4, 1500000);
writeFileSync("/tmp/js_motion.mp.jpg", mp);

const run = (args) => execFileSync("exiftool", args).toString().trim();

console.log("--- iOS ---");
console.log("Make:", run(["-s3", "-Make", "/tmp/js_ios.jpg"]));
console.log("UUID:", run(["-s3", "-ContentIdentifier", "/tmp/js_ios.jpg"]));
console.log("Model:", run(["-s3", "-Model", "/tmp/js_ios.jpg"]));

console.log("--- Android ---");
console.log("Make:", run(["-s3", "-Make", "/tmp/js_android.jpg"]));
console.log("UUID(should be empty):", run(["-s3", "-ContentIdentifier", "/tmp/js_android.jpg"]));

console.log("--- Motion ---");
console.log(run(["-a", "-G1", "-s", "-MPF:all", "/tmp/js_motion.mp.jpg"]));
console.log("XMP MotionPhoto:", run(["-s3", "-XMP-GCamera:MotionPhoto", "/tmp/js_motion.mp.jpg"]));
console.log("ItemLength:", run(["-s3", "-XMP-Container:DirectoryItemLength", "/tmp/js_motion.mp.jpg"]));

const d = mp;
const primary = 0;
const len = d.length;
console.log("total:", len);
