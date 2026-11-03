import { buildPlan, generate, detectKind, warmup, STILL_TIME } from "./lib/pipeline.js";

const $ = (id) => document.getElementById(id);

const slotA = $("slotA");
const slotB = $("slotB");
const fileA = $("fileA");
const fileB = $("fileB");
const pickA = $("pickA");
const pickB = $("pickB");
const hintA = $("hintA");
const hintB = $("hintB");
const planLine = $("planLine");
const timeRow = $("timeRow");
const timeRange = $("timeRange");
const timeValue = $("timeValue");
const go = $("go");
const progress = $("progress");
const bar = $("bar");
const stage = $("stage");
const pct = $("pct");
const tip = $("tip");
const reset = $("reset");
const player = $("player");
const poster = $("poster");
const placeholder = $("placeholder");
const liveBadge = $("liveBadge");
const resLabel = $("resLabel");
const result = $("result");

const state = {
  a: null,
  b: null,
  plan: null,
  duration: 0,      // 0 = 全长
  busy: false,
  urls: [],
};

const KIND_LABEL = { video: "视频", motion: "实况照片", image: "照片", audio: "音频" };

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

function describePlan(plan) {
  const parts = [];
  const passthrough = plan.video && plan.video.kind === "motion" && !plan.videoFromSecondary;

  if (passthrough) {
    parts.push("画面与声音：<b>原样复用</b>这条实况，不重编码、不丢音轨");
    if (plan.audioFile) parts.push("声音改为：<b>副素材语音</b>");
    return parts.join(" · ");
  }

  if (plan.video) {
    if (plan.videoFromSecondary) parts.push("画面：<b>副素材视频</b>");
    else parts.push("画面：<b>主素材视频</b>");
  } else {
    parts.push("画面：<b>照片缓慢推近</b>");
  }

  if (plan.still) parts.push("封面：<b>照片</b>");

  if (plan.audioFile) parts.push("声音：<b>副素材语音</b>");
  else if (plan.audioVideo) parts.push("声音：<b>副素材视频的音轨</b>");
  else if (plan.video && plan.hasOwnAudio) parts.push("声音：<b>画面自带</b>");
  else parts.push("声音：<b>静音</b>（补空 AAC 轨）");

  return parts.join(" · ");
}

async function refresh() {
  reset.hidden = !state.a && !state.b;
  planLine.hidden = true;
  timeRow.hidden = true;
  go.disabled = true;
  state.plan = null;

  if (!state.a) {
    slotA.classList.remove("filled");
    pickA.textContent = "照片 / 视频 / 实况照片";
    hintA.textContent = "决定画面和封面";
    pickB.textContent = "语音 / 视频 / 照片";
    hintB.textContent = "可选。声音取自这里";
    slotB.classList.remove("filled");
    return;
  }

  try {
    const plan = await buildPlan(state.a, state.b);
    state.plan = plan;

    slotA.classList.add("filled");
    pickA.textContent = state.a.name;
    hintA.textContent = `${KIND_LABEL[plan.A.kind]} · ${humanSize(state.a.size)}`;

    if (state.b) {
      slotB.classList.add("filled");
      pickB.textContent = state.b.name;
      hintB.textContent = `${KIND_LABEL[plan.B.kind]} · ${humanSize(state.b.size)}`;
    } else {
      slotB.classList.remove("filled");
      pickB.textContent = "语音 / 视频 / 照片";
      hintB.textContent = "可选。声音取自这里";
    }

    planLine.innerHTML = describePlan(plan);
    planLine.hidden = false;
    go.disabled = false;

    const natural = plan.videoInfo && plan.videoInfo.duration
      ? plan.videoInfo.duration
      : (plan.audioInfo && plan.audioInfo.duration ? plan.audioInfo.duration : 0);

    if (plan.video && plan.video.kind === "video" && natural > 0.6) {
      timeRow.hidden = false;
      const max = Math.max(0.5, Math.round((natural - 0.5) * 10) / 10);
      timeRange.max = String(max);
      timeRange.value = String(Math.min(0.5, max));
      timeValue.textContent = `${Number(timeRange.value).toFixed(1)}s`;
    }

    warmup();
  } catch (err) {
    planLine.textContent = String(err.message || err);
    planLine.hidden = false;
  }
}

function pick(which, file) {
  if (!file) return;
  if (!detectKind(file)) {
    setStage("不支持这种文件，试试 MP4 / MOV / JPG / PNG / MP3", true);
    return;
  }
  if (which === "a") state.a = file; else state.b = file;
  result.hidden = true;
  player.hidden = true;
  poster.hidden = true;
  placeholder.hidden = false;
  liveBadge.hidden = true;
  setStage("");
  refresh();
}

fileA.addEventListener("change", () => pick("a", fileA.files[0]));
fileB.addEventListener("change", () => pick("b", fileB.files[0]));

function wireDrop(el, which) {
  ["dragenter", "dragover"].forEach((ev) =>
    el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) =>
    el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.remove("over"); }));
  el.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) pick(which, f);
  });
}

wireDrop(slotA, "a");
wireDrop(slotB, "b");

reset.addEventListener("click", (e) => {
  e.preventDefault();
  fileA.value = "";
  fileB.value = "";
  state.a = null;
  state.b = null;
  progress.hidden = true;
  result.hidden = true;
  setStage("");
  refresh();
});

timeRange.addEventListener("input", () => {
  timeValue.textContent = `${Number(timeRange.value).toFixed(1)}s`;
});

$("duration").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-value]");
  if (!btn) return;
  for (const b of $("duration").querySelectorAll("button")) b.classList.toggle("on", b === btn);
  state.duration = Number(btn.dataset.value);
});

go.addEventListener("click", async () => {
  if (state.busy || !state.a) return;
  state.busy = true;
  go.disabled = true;
  go.textContent = "生成中…";
  tip.hidden = true;
  releaseUrls();
  setProgress("准备中", 0);

  try {
    const start = timeRow.hidden ? 0 : Math.max(0, Number(timeRange.value) - STILL_TIME);
    const res = await generate({
      primary: state.a,
      secondary: state.b,
      duration: state.duration,
      start,
      onStage: (name, p) => setProgress(name, p),
    });

    setProgress("完成", 1);
    setTimeout(() => { progress.hidden = true; }, 800);

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
    player.onerror = () => { player.hidden = true; };
    liveBadge.hidden = false;

    const kindLabel = { video: "视频", motion: "实况照片", image: "照片", audio: "音频" }[res.kind] || "素材";
    resLabel.textContent =
      `${kindLabel} · ${res.duration.toFixed(1)} 秒 · ${res.audio ? "有声音" : "静音"} · ${res.uuid.slice(0, 8)}`;

    $("dlLivp").href = blobUrl(res.iosZip, "application/zip");
    $("dlMotion").href = blobUrl(res.motion, "image/jpeg");
    $("dlZip").href = blobUrl(res.bundle, "application/zip");
    $("sizeLivp").textContent = humanSize(res.iosZip.length);
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
    go.disabled = !state.a;
    go.textContent = "生成实况照片";
  }
});

refresh();
