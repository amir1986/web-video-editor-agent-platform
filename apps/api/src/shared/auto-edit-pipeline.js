/**
 * Core auto-edit pipeline — processes a video file through the multi-agent
 * AI pipeline and renders the result.
 *
 * This module is the single entry point for auto-editing, used by:
 *   - The HTTP API handler (POST /api/auto-edit)
 *   - Channel adapters (Telegram, Discord, etc.) via direct function call
 *
 * By exporting this function, channel adapters no longer need to make
 * HTTP loopback calls to localhost — they call processAutoEdit() directly.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { toWslPath, tmpFile, cleanup, ffmpeg, ffprobe } = require("./media-utils");

// Lazy-loaded to avoid circular dependency at require time.
// These are set by the API server via init().
let _runEditPipeline = null;
let _renderEditPlan = null;
let _probeVideoMeta = null;
let _probeSourceQuality = null;
let _extractFrames = null;
let _resolveStyle = null;
let _enqueueAutoEdit = null;

/**
 * Initialize the pipeline with dependencies from the API server.
 * Must be called once before processAutoEdit() can be used.
 */
function init(deps) {
  _runEditPipeline = deps.runEditPipeline;
  _renderEditPlan = deps.renderEditPlan;
  _probeVideoMeta = deps.probeVideoMeta;
  _probeSourceQuality = deps.probeSourceQuality;
  _extractFrames = deps.extractFrames;
  _resolveStyle = deps.resolveStyle;
  _enqueueAutoEdit = deps.enqueueAutoEdit;
}

/**
 * Process a video file through the full auto-edit pipeline.
 *
 * @param {string} inputPath   - Path to the input video file
 * @param {object} options     - { name, userId }
 * @returns {Promise<{ outputPath: string, metadata: object, _tmpFiles: string[] }>}
 *   The caller is responsible for cleaning up outputPath and _tmpFiles after use.
 */
async function processAutoEdit(inputPath, options = {}) {
  const { name = "video", userId = null } = options;

  return _enqueueAutoEdit(async () => {
    const tmpIn = tmpFile("mp4");
    const tmpOut = tmpFile("mp4");
    const tmpDir = path.join(os.tmpdir(), `edit_${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(tmpDir);

    try {
      // Copy input to temp location if it's not already a temp file
      if (inputPath !== tmpIn) {
        fs.copyFileSync(inputPath, tmpIn);
      }
      const inputSize = fs.statSync(tmpIn).size;
      console.log(`[AUTO-EDIT] Input file: ${(inputSize / 1024 / 1024).toFixed(1)}MB`);
      const wslIn = toWslPath(tmpIn);
      const wslOut = toWslPath(tmpOut);

      // Adaptive Style Engine (v2): resolve videographer style
      const styleResult = _resolveStyle(userId);
      if (userId) {
        console.log(`[AUTO-EDIT] Style: user=${userId}, mode=${styleResult.mode}, projects=${styleResult.profile?.projectCount || 0}`);
      }

      // Probe video metadata
      const durationStr = await ffprobe(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wslIn]);
      const duration = parseFloat(durationStr);
      if (isNaN(duration) || duration <= 0) {
        throw new Error("Could not determine video duration");
      }

      const sourceQuality = await _probeSourceQuality(wslIn);
      const videoMeta = await _probeVideoMeta(wslIn, duration);
      console.log(`[AUTO-EDIT] Video: ${videoMeta.width}x${videoMeta.height}, ${videoMeta.fps}fps, ${duration.toFixed(1)}s`);

      // Extract frames for vision analysis
      const frameCount = Math.min(24, Math.max(6, Math.floor(duration / 5)));
      console.log(`[AUTO-EDIT] Extracting ${frameCount} frames...`);
      const frames = await _extractFrames(wslIn, duration, frameCount);

      // Run multi-agent pipeline
      console.log("[AUTO-EDIT] Running multi-agent editing pipeline...");
      const editPlan = await _runEditPipeline(videoMeta, frames, sourceQuality, {
        videoPath: wslIn,
        styleContext: styleResult.styleContext,
      });

      const segments = editPlan.segments || [];
      const finalDuration = segments.reduce((sum, s) => sum + (s.src_out - s.src_in), 0);
      console.log(`[AUTO-EDIT] EditPlan: ${segments.length} segments, ${finalDuration.toFixed(1)}s of ${duration.toFixed(1)}s (${(finalDuration / duration * 100).toFixed(0)}%)`);

      // Render
      console.log(`[AUTO-EDIT] Rendering ${segments.length} segments...`);
      const renderStart = Date.now();
      await _renderEditPlan(wslIn, editPlan, wslOut, tmpDir, sourceQuality);
      const renderElapsed = ((Date.now() - renderStart) / 1000).toFixed(1);
      const outputSize = fs.statSync(tmpOut).size;
      console.log(`[AUTO-EDIT] Render done in ${renderElapsed}s`);
      console.log(`[AUTO-EDIT] Output: ${(outputSize / 1024 / 1024).toFixed(1)}MB (input was ${(inputSize / 1024 / 1024).toFixed(1)}MB, ratio: ${(outputSize / inputSize * 100).toFixed(0)}%)`);

      const summary = `${segments.length} highlights selected`;
      const metadata = {
        summary,
        segments: segments.length,
        width: videoMeta.width,
        height: videoMeta.height,
        duration: Math.round(finalDuration),
        styleMode: styleResult.mode,
        projectCount: styleResult.profile?.projectCount || 0,
      };

      return {
        outputPath: tmpOut,
        metadata,
        _tmpFiles: [tmpIn, tmpDir],
      };
    } catch (err) {
      cleanup(tmpIn, tmpOut);
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
      throw err;
    }
  });
}

module.exports = { init, processAutoEdit };
