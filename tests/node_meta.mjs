import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { jpegWithUUID } from "../assets/lib/exif.js";
import { buildMotionPhoto } from "../assets/lib/motion.js";
import { makeZip } from "../assets/lib/zip.js";
import { randomUUID } from "../assets/lib/livephoto.js";

const jpg = new Uint8Array(readFileSync("/workspace/live-photo-demo/IMG_0001.JPG"));
const mp4 = new Uint8Array(readFileSync("/tmp/clip.mov"));
const uuid = randomUUID();

writeFileSync("/tmp/js_cover.jpg", jpegWithUUID(jpg, uuid));
writeFileSync("/tmp/js_motion.jpg", buildMotionPhoto(jpg, mp4));

const cid = execFileSync("exiftool", ["-s3", "-ContentIdentifier", "/tmp/js_cover.jpg"]).toString().trim();
console.log("cover cid:", cid, cid === uuid ? "OK" : "MISMATCH");

const xmp = execFileSync("exiftool", ["-s3", "-XMP-GCamera:MotionPhoto", "-XMP-GCamera:MotionPhotoVersion",
  "-XMP-GCamera:MotionPhotoPresentationTimestampUs", "-XMP-Container:DirectoryItemSemantic",
  "-XMP-Container:DirectoryItemLength", "/tmp/js_motion.jpg"]).toString().trim();
console.log("motion xmp:\n" + xmp);

const zip = makeZip([
  { name: "IMG_0001.JPG", data: jpegWithUUID(jpg, uuid) },
  { name: "IMG_0001.MOV", data: new Uint8Array(readFileSync("/tmp/js_out.mov")) },
]);
writeFileSync("/tmp/js_out.livp", zip);
console.log(execFileSync("unzip", ["-t", "/tmp/js_out.livp"]).toString().trim());
