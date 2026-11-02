// Android Motion Photo 1.0：单文件，JPEG（SOI + XMP APP1 + 图像 + EOI）+ MP4 字节。
// 关键字段见 Google 的 Camera / Container 命名空间。

const enc = new TextEncoder();

const XMP = (tsUs, videoLen) => `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:Camera="http://ns.google.com/photos/1.0/camera/"
    xmlns:Container="http://ns.google.com/photos/1.0/container/"
    xmlns:Item="http://ns.google.com/photos/1.0/container/item/"
    Camera:MotionPhoto="1"
    Camera:MotionPhotoVersion="1"
    Camera:MotionPhotoPresentationTimestampUs="${tsUs}">
   <Container:Directory>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"/>
     </rdf:li>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${videoLen}"/>
     </rdf:li>
    </rdf:Seq>
   </Container:Directory>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

export function jpegEnd(data) {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error("不是 JPEG");
  let pos = 2;
  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xff) throw new Error("JPEG 段结构异常");
    const marker = data[pos + 1];
    if (marker === 0xd9) return pos + 2;
    if (marker === 0xda) {
      for (let i = data.length - 2; i >= pos; i -= 1) {
        if (data[i] === 0xff && data[i + 1] === 0xd9) return i + 2;
      }
      throw new Error("找不到 JPEG 结尾");
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2;
      continue;
    }
    const len = (data[pos + 2] << 8) | data[pos + 3];
    pos += 2 + len;
  }
  throw new Error("找不到 JPEG 结尾");
}

/**
 * @param {Uint8Array} jpeg 封面图
 * @param {Uint8Array} video 视频（MP4）
 * @param {number} tsUs 封面时间戳（微秒），与视频里封面帧一致
 */
export function buildMotionPhoto(jpeg, video, tsUs = 500000) {
  const end = jpegEnd(jpeg);
  const image = jpeg.subarray(0, end);

  const xmp = enc.encode(XMP(tsUs, video.length));
  const prefix = enc.encode("http://ns.adobe.com/xap/1.0/\0");
  const payloadLen = prefix.length + xmp.length;

  const app1 = new Uint8Array(4 + payloadLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = (payloadLen + 2) >> 8;
  app1[3] = (payloadLen + 2) & 0xff;
  app1.set(prefix, 4);
  app1.set(xmp, 4 + prefix.length);

  const out = new Uint8Array(2 + app1.length + (image.length - 2) + video.length);
  out.set(image.subarray(0, 2), 0);
  out.set(app1, 2);
  out.set(image.subarray(2), 2 + app1.length);
  out.set(video, 2 + app1.length + image.length - 2);
  return out;
}
