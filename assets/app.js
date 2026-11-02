import { detectKind, generate } from "./lib/pipeline.js";

const $ = (id) => document.getElementById(id);

const drop = $("drop");
const fileInput = $("file");
const meta = $("meta");
const fname = $("fname");
const finfo = $("finfo");
const timeRow = $("timeRow");
const timeRange = $("timeRange");
const timeValue = $("timeValue");
const coverRow = $("coverRow");
const coverFile = $("coverFile");
const coverName = $("coverName");
const go = $("go");
const progress = $("progress");
const bar = $("bar");
const stage = $("stage");
const pct = $("pct");
const tip = $("tip");
const player = $("player");
const poster = $("poster");
const placeholder = $("placeholder");
const liveBadge = $("liveBadge");
const resLabel = $("resLabel");
const result = $("result");

const state = {
  file: null,
  kind: null,
  info: null,
  cover: null,
  duration: 3,
  busy: false,
  urls: [],
};

function releaseUrls() {
  for (const u of state.urls) URL.revokeObjectURL(u);
  state.urls = [];
}

function blobUrl(data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  state.urls.push(url);
  return url;
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function probeLocal(file, kind) {
  const url = URL.createObjectURL(file);
  const done = (v) => { URL.revokeObjectURL(url); return v; };

  if (kind === "image") {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(done({ width: img.naturalWidth, height: img.naturalHeight, duration: 0 }));
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片无法解析")); };
      img.src = url;
    });
  }
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => resolve(done({
      width: v.videoWidth, height: v.videoHeight,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
    }));
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error("媒体无法解析")); };
    setTimeout(() => { URL.revokeObjectURL(url); reject(new Error("读取超时")); }, 20000);
    v.src = url;
  });
}

async function pickFile(file) {
  if (!file) return;
  const kind = detectKind(file);
  if (!kind) {
    setStage("不支持这种文件，试试 MP4 / MOV / JPG / PNG / MP3", true);
    return;
  }
  releaseUrls();
  state.file = file;
  state.kind = kind;
  state.cover = null;
  coverName.textContent = "选择一张图";
  player.hidden = true;
  poster.hidden = true;
  placeholder.hidden = false;
  liveBadge.hidden = true;
  result.hidden = true;
  resLabel.textContent = "等待生成";

  fname.textContent = file.name;
  meta.hidden = false;
  go.disabled = false;
  setStage("");

  try {
    const info = await probeLocal(file, kind);
    state.info = info;
    const bits = [humanSize(file.size)];
    if (kind === "image") bits.push(`${info.width}×${info.height}`);
    else if (kind === "video") bits.push(`${info.width}×${info.height}`, `${info.duration.toFixed(1)} 秒`);
    else bits.push(`${info.duration.toFixed(1)} 秒`);
    bits.push(kind === "video" ? "视频" : kind === "image" ? "照片" : "音频");
    finfo.textContent = bits.join(" · ");

    if (kind === "video") {
      const max = Math.max(0.5, info.duration - 0.5);
      timeRange.max = String(Math.round(max * 10) / 10);
      timeRange.value = String(Math.min(1.5, max));
      timeValue.textContent = `${Number(timeRange.value).toFixed(1)}s`;
      timeRow.hidden = false;
    } else {
      timeRow.hidden = true;
    }
    coverRow.hidden = kind !== "audio";
  } catch (err) {
    finfo.textContent = String(err.message || err);
  }
}

function setStage(text, isError = false) {
  stage.textContent = text || "";
  stage.style.color = isError ? "#fca5a5" : "";
  if (isError) {
    progress.hidden = false;
    bar.style.width = "100%";
    bar.style.background = "#7f1d1d";
    pct.textContent = "";
  }
}

function setProgress(label, value) {
  progress.hidden = false;
  bar.style.background = "";
  bar.style.width = `${Math.round((value || 0) * 100)}%`;
  stage.textContent = label;
  pct.textContent = value == null ? "" : `${Math.round(value * 100)}%`;
}

fileInput.addEventListener("change", () => pickFile(fileInput.files[0]));

["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  }));

["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  }));

drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) pickFile(f);
});

$("reset").addEventListener("click", (e) => {
  e.preventDefault();
  fileInput.value = "";
  coverFile.value = "";
  state.file = null;
  state.info = null;
  meta.hidden = true;
  timeRow.hidden = true;
  coverRow.hidden = true;
  progress.hidden = true;
  go.disabled = true;
  result.hidden = true;
  setStage("");
});

timeRange.addEventListener("input", () => {
  timeValue.textContent = `${Number(timeRange.value).toFixed(1)}s`;
});

coverFile.addEventListener("change", () => {
  const f = coverFile.files[0];
  state.cover = f || null;
  coverName.textContent = f ? f.name : "选择一张图";
});

$("duration").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-value]");
  if (!btn) return;
  for (const b of $("duration").querySelectorAll("button")) b.classList.toggle("on", b === btn);
  state.duration = Number(btn.dataset.value);
});

go.addEventListener("click", async () => {
  if (state.busy || !state.file) return;
  state.busy = true;
  go.disabled = true;
  go.textContent = "生成中…";
  tip.hidden = true;
  releaseUrls();
  setProgress("准备中", 0);

  try {
    const res = await generate({
      file: state.file,
      coverFile: state.cover,
      duration: state.duration,
      coverTime: Number(timeRange.value) || 1.5,
      onStage: (name, p) => setProgress(name, p),
    });

    setProgress("完成", 1);
    setTimeout(() => { progress.hidden = true; }, 800);

    // 预览：封面图垫底，MOV 能播就淡入叠上去
    poster.src = blobUrl(res.cover, "image/jpeg");
    poster.hidden = false;
    placeholder.hidden = true;

    player.src = blobUrl(res.mov, "video/quicktime");
    player.style.opacity = "0";
    player.hidden = false;
    player.oncanplay = () => {
      player.style.opacity = "1";
      player.play().catch(() => {});
    };
    player.onerror = () => {
      player.hidden = true;
    };
    liveBadge.hidden = false;

    resLabel.textContent = `${res.kind === "video" ? "视频" : res.kind === "image" ? "照片" : "音频"} · ${state.duration.toFixed(1)} 秒 · ${res.uuid.slice(0, 8)}`;

    $("dlLivp").href = blobUrl(res.livp, "application/zip");
    $("dlMotion").href = blobUrl(res.motion, "image/jpeg");
    $("dlZip").href = blobUrl(res.bundle, "application/zip");
    $("sizeLivp").textContent = humanSize(res.livp.length);
    $("sizeMotion").textContent = humanSize(res.motion.length);
    $("sizeZip").textContent = humanSize(res.bundle.length);
    result.hidden = false;

    if (window.innerWidth < 861) {
      result.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (err) {
    console.error(err);
    setStage(String(err.message || err), true);
  } finally {
    state.busy = false;
    go.disabled = !state.file;
    go.textContent = "生成实况照片";
  }
});
