import { analyzeAudio, analyzeMotion, combine, pickClips, explain, seek, fmt } from "./engine.js";
import { Renderer, canExport, pickMime } from "./render.js";
import { findTrending, compact } from "./trends.js";

const $ = (s) => document.querySelector(s);
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/* -------------------------------------------------------------- stockage */
const store = {
  get(k, d) { try { const v = localStorage.getItem("cf:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("cf:" + k, JSON.stringify(v)); } catch {} },
};

/* ---------------------------------------------------------------- état */
const state = {
  file: null, url: null, duration: 0,
  signals: null, level: null, score: null,
  clips: [], busy: false,
};
const renderer = new Renderer();
const work = $("#work");
const preview = $("#preview");

const settings = {
  count: store.get("count", 5), length: store.get("length", 30), format: store.get("format", "vertical"),
  zoom: store.get("zoom", 1), offset: store.get("offset", 0), title: store.get("title", ""),
  handle: store.get("handle", ""), quality: store.get("quality", "720"),
};

/* ---------------------------------------------------------------- onglets */
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", x === b));
    document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + b.dataset.tab));
    if (b.dataset.tab === "clip") drawTimeline();
  })
);

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}

/* ------------------------------------------------------- compatibilité */
if (!canExport()) {
  const c = $("#compat");
  c.hidden = false;
  c.textContent = "Ton navigateur peut analyser les vidéos mais pas exporter les clips. Mets à jour iOS / Chrome.";
}

/* ---------------------------------------------------------------- réglages */
function bindSeg(id, key, after) {
  const el = $(id);
  const sync = () => el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === String(settings[key])));
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    settings[key] = key === "length" ? +b.dataset.v : b.dataset.v;
    store.set(key, settings[key]);
    sync();
    after && after();
  });
  sync();
}
function bindRange(id, key, out, label, after) {
  const el = $(id);
  el.value = settings[key];
  const upd = () => ($(out).textContent = label(+el.value));
  el.addEventListener("input", () => { settings[key] = +el.value; store.set(key, settings[key]); upd(); after && after(); });
  upd();
}
function bindText(id, key) {
  const el = $(id);
  el.value = settings[key];
  el.addEventListener("input", () => { settings[key] = el.value; store.set(key, el.value); });
}
bindRange("#count", "count", "#countOut", (v) => v, () => reselect());
bindRange("#zoom", "zoom", "#zoomOut", (v) => v.toFixed(2).replace(/0$/, "") + "×");
bindRange("#offset", "offset", "#offsetOut", (v) => (Math.abs(v) < 0.05 ? "centre" : v < 0 ? "gauche" : "droite"));
bindSeg("#length", "length", () => reselect());
bindSeg("#format", "format");
bindSeg("#quality", "quality");
bindText("#title", "title");
bindText("#handle", "handle");

/* ---------------------------------------------------------------- fichier */
const fileInput = $("#file");
fileInput.addEventListener("change", () => fileInput.files[0] && loadFile(fileInput.files[0]));
$("#change").addEventListener("click", () => fileInput.click());
const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => {
  const f = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|m4v)$/i.test(f.name));
  if (f) loadFile(f);
});

async function loadFile(file) {
  if (state.url) URL.revokeObjectURL(state.url);
  Object.assign(state, { file, url: URL.createObjectURL(file), clips: [], signals: null, score: null });
  preview.src = state.url;
  work.src = state.url;
  renderer.setSource(state.url);
  $("#drop").hidden = true;
  $("#player").hidden = false;
  $("#results").hidden = true;
  $("#analyze").disabled = true;
  await new Promise((resolve, reject) => {
    preview.addEventListener("loadedmetadata", resolve, { once: true });
    preview.addEventListener("error", () => reject(new Error("format")), { once: true });
  }).catch(() => {
    $("#fileinfo").textContent = "Format non lisible par ce navigateur (essaie MP4 H.264).";
  });
  state.duration = preview.duration;
  if (!isFinite(state.duration) || !state.duration) return;
  $("#fileinfo").textContent = `${file.name} · ${fmt(state.duration)} · ${(file.size / 1e6).toFixed(0)} Mo`;
  $("#analyze").disabled = false;
  if (isIOS && file.size > 1.2e9) toast("Vidéo lourde : l'analyse audio peut échouer sur iPhone");
}

/* ---------------------------------------------------------------- analyse */
function setProgress(p, text) {
  $("#progress").hidden = false;
  $("#progress .bar i").style.width = Math.round(p * 100) + "%";
  if (text) $("#progressText").textContent = text;
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}

