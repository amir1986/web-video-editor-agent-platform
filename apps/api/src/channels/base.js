/**
 * Base channel adapter — shared interface and video processing logic
 * for all messaging platform integrations.
 *
 * Each adapter implements:
 *   name        — Human-readable channel name
 *   envKeys     — Required env vars (checked before start)
 *   maxUpload   — Platform's max upload size in bytes (0 = unlimited)
 *   start()     — Connect / begin polling
 *   stop()      — Disconnect gracefully
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { Agent, fetch: undiciFetch } = require("undici");

const WSL_DISTRO = process.env.WSL_DISTRO || "Ubuntu-24.04";
const API_URL = process.env.API_URL || "http://localhost:3001";

// ── Shared HTTP helper — fetch with timeout ─────────────────────────────────

/**
 * fetch() wrapper with a configurable timeout (default 2 min).
 * Prevents channel download/upload calls from hanging indefinitely.
 */
function fetchWithTimeout(url, options = {}, timeoutMs = 2 * 60 * 1000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function toWslPath(p) {
  if (process.platform === "win32") {
    return p.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
  }
  return p;
}

function tmpFile(ext) {
  return path.join(os.tmpdir(), `ch_${crypto.randomBytes(6).toString("hex")}.${ext}`);
}

function cleanup(...files) {
  for (const f of files) try { fs.unlinkSync(f); } catch {}
}

function ffmpegExec(args) {
  return new Promise((resolve, reject) => {
    const [cmd, fullArgs] = process.platform === "win32"
      ? ["wsl", ["-d", WSL_DISTRO, "--", "ffmpeg", ...args]]
      : ["ffmpeg", args];
    execFile(cmd, fullArgs, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function ffprobeExec(args) {
  return new Promise((resolve, reject) => {
    const [cmd, fullArgs] = process.platform === "win32"
      ? ["wsl", ["-d", WSL_DISTRO, "--", "ffprobe", ...args]]
      : ["ffprobe", args];
    execFile(cmd, fullArgs, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

/**
 * Compress video to fit within maxBytes.
 * Preserves original resolution, aspect ratio, rotation, frame rate.
 */
async function compressVideo(inputPath, outputPath, maxBytes) {
  const wslIn = toWslPath(inputPath);
  const wslOut = toWslPath(outputPath);

  const durationStr = await ffprobeExec(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wslIn]);
  const duration = parseFloat(durationStr);
  if (!duration || duration <= 0) {
    throw new Error("Could not determine video duration for compression");
  }

  const targetBytes = maxBytes * 0.95;
  const audioBitrate = 128 * 1024;
  const totalBitrate = (targetBytes * 8) / duration;
  const videoBitrate = Math.floor(totalBitrate - audioBitrate);

  if (videoBitrate < 100 * 1024) {
    throw new Error("Video too long to compress under size limit with acceptable quality");
  }

  const vbr = Math.floor(videoBitrate / 1000) + "k";
  const bufsize = Math.floor((videoBitrate * 2) / 1000) + "k";
  console.log(`[COMPRESS] duration=${duration.toFixed(1)}s, target=${(targetBytes / 1024 / 1024).toFixed(1)}MB, vbr=${vbr}`);

  await ffmpegExec(["-y", "-i", wslIn, "-c:v", "libx264", "-b:v", vbr, "-maxrate", vbr, "-bufsize", bufsize, "-c:a", "aac", "-b:a", "128k", "-preset", "medium", "-map_metadata", "0", "-movflags", "+faststart", wslOut]);

  const outSize = fs.statSync(outputPath).size;
  if (outSize > maxBytes) {
    const ratio = targetBytes / outSize;
    const adjustedVbr = Math.floor((videoBitrate * ratio) / 1000) + "k";
    const adjustedBuf = Math.floor((videoBitrate * ratio * 2) / 1000) + "k";
    await ffmpegExec(["-y", "-i", wslIn, "-c:v", "libx264", "-b:v", adjustedVbr, "-maxrate", adjustedVbr, "-bufsize", adjustedBuf, "-c:a", "aac", "-b:a", "128k", "-preset", "medium", "-map_metadata", "0", "-movflags", "+faststart", wslOut]);
  }
}

/**
 * Core video processing — shared by all channels.
 *
 * @param {string}   inputPath    - Local path to downloaded video
 * @param {string}   videoName    - Original filename (without extension)
 * @param {number}   maxUpload    - Max upload bytes (0 = no limit)
 * @param {function} onProgress   - (message: string) => void
 * @returns {{ outputPath: string, summary: string, segCount: string, compressed: boolean, width: number, height: number, duration: number }}
 */
async function processVideo(inputPath, videoName, maxUpload, onProgress) {
  const tmpOut = tmpFile("mp4");
  const tmpCompressed = tmpFile("mp4");

  try {
    const inputSize = fs.statSync(inputPath).size;
    console.log(`[PROCESS] Input: ${(inputSize / 1024 / 1024).toFixed(1)}MB, name=${videoName}`);

    onProgress("Processing with AI... this may take a minute.");

    const videoBuffer = fs.readFileSync(inputPath);
    // Use undici directly so we can set headersTimeout + bodyTimeout beyond
    // undici's 30s default. The API calls Claude which can take several minutes
    // on large files, so we need 10–15 min timeouts here.
    const agent = new Agent({ headersTimeout: 10 * 60 * 1000, bodyTimeout: 15 * 60 * 1000 });
    const res = await undiciFetch(`${API_URL}/api/auto-edit?name=${encodeURIComponent(videoName)}`, {
      method: "POST",
      headers: { "Content-Type": "video/mp4" },
      body: videoBuffer,
      dispatcher: agent,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API error ${res.status}: ${err}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(tmpOut, Buffer.from(arrayBuffer));

    const summary = res.headers.get("x-ai-summary") || "";
    const segCount = res.headers.get("x-segments-count") || "?";
    const width = parseInt(res.headers.get("x-video-width")) || 0;
    const height = parseInt(res.headers.get("x-video-height")) || 0;
    const duration = parseInt(res.headers.get("x-video-duration")) || 0;

    // Compress if needed
    let outputPath = tmpOut;
    let compressed = false;
    const outSize = fs.statSync(tmpOut).size;

    if (maxUpload > 0 && outSize > maxUpload) {
      const outMB = (outSize / (1024 * 1024)).toFixed(1);
      onProgress(`Compressing video (${outMB}MB) to fit upload limit...`);
      await compressVideo(tmpOut, tmpCompressed, maxUpload);
      outputPath = tmpCompressed;
      compressed = true;
    }

    return { outputPath, summary, segCount, compressed, width, height, duration, _tmpOut: tmpOut, _tmpCompressed: tmpCompressed };
  } catch (err) {
    cleanup(tmpOut, tmpCompressed);
    throw err;
  }
}

// ── Base class ──────────────────────────────────────────────────────────────

class BaseChannel {
  constructor() {
    this.name = "base";
    this.envKeys = [];
    this.maxUpload = 0;
  }

  /** Check if all required env vars are set */
  isConfigured() {
    return this.envKeys.every(k => !!process.env[k]);
  }

  /** Return missing env var names */
  missingEnv() {
    return this.envKeys.filter(k => !process.env[k]);
  }

  async start() { throw new Error("start() not implemented"); }
  async stop() {}
}

module.exports = { BaseChannel, processVideo, compressVideo, tmpFile, cleanup, toWslPath, API_URL, fetchWithTimeout };
