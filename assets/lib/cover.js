// 用 canvas 生成封面，避免为了抽一帧再跑一次 ffmpeg。
// 封面尺寸必须和视频完全一致，否则 iOS 会把实况照片对齐错。

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = even(w);
  c.height = even(h);
  return c;
}

function drawCover(ctx, source, sw, sh, dw, dh) {
  const scale = Math.max(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(source, (dw - w) / 2, (dh - h) / 2, w, h);
}

function toJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("封面编码失败"));
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
    }, "image/jpeg", 0.92);
  });
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    if (img.decode) await img.decode();
    else await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function grabVideoFrame(file, time) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error("视频解码失败"));
      setTimeout(() => reject(new Error("视频解码超时")), 20000);
    });
    const t = Math.min(Math.max(0, time), Math.max(0, (video.duration || 0) - 0.05));
    if (Math.abs(video.currentTime - t) > 0.01) {
      video.currentTime = t;
      await new Promise((resolve) => {
        video.onseeked = resolve;
        setTimeout(resolve, 3000);
      });
    }
    return video;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

function drawFallback(ctx, w, h, label) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#0f172a");
  g.addColorStop(1, "#0f766e");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  if (label) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = `${Math.round(w * 0.055)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(label, w / 2, h / 2);
  }
}

/**
 * @returns {Promise<Uint8Array>} JPEG 字节
 */
export async function makeCover({ kind, file, coverFile, coverTime, width, height }) {
  const w = even(width);
  const h = even(height);
  const canvas = canvasOf(w, h);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";

  if (kind === "video") {
    const video = await grabVideoFrame(file, coverTime);
    drawCover(ctx, video, video.videoWidth, video.videoHeight, w, h);
    return toJpeg(canvas);
  }

  if (kind === "image") {
    const img = await loadImage(file);
    drawCover(ctx, img, img.naturalWidth, img.naturalHeight, w, h);
    return toJpeg(canvas);
  }

  // audio：有封面图就用，没有就画一个渐变底
  if (coverFile) {
    const img = await loadImage(coverFile);
    drawCover(ctx, img, img.naturalWidth, img.naturalHeight, w, h);
    return toJpeg(canvas);
  }
  drawFallback(ctx, w, h, file.name.replace(/\.[^.]+$/, "").slice(0, 20));
  return toJpeg(canvas);
}