$("#analyze").addEventListener("click", async () => {
  if (state.busy || !state.file) return;
  // iOS : « débloque » la vidéo de travail pendant le geste de l'utilisateur
  const p = work.play();
  if (p && p.then) p.then(() => work.pause()).catch(() => {});
  state.busy = true;
  $("#analyze").disabled = true;
  keepAwake(true);
  const dur = state.duration;
  const signals = {};
  let level = new Float32Array(Math.ceil(dur));
  try {
    setProgress(0, "Analyse du son…");
    try {
      const a = await analyzeAudio(state.file, dur, (x) => setProgress(x * 0.4, "Analyse du son…"));
      signals.audio = a.energy;
      level = a.level;
    } catch (e) {
      console.warn(e);
      toast("Son non analysable : analyse de l'image seulement");
    }
    if (work.readyState < 2) await new Promise((r) => { work.addEventListener("loadeddata", r, { once: true }); setTimeout(r, 4000); });
    signals.motion = await analyzeMotion(work, dur, (x) => setProgress(0.4 + x * 0.55, `Analyse de l'image… ${Math.round(x * 100)} %`));
    state.signals = signals;
    state.level = level;
    state.score = combine(signals);
    reselect();
    setProgress(1, "Terminé");
    setTimeout(() => ($("#progress").hidden = true), 800);
  } catch (e) {
    console.error(e);
    setProgress(0, "Erreur : " + e.message);
  } finally {
    state.busy = false;
    $("#analyze").disabled = false;
    $("#analyze").textContent = "Relancer l'analyse";
    keepAwake(false);
  }
});

function reselect() {
  if (!state.score) return;
  const keep = state.clips.filter((c) => c.manual || c.blob);
  const auto = pickClips(state.score, state.signals, state.level, {
    count: settings.count, length: Math.min(settings.length, Math.floor(state.duration)),
  });
  // garde les clips déjà exportés / ajoutés à la main, complète avec les meilleurs
  const free = auto.filter((c) => !keep.some((k) => c.start < k.end && k.start < c.end));
  state.clips = [...keep, ...free].slice(0, Math.max(settings.count, keep.length));
  renumber();
  $("#results").hidden = false;
  renderClips();
  drawTimeline();
}

function renumber() {
  state.clips.sort((a, b) => b.score - a.score);
  state.clips.forEach((c, i) => (c.rank = i + 1));
}

/* ---------------------------------------------------------------- timeline */
const tl = $("#timeline");
function drawTimeline() {
  if (!state.score || tl.offsetParent === null) return;
  const dpr = window.devicePixelRatio || 1;
  const W = tl.clientWidth, H = tl.clientHeight;
  tl.width = W * dpr; tl.height = H * dpr;
  const ctx = tl.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const s = state.score, n = s.length, dur = state.duration;
  const x = (t) => (t / dur) * W;

  for (const c of state.clips) {
    ctx.fillStyle = c.manual ? "rgba(61,220,151,0.18)" : "rgba(255,61,139,0.2)";
    ctx.fillRect(x(c.start), 0, Math.max(2, x(c.end) - x(c.start)), H);
  }
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, "#ff3d8b");
  grad.addColorStop(1, "#ffb347");
  ctx.beginPath();
  ctx.moveTo(0, H);
  const cols = Math.min(W, n);
  for (let i = 0; i < cols; i++) {
    const a = Math.floor((i / cols) * n), b = Math.max(a + 1, Math.floor(((i + 1) / cols) * n));
    let m = 0;
    for (let j = a; j < b; j++) m = Math.max(m, s[j]);
    ctx.lineTo((i / cols) * W, H - 4 - m * (H - 18));
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.85;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.font = "700 11px system-ui, sans-serif";
  ctx.fillStyle = "#fff";
  for (const c of state.clips) ctx.fillText("#" + c.rank, x(c.start) + 3, 12);
  ctx.fillStyle = "#fff";
  ctx.fillRect(x(preview.currentTime || 0) - 1, 0, 2, H);
}
window.addEventListener("resize", drawTimeline);
preview.addEventListener("timeupdate", () => {
  drawTimeline();
  if (previewEnd !== null && preview.currentTime >= previewEnd) { preview.pause(); previewEnd = null; }
});
tl.addEventListener("pointerdown", (e) => {
  const r = tl.getBoundingClientRect();
  previewEnd = null;
  preview.currentTime = ((e.clientX - r.left) / r.width) * state.duration;
});

