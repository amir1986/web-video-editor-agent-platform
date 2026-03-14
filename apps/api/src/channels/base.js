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
const { tmpFile, cleanup, compressVideo } = require("../shared/media-utils");
const { processAutoEdit } = require("../shared/auto-edit-pipeline");

/**
 * Core video processing — shared by all channels.
 *
 * Calls the auto-edit pipeline directly (no HTTP loopback) since the bot
 * runs in the same process as the API server.
 *
 * @param {string}   inputPath    - Local path to downloaded video
 * @param {string}   videoName    - Original filename (without extension)
 * @param {number}   maxUpload    - Max upload bytes (0 = no limit)
 * @param {function} onProgress   - (message: string) => void
 * @param {object}   options      - { userId } for style engine (optional)
 * @returns {{ outputPath: string, summary: string, segCount: string, compressed: boolean, width: number, height: number, duration: number }}
 */
async function processVideo(inputPath, videoName, maxUpload, onProgress, options = {}) {
  const tmpCompressed = tmpFile("mp4");

  try {
    const inputSize = fs.statSync(inputPath).size;
    console.log(`[PROCESS] Input: ${(inputSize / 1024 / 1024).toFixed(1)}MB, name=${videoName}`);

    onProgress("Processing with AI... this may take a minute.");

    // Direct function call — no HTTP loopback needed since bot runs in-process
    const result = await processAutoEdit(inputPath, { name: videoName, userId: options.userId || null });
    const { metadata } = result;

    const summary = metadata.summary || "";
    const segCount = String(metadata.segments || "?");
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    const duration = metadata.duration || 0;
    const styleMode = metadata.styleMode || "discovery";
    const projectCount = metadata.projectCount || 0;

    // Compress if needed
    let outputPath = result.outputPath;
    let compressed = false;
    const outSize = fs.statSync(result.outputPath).size;

    if (maxUpload > 0 && outSize > maxUpload) {
      const outMB = (outSize / (1024 * 1024)).toFixed(1);
      onProgress(`Compressing video (${outMB}MB) to fit upload limit...`);
      await compressVideo(result.outputPath, tmpCompressed, maxUpload);
      cleanup(result.outputPath);
      outputPath = tmpCompressed;
      compressed = true;
    }

    // Clean up pipeline temp files (but not outputPath which caller uses)
    for (const f of result._tmpFiles) {
      try { fs.rmSync(f, { recursive: true }); } catch {}
    }

    return { outputPath, summary, segCount, compressed, width, height, duration, styleMode, projectCount, _tmpOut: result.outputPath, _tmpCompressed: tmpCompressed };
  } catch (err) {
    cleanup(tmpCompressed);
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

module.exports = { BaseChannel, processVideo, tmpFile, cleanup };
