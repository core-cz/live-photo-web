// Android Motion Photo（单文件动态照片）。
//
// 布局：
//   JPEG 主图（EXIF: Make=Google + UserComment=oplus_*）
//     ├─ APP1 XMP   无 xpacket 包裹
//     └─ APP2 MPF   NumberOfImages=2（Primary + GainMap）
//   GainMap 数据     主图字节副本（占位，校验器只验结构不比对内容）
//   16 字节 0 填充
//   视频原始字节      结束于 EOF，ftyp brand 补丁为 isom/mp41
//
// 三个不能省的细节：
// 1. MPF 必须双条目。只写 XMP 字段在 ColorOS / 一加上永远显示静态图；
//    真机单变量 A/B 二分确认触发点就是 MPF NumberOfImages=2 + 实体 GainMap
//    数据 + 16B 填充，而非任何文档化字段。
// 2. 视频定位靠「EOF − Item:Length」，视频必须紧贴文件尾，Length 错 1 字节就废。
// 3. MPF 偏移基准是「MPF\0」之后的 TIFF 起点。

import { concat, insertApp1, insertApp2, jpegForAndroid, lastAppEnd } from "./exif.js";

const enc = new TextEncoder();
const XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0";
const PAD = new Uint8Array(16);

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
      OpCamera:MotionPhotoOwner="oplus"
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

const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

/** MP Entry: 属性(4) + 尺寸(4) + 偏移(4) + 依赖1(2) + 依赖2(2) */
function mpfEntry(attrs, size, offset) {
  return Uint8Array.from([...u32(attrs), ...u32(size), ...u32(offset), 0, 0, 0, 0]);
}

/** 构造 NumberOfImages=2 的 MPF（不含 FFE2 与长度字段）。长度固定 86 字节。 */
export function buildMpf(primarySize, gainmapSize, gainmapOffset) {
  const header = Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a, ...u32(8)]);
  const n = 3;
  const ifdLen = 2 + n * 12 + 4;
  const dataOff = 8 + ifdLen; // 50

  const ifd = [];
  ifd.push(0, n);
  ifd.push(0xb0, 0x00, 0, 7, ...u32(4), 0x30, 0x31, 0x30, 0x30);      // "0100"
  ifd.push(0xb0, 0x01, 0, 4, ...u32(1), ...u32(2));                    // NumberOfImages
  ifd.push(0xb0, 0x02, 0, 7, ...u32(32), ...u32(dataOff));             // MPEntry
  ifd.push(...u32(0));                                                  // next IFD

  const data = concat([
    mpfEntry(0x00030000, primarySize, 0),   // Primary
    mpfEntry(0x00000000, gainmapSize, gainmapOffset), // GainMap
  ]);

  return concat([enc.encode("MPF\0"), header, Uint8Array.from(ifd), data]);
}

/** QuickTime brand 原位等长改写为 isom/mp41，不移动任何 box。 */
export function patchBrand(mp4) {
  if (mp4.length < 16 || mp4[4] !== 0x66 || mp4[5] !== 0x74
      || mp4[6] !== 0x79 || mp4[7] !== 0x70) return mp4;
  const size = (mp4[0] << 24) | (mp4[1] << 16) | (mp4[2] << 8) | mp4[3];
  if (size < 16 || size > mp4.length) return mp4;
  const out = mp4.slice();
  const isQt = (i) => mp4[i] === 0x71 && mp4[i + 1] === 0x74
    && mp4[i + 2] === 0x20 && mp4[i + 3] === 0x20;
  if (isQt(8)) out.set([0x69, 0x73, 0x6f, 0x6d], 8); // isom
  for (let p = 16; p + 4 <= size; p += 4) {
    if (isQt(p)) out.set([0x6d, 0x70, 0x34, 0x31], p); // mp41
  }
  return out;
}

/**
 * @param {Uint8Array} jpeg  封面图（会被替换 EXIF，去 Apple 化）
 * @param {Uint8Array} video MP4
 * @param {number} tsUs      封面时间戳（微秒）
 */
export function buildMotionPhoto(jpeg, video, tsUs = 500000) {
  const v = patchBrand(video);

  // 1. EXIF 去 Apple 化
  let out = jpegForAndroid(jpeg);

  // 2. XMP（无 xpacket）
  const xmp = enc.encode(XMP_HEADER + XMP(tsUs, v.length));
  out = insertApp1(out, xmp);

  // 3. MPF：段长固定 86，主图长度含 MPF 自身
  const mpfLen = 4 + 8 + 42 + 32;
  const insertPos = lastAppEnd(out);
  const jpegLen = out.length + 4 + mpfLen;
  const tiffStart = insertPos + 8;             // marker(2)+len(2)+"MPF\0"(4)
  const gainmapOffset = jpegLen - tiffStart;
  const mpf = buildMpf(jpegLen, jpegLen, gainmapOffset);
  out = insertApp2(out, mpf);

  // 4. 主图 | GainMap | 16B 填充 | 视频
  return concat([out, out, PAD, v]);
}