$("#addClip").addEventListener("click", () => {
  if (!state.score) return;
  const len = Math.min(settings.length, Math.floor(state.duration));
  const start = Math.max(0, Math.min(Math.round(preview.currentTime - len * 0.35), Math.floor(state.duration) - len));
  const end = start + len;
  state.clips = state.clips.filter((c) => !(c.start < end && start < c.end) || c.blob);
  let sc = 0;
  for (let i = start; i < end; i++) sc += state.score[i] || 0;
  state.clips.push({ start, end, peak: Math.round(preview.currentTime), score: Math.round((sc / len) * 1000) / 10, reasons: ["Ajouté à la main"], manual: true });
  renumber();
  renderClips();
  drawTimeline();
  toast("Clip ajouté");
});

/* ---------------------------------------------------------------- clips */
let previewEnd = null;
async function playClip(c) {
  previewEnd = c.end;
  preview.currentTime = c.start;
  try { await preview.play(); } catch {}
  $("#player").scrollIntoView({ behavior: "smooth", block: "start" });
}

const thumbCache = new Map();
async function thumbnail(t) {
  const key = state.url + "@" + t;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const p = (async () => {
    await seek(work, t + 0.3);
    const cv = document.createElement("canvas");
    cv.width = 224; cv.height = Math.round((224 * (work.videoHeight || 9)) / (work.videoWidth || 16));
    cv.getContext("2d").drawImage(work, 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", 0.7);
  })();
  thumbCache.set(key, p);
  return p;
}
let thumbQueue = Promise.resolve();

function renderClips() {
  const box = $("#clips");
  box.innerHTML = "";
  $("#clipsTitle").textContent = state.clips.length ? `Meilleurs moments (${state.clips.length})` : "Aucun moment fort détecté";
  const maxScore = Math.max(1, ...state.clips.map((c) => c.score));
  for (const c of state.clips) {
    const el = document.createElement("div");
    el.className = "clip";
    el.innerHTML = `
      <div class="thumb"><img alt="" /><span class="rank">#${c.rank}</span></div>
      <div>
        <div class="times">${fmt(c.start)} → ${fmt(c.end)} <span class="muted small">· ${Math.round(c.end - c.start)} s</span></div>
        <div class="score"><i style="width:${Math.round((c.score / maxScore) * 100)}%"></i></div>
        <div class="chips">${c.reasons.map((r) => `<span class="chip">${r}</span>`).join("")}</div>
      </div>
      <div class="actions">
        <button class="ghost small" data-a="play">▶ Aperçu</button>
        <button class="ghost small" data-a="s-" aria-label="Début plus tôt">⇤ −1</button>
        <button class="ghost small" data-a="s+" aria-label="Début plus tard">+1</button>
        <button class="ghost small" data-a="e-" aria-label="Fin plus tôt">−1</button>
        <button class="ghost small" data-a="e+" aria-label="Fin plus tard">+1 ⇥</button>
        <button class="ghost small" data-a="del" aria-label="Supprimer">✕</button>
        <span class="spacer"></span>
        <button class="ghost small export" data-a="export">Exporter</button>
      </div>
      <div class="out" hidden></div>`;
    el.addEventListener("click", (e) => {
      const a = e.target.closest("button")?.dataset.a;
      if (!a) return;
      const max = state.duration;
      if (a === "play") playClip(c);
      if (a === "s-") c.start = Math.max(0, c.start - 1);
      if (a === "s+") c.start = Math.min(c.end - 3, c.start + 1);
      if (a === "e-") c.end = Math.max(c.start + 3, c.end - 1);
      if (a === "e+") c.end = Math.min(max, c.end + 1);
      if (a.startsWith("s") || a.startsWith("e")) {
        c.blob = null;
        el.querySelector(".times").innerHTML = `${fmt(c.start)} → ${fmt(c.end)} <span class="muted small">· ${Math.round(c.end - c.start)} s</span>`;
        drawTimeline();
        playClip({ start: a[0] === "s" ? c.start : Math.max(c.start, c.end - 3), end: c.end });
      }
      if (a === "del") { state.clips = state.clips.filter((x) => x !== c); renumber(); renderClips(); drawTimeline(); }
      if (a === "export") { renderer.unlock(); exportClips([c]); }
    });
    c.el = el;
    box.appendChild(el);
    if (c.blob) showResult(c);
    thumbQueue = thumbQueue.then(() => thumbnail(c.peak).then((src) => (el.querySelector("img").src = src)).catch(() => {}));
  }
}

$("#exportAll").addEventListener("click", () => {
  if (!state.clips.length) return;
  renderer.unlock();
  exportClips(state.clips.filter((c) => !c.blob));
});

async function exportClips(list) {
  if (state.busy) return toast("Un export est déjà en cours");
  state.busy = true;
  keepAwake(true);
  document.querySelectorAll(".export, #exportAll, #analyze").forEach((b) => (b.disabled = true));
  try {
    await thumbQueue;
    for (const c of list) {
      const out = c.el.querySelector(".out");
      out.hidden = false;
      out.innerHTML = `<div class="progress"><div class="bar"><i></i></div><div class="small muted">Export… garde l'écran allumé</div></div>`;
      const bar = out.querySelector(".bar i");
      try {
        const title = settings.title ? settings.title.replaceAll("{n}", c.rank) : "";
        c.blob = await renderer.record(c, { ...settings, title }, (p) => (bar.style.width = Math.round(p * 100) + "%"));
        showResult(c);
      } catch (e) {
        console.error(e);
        out.innerHTML = `<span class="small" style="color:#ff8fb8">Échec : ${e.message}</span>`;
      }
    }
  } finally {
    state.busy = false;
    keepAwake(false);
    document.querySelectorAll(".export, #exportAll, #analyze").forEach((b) => (b.disabled = false));
  }
}

function showResult(c) {
  const out = c.el.querySelector(".out");
  out.hidden = false;
  const ext = c.blob.type.includes("mp4") ? "mp4" : "webm";
  const base = (state.file.name.replace(/\.[^.]+$/, "") || "clip").replace(/[^\w-]+/g, "_").slice(0, 40);
  const name = `${base}_clip${String(c.rank).padStart(2, "0")}.${ext}`;
  const file = new File([c.blob], name, { type: c.blob.type });
  if (c.href) URL.revokeObjectURL(c.href);
  c.href = URL.createObjectURL(c.blob);
  out.innerHTML = `<span class="small ok">✓ ${(c.blob.size / 1e6).toFixed(1)} Mo · ${ext.toUpperCase()}</span><span class="spacer" style="flex:1"></span>`;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    const sh = document.createElement("button");
    sh.className = "ghost small";
    sh.textContent = "Partager / Enregistrer";
    sh.onclick = () => navigator.share({ files: [file], title: name }).catch(() => {});
    out.appendChild(sh);
  }
  const a = document.createElement("a");
  a.className = "ghost small";
  a.href = c.href;
  a.download = name;
  a.textContent = "Télécharger";
  out.appendChild(a);
}

