// ClipForge — moteur d'analyse 100 % navigateur (aucun serveur).
// Chaque signal est ramené à une valeur par seconde de vidéo.

export const WEIGHTS = { audio: 1.0, motion: 0.6 };

const REASONS = {
  audio: "Pic sonore",
  motion: "Action visuelle",
};

/* ------------------------------------------------------------------ audio */

/** Décode la piste audio en mono 8 kHz et renvoie, par seconde :
 *  - energy : intensité relative au niveau ambiant (z-score vs médiane glissante)
 *  - level  : niveau moyen en dB (pour caler les coupes sur les silences) */
export async function analyzeAudio(file, duration, onProgress = () => {}) {
  const n = Math.ceil(duration);
  onProgress(0.05);
  const buf = await file.arrayBuffer();
  onProgress(0.3);
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 8000, 8000); // decodeAudioData ré-échantillonne à 8 kHz → peu de mémoire
  const audio = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(buf, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
  onProgress(0.7);

  const sr = audio.sampleRate;
  const chans = [];
  for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
  const hop = Math.max(1, Math.floor(sr / 4)); // trames de 250 ms
  const frames = Math.floor(audio.length / hop);
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * hop;
    for (let i = 0; i < hop; i++) {
      let v = 0;
      for (const ch of chans) v += ch[base + i];
      v /= chans.length;
      sum += v * v;
    }
    db[f] = 20 * Math.log10(Math.sqrt(sum / hop) + 1e-5);
  }

  const peak = new Float32Array(n).fill(-100);
  const level = new Float32Array(n).fill(-100);
  for (let s = 0; s < n; s++) {
    let mx = -100, acc = 0, cnt = 0;
    for (let k = 0; k < 4; k++) {
      const f = s * 4 + k;
      if (f >= frames) break;
      mx = Math.max(mx, db[f]);
      acc += db[f];
      cnt++;
    }
    peak[s] = mx;
    level[s] = cnt ? acc / cnt : -100;
  }
  const baseline = rollingMedian(peak, 61);
  const sd = std(peak) + 1e-6;
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) energy[i] = Math.max(0, (peak[i] - baseline[i]) / sd);
  onProgress(1);
  return { energy, level };
}

/* ----------------------------------------------------------------- motion */

export function seek(video, t, timeout = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", finish);
      resolve();
    };
    video.addEventListener("seeked", finish);
    setTimeout(finish, timeout);
    video.currentTime = Math.max(0, Math.min(t, (video.duration || t) - 0.05));
  });
}

/** Échantillonne l'image (≤ 900 points) et mesure la différence entre images
 *  successives : beaucoup de mouvement / changements de plan = action. */
