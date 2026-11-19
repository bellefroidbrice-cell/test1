// Export des clips dans le navigateur : la vidéo est redessinée sur un canvas 9:16
// (fond flouté, zoom, titre, pseudo) et enregistrée avec MediaRecorder.
// Fonctionne sur Chrome / Chromebook et Safari iOS ; le rendu se fait en temps réel.

import { seek } from "./engine.js";

const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4;codecs=avc1,opus",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

export function canExport() {
  return typeof MediaRecorder !== "undefined" && !!HTMLCanvasElement.prototype.captureStream;
}

export class Renderer {
  constructor() {
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.setAttribute("playsinline", "");
    this.video.preload = "auto";
    this.video.crossOrigin = "anonymous";
    this.audioCtx = null;
    this.audioDest = null;
    this.small = document.createElement("canvas");
  }

  setSource(url) {
    if (this.video.src !== url) this.video.src = url;
  }

  /** À appeler de façon SYNCHRONE dans un clic : iOS n'autorise le son/lecture
   *  qu'après un geste de l'utilisateur. */
  unlock() {
    if (!this.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        try {
          this.audioCtx = new AC();
          const src = this.audioCtx.createMediaElementSource(this.video);
          this.audioDest = this.audioCtx.createMediaStreamDestination();
          src.connect(this.audioDest); // pas vers les haut-parleurs : export silencieux
        } catch (e) {
          console.warn("Audio capture indisponible", e);
          this.audioCtx = null;
        }
      }
    }
    if (this.audioCtx && this.audioCtx.state === "suspended") this.audioCtx.resume();
    const p = this.video.play();
    if (p && p.then) p.then(() => this.video.pause()).catch(() => {});
  }

  size(opts) {
    const q = opts.quality === "1080" ? 1080 : 720;
    if (opts.format === "original") {
      const vw = this.video.videoWidth || 1280, vh = this.video.videoHeight || 720;
      const scale = Math.min(1, (q === 1080 ? 1920 : 1280) / Math.max(vw, vh));
      return [Math.round((vw * scale) / 2) * 2, Math.round((vh * scale) / 2) * 2];
    }
    return [q, Math.round((q * 16) / 9)];
  }

  drawFrame(ctx, W, H, opts) {
    const v = this.video;
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    if (opts.format === "vertical") {
      // fond : image réduite puis agrandie = flou bon marché, compatible partout
      const sw = 27, sh = 48;
      this.small.width = sw; this.small.height = sh;
      const sctx = this.small.getContext("2d");
      const cs = Math.max(sw / vw, sh / vh);
      sctx.drawImage(v, (sw - vw * cs) / 2, (sh - vh * cs) / 2, vw * cs, vh * cs);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.small, 0, 0, W, H);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, 0, W, H);
      const fw = W * opts.zoom;
      const fh = (fw * vh) / vw;
      ctx.drawImage(v, (W - fw) / 2 + opts.offset * (fw - W) / 2, (H - fh) / 2, fw, fh);
    } else if (opts.format === "crop") {
      const cs = Math.max(W / vw, H / vh) * opts.zoom;
      const dw = vw * cs, dh = vh * cs;
      ctx.drawImage(v, (W - dw) / 2 + opts.offset * (dw - W) / 2, (H - dh) / 2, dw, dh);
    } else {
      ctx.drawImage(v, 0, 0, W, H);
    }

    if (opts.title) drawText(ctx, opts.title, W, H * (opts.format === "original" ? 0.06 : 0.1), W * (opts.format === "original" ? 0.05 : 0.068), true);
    if (opts.handle) drawText(ctx, opts.handle, W, H * 0.92, W * 0.038, false, 0.85);
  }

  /** Enregistre le passage [start, end] et renvoie un Blob vidéo. */
  async record(clip, opts, onProgress = () => {}) {
    if (!canExport()) throw new Error("Ce navigateur ne sait pas exporter de vidéo (MediaRecorder absent).");
    const v = this.video;
    if (v.readyState < 1) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
    const [W, H] = this.size(opts);
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    await seek(v, clip.start);
    this.drawFrame(ctx, W, H, opts);

    const stream = canvas.captureStream(30);
    if (this.audioDest) this.audioDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    const mimeType = pickMime();
    const rec = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: opts.quality === "1080" ? 10_000_000 : 6_000_000,
      audioBitsPerSecond: 160_000,
    });
    const chunks = [];
    rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));

    const dur = clip.end - clip.start;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      v.pause();
      if (rec.state !== "inactive") rec.stop();
    };
    const tick = () => {
      if (finished) return;
      this.drawFrame(ctx, W, H, opts);
      onProgress(Math.min(1, (v.currentTime - clip.start) / dur));
      if (v.currentTime >= clip.end || v.ended) finish();
      else if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };
    // filet de sécurité si l'onglet passe en arrière-plan
    const guard = setInterval(() => {
      if (v.currentTime >= clip.end || v.ended) finish();
    }, 250);

    rec.start(1000);
    v.muted = false;
    await v.play();
    tick();
    if (v.requestVideoFrameCallback) requestAnimationFrame(tick); // rVFC peut rater la 1re frame
    await stopped;
    clearInterval(guard);
    onProgress(1);
    const type = (rec.mimeType || mimeType || "video/webm").split(";")[0];
    return new Blob(chunks, { type });
  }
}

function drawText(ctx, text, W, y, size, bold, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${bold ? 900 : 700} ${Math.round(size)}px "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  const lines = wrap(ctx, text, W * 0.88);
  const lh = size * 1.15;
  lines.forEach((line, i) => {
    ctx.lineWidth = size * 0.18;
    ctx.strokeStyle = "rgba(0,0,0,0.95)";
    ctx.strokeText(line, W / 2, y + i * lh);
    ctx.fillStyle = "#fff";
    ctx.fillText(line, W / 2, y + i * lh);
  });
  ctx.restore();
}

function wrap(ctx, text, max) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > max && line) {
        out.push(line);
        line = word;
      } else line = test;
    }
    if (line) out.push(line);
  }
  return out.slice(0, 4);
}