$("#copyCaption").addEventListener("click", async () => {
  const t = $("#caption").value;
  try { await navigator.clipboard.writeText(t); toast("Légende copiée"); }
  catch { $("#caption").select(); document.execCommand("copy"); toast("Légende copiée"); }
});

/* ---------------------------------------------------------------- tendances */
const keyInput = $("#ytKey");
keyInput.value = store.get("ytKey", "");
$("#query").value = store.get("query", "GTA 6");
const keyState = () => ($("#keyState").textContent = keyInput.value ? "· enregistrée" : "· requise");
keyState();
if (!keyInput.value) $("#keyBox").open = true;
keyInput.addEventListener("input", () => { store.set("ytKey", keyInput.value.trim()); keyState(); });

$("#searchBtn").addEventListener("click", async () => {
  const msg = $("#trendMsg");
  const key = keyInput.value.trim();
  const query = $("#query").value.trim();
  store.set("query", query);
  if (!key) { msg.hidden = false; msg.className = "notice warn"; msg.textContent = "Ajoute d'abord ta clé API YouTube (gratuite)."; $("#keyBox").open = true; return; }
  msg.hidden = false; msg.className = "notice"; msg.textContent = "Recherche…";
  $("#trends").innerHTML = "";
  try {
    const rows = await findTrending({ key, query, days: +$("#days").value, lang: $("#lang").value });
    msg.hidden = rows.length > 0;
    msg.textContent = "Aucun résultat.";
    $("#trends").innerHTML = rows.slice(0, 30).map((r, i) => `
      <a class="trend" href="${r.url}" target="_blank" rel="noopener">
        <img src="${r.thumb}" alt="" loading="lazy" />
        <div>
          <div class="t">${i + 1}. ${escapeHtml(r.title)}</div>
          <div class="small muted">${escapeHtml(r.channel)} · ${fmt(r.duration)}</div>
          <div class="small"><span class="vph">${compact(r.vph)} vues/h</span> <span class="muted">· ${compact(r.views)} vues · ${r.ageH < 48 ? Math.round(r.ageH) + " h" : Math.round(r.ageH / 24) + " j"}</span></div>
        </div>
      </a>`).join("");
  } catch (e) {
    msg.className = "notice err";
    msg.textContent = "Erreur YouTube : " + e.message;
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------------------------------------------------------- PWA */
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
window.__clipforge = { state, settings, pickMime }; // debug