export async function analyzeMotion(video, duration, onProgress = () => {}, isCancelled = () => false) {
  const n = Math.ceil(duration);
  const out = new Float32Array(n);
  const step = Math.max(1, duration / 900);
  const W = 64, H = 36;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  let prev = null;
  const total = Math.ceil(duration / step);
  let i = 0;
  for (let t = Math.min(0.5, duration / 2); t < duration; t += step, i++) {
    if (isCancelled()) throw new Error("annulé");
    await seek(video, t);
    ctx.drawImage(video, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const g = new Float32Array(W * H);
    for (let p = 0, q = 0; p < d.length; p += 4, q++) g[q] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    if (prev) {
      let diff = 0;
      for (let q = 0; q < g.length; q++) diff += Math.abs(g[q] - prev[q]);
      diff /= g.length * 255;
      const a = Math.max(0, Math.floor(t - step / 2));
      const b = Math.min(n, Math.ceil(t + step / 2));
      for (let s = a; s < b; s++) out[s] = Math.max(out[s], diff);
    }
    prev = g;
    if (i % 5 === 0) onProgress(Math.min(1, i / total));
  }
  onProgress(1);
  return out;
}

/* ---------------------------------------------------------------- scoring */

export function combine(signals, weights = WEIGHTS) {
  const n = Math.max(...Object.values(signals).map((s) => s.length));
  const total = new Float32Array(n);
  let wsum = 0;
  for (const [name, sig] of Object.entries(signals)) {
    if (!sig || !sig.some((v) => v > 0)) continue;
    const w = weights[name] ?? 1;
    const s = normalize(smooth(sig, 3));
    for (let i = 0; i < s.length; i++) total[i] += w * s[i];
    wsum += w;
  }
  if (wsum) for (let i = 0; i < n; i++) total[i] /= wsum;
  return total;
}

/** Sélection gloutonne des meilleurs passages, sans chevauchement.
 *  Le pic est placé à `hook` (≈35 %) du clip : un peu de contexte, puis la chute. */
export function pickClips(score, signals, level, { count = 5, length = 30, gap = 10, hook = 0.35 } = {}) {
  const n = score.length;
  if (!n) return [];
  length = Math.max(5, Math.min(length, n));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + score[i];
  const windowMean = (a, b) => (prefix[b] - prefix[a]) / Math.max(1, b - a);

  const used = new Uint8Array(n);
  const order = Array.from(score.keys()).sort((a, b) => score[b] - score[a]);
  const floor = 0.25 * score[order[0]];
  const clips = [];
  for (const peak of order) {
    if (clips.length >= count || score[peak] < floor || score[peak] <= 0) break;
    if (used[peak]) continue;
    let start = Math.round(peak - hook * length);
    start = Math.max(0, Math.min(start, n - length));
    const lo = Math.max(0, start - gap), hi = Math.min(n, start + length + gap);
    let overlap = false;
    for (let i = lo; i < hi; i++) if (used[i]) { overlap = true; break; }
    if (overlap) continue;
    start = snapToPause(level, start, 2, 0, n);
    const end = Math.max(start + 5, snapToPause(level, start + length, 2, 0, n));
    const s = 0.7 * windowMean(start, end) + 0.3 * score[peak];
    clips.push({ start, end: Math.min(end, n), peak, score: Math.round(s * 1000) / 10, reasons: explain(signals, start, end) });
    for (let i = start; i < Math.min(end, n); i++) used[i] = 1;
  }
  clips.sort((a, b) => b.score - a.score);
  clips.forEach((c, i) => (c.rank = i + 1));
  return clips;
}

export function explain(signals, start, end) {
  const out = [];
  for (const [name, sig] of Object.entries(signals)) {
    if (!sig || !sig.some((v) => v > 0)) continue;
    const m = mean(sig);
    const seg = mean(sig.subarray(start, end));
    if (seg > 1.5 * (m + 1e-9)) out.push(REASONS[name] || name);
  }
  return out.length ? out : ["Intensité élevée"];
}

function snapToPause(level, t, radius, lower, upper) {
  if (!level || !level.length) return t;
  const a = Math.max(lower, t - radius);
  const b = Math.min(upper, level.length, t + radius + 1);
  if (b <= a) return Math.min(t, upper);
  let best = a;
  for (let i = a; i < b; i++) if (level[i] < level[best]) best = i;
  return best;
}

/* ---------------------------------------------------------------- helpers */

export function mean(x) {
  let s = 0;
  for (const v of x) s += v;
  return x.length ? s / x.length : 0;
}
function std(x) {
  const m = mean(x);
  let s = 0;
  for (const v of x) s += (v - m) ** 2;
  return Math.sqrt(s / Math.max(1, x.length));
}
function percentile(x, p) {
  const a = Float32Array.from(x).sort();
  return a[Math.min(a.length - 1, Math.floor((p / 100) * (a.length - 1)))];
}
export function normalize(x) {
  let mn = Infinity;
  for (const v of x) mn = Math.min(mn, v);
  const hi = percentile(x, 99) || Math.max(...x);
  const out = new Float32Array(x.length);
  if (!(hi > mn)) return out;
  for (let i = 0; i < x.length; i++) out[i] = Math.min(1, Math.max(0, (x[i] - mn) / (hi - mn)));
  return out;
}
export function smooth(x, k = 3) {
  const out = new Float32Array(x.length);
  const h = Math.floor(k / 2);
  for (let i = 0; i < x.length; i++) {
    let s = 0, c = 0;
    for (let j = i - h; j <= i + h; j++) if (j >= 0 && j < x.length) { s += x[j]; c++; }
    out[i] = s / c;
  }
  return out;
}
function rollingMedian(x, win) {
  const h = Math.floor(win / 2);
  const out = new Float32Array(x.length);
  const buf = [];
  for (let i = 0; i < x.length; i++) {
    buf.length = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(x.length - 1, i + h); j++) buf.push(x[j]);
    buf.sort((a, b) => a - b);
    out[i] = buf[buf.length >> 1];
  }
  return out;
}
export function fmt(t) {
  t = Math.max(0, Math.round(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
