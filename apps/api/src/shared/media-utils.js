/**
 * Shared media utilities — single source of truth for ffmpeg/ffprobe wrappers,
 * temp file management, and WSL path conversion.
 *
 * Used by both the API server (index.js) and channel adapters (channels/base.js).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const WSL_DISTRO = process.env.WSL_DISTRO || "Ubuntu-24.04";

// ── Path helpers ────────────────────────────────────────────────────────────

function toWslPath(p) {
  if (process.platform === "win32") {
    return p.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
  }
  return p;
}

function tmpFile(ext) {
  return path.join(os.tmpdir(), `ve_${crypto.randomBytes(6).toString("hex")}.${ext}`);
}

function cleanup(...files) {
  for (const f of files) try { fs.unlinkSync(f); } catch {}
}

// ── FFmpeg / FFprobe wrappers ───────────────────────────────────────────────

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const [cmd, fullArgs] = process.platform === "win32"
      ? ["wsl", ["-d", WSL_DISTRO, "--", "ffmpeg", ...args]]
      : ["ffmpeg", args];
    console.log(`[FFMPEG] ${cmd} ${fullArgs.join(" ")}`);
    const start = Date.now();
    execFile(cmd, fullArgs, { maxBuffer: 100 * 1024 * 1024 }, (err, _, stderr) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (err) {
        console.log(`[FFMPEG] FAILED after ${elapsed}s: ${(stderr || err.message).slice(0, 300)}`);
        reject(new Error(stderr || err.message));
      } else {
        console.log(`[FFMPEG] OK in ${elapsed}s`);
        resolve();
      }
    });
  });
}

function ffprobe(args) {
  return new Promise((resolve, reject) => {
    const [cmd, fullArgs] = process.platform === "win32"
      ? ["wsl", ["-d", WSL_DISTRO, "--", "ffprobe", ...args]]
      : ["ffprobe", args];
    console.log(`[FFPROBE] ${cmd} ${fullArgs.join(" ")}`);
    execFile(cmd, fullArgs, (err, stdout, stderr) => {
      if (err) {
        console.log(`[FFPROBE] FAILED: ${(stderr || err.message).slice(0, 300)}`);
        reject(new Error(stderr || err.message));
      } else {
        console.log(`[FFPROBE] OK (${stdout.trim().length} chars)`);
        resolve(stdout.trim());
      }
    });
  });
}

// ── Video helpers ───────────────────────────────────────────────────────────

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v"]);

function isVideoFile(filename) {
  if (!filename) return false;
  const ext = path.extname(filename).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

/**
 * Compress video to fit within maxBytes.
 * Preserves original resolution, aspect ratio, rotation, frame rate.
 */
async function compressVideo(inputPath, outputPath, maxBytes) {
  const wslIn = toWslPath(inputPath);
  const wslOut = toWslPath(outputPath);

  const durationStr = await ffprobe(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wslIn]);
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

  await ffmpeg(["-y", "-i", wslIn, "-c:v", "libx264", "-b:v", vbr, "-maxrate", vbr, "-bufsize", bufsize, "-c:a", "aac", "-b:a", "128k", "-preset", "medium", "-map_metadata", "0", "-movflags", "+faststart", wslOut]);

  const outSize = fs.statSync(outputPath).size;
  if (outSize > maxBytes) {
    const ratio = targetBytes / outSize;
    const adjustedVbr = Math.floor((videoBitrate * ratio) / 1000) + "k";
    const adjustedBuf = Math.floor((videoBitrate * ratio * 2) / 1000) + "k";
    await ffmpeg(["-y", "-i", wslIn, "-c:v", "libx264", "-b:v", adjustedVbr, "-maxrate", adjustedVbr, "-bufsize", adjustedBuf, "-c:a", "aac", "-b:a", "128k", "-preset", "medium", "-map_metadata", "0", "-movflags", "+faststart", wslOut]);
  }
}

module.exports = {
  toWslPath,
  tmpFile,
  cleanup,
  ffmpeg,
  ffprobe,
  isVideoFile,
  compressVideo,
  VIDEO_EXTENSIONS,
};
