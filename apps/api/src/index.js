const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const WSL_DISTRO = process.env.WSL_DISTRO || "Ubuntu";

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "10mb" }));

function toWslPath(p) {
  if (process.platform === "win32") {
    return p.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
  }
  return p;
}
function tmpFile(ext) {
  return path.join(os.tmpdir(), `va_${crypto.randomBytes(6).toString("hex")}.${ext}`);
}
function cleanup(...files) {
  for (const f of files) try { fs.unlinkSync(f); } catch {}
}
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const [cmd, fullArgs] = process.platform === "win32"
      ? ["wsl", ["-d", WSL_DISTRO, "--", "ffmpeg", ...args]]
      : ["ffmpeg", args];
    execFile(cmd, fullArgs, { maxBuffer: 100 * 1024 * 1024 }, (err, _, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}
function ffprobe(args) {
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

async function extractFrames(wslIn, duration, count) {
  if (!count || count <= 0) count = 1;
  if (!duration || duration <= 0) return [];
  const framesDir = path.join(os.tmpdir(), `frames_${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(framesDir);
  const interval = duration / count;
  try {
    // scale=320:-2 preserves original aspect ratio (height auto-calculated, divisible by 2)
    // -loglevel error suppresses the version banner so errors are readable
    await ffmpeg(["-loglevel", "error", "-i", wslIn, "-vf", `fps=1/${interval},scale=320:-2`, "-frames:v", String(count), `${toWslPath(framesDir)}/frame%04d.jpg`]);
    const frames = fs.readdirSync(framesDir)
      .filter(f => f.endsWith(".jpg")).sort()
      .map((f, i) => ({
        timestamp: Math.round(interval * i * 10) / 10,
        base64: `data:image/jpeg;base64,${fs.readFileSync(path.join(framesDir, f)).toString("base64")}`
      }));
    return frames;
  } finally {
    try { fs.rmSync(framesDir, { recursive: true }); } catch {}
  }
}

// Multi-agent editing pipeline
const { runEditPipeline } = require("./ai/agents");

/**
 * Probe video dimensions and frame rate via ffprobe.
 */
async function probeVideoMeta(wslIn, duration) {
  try {
    const json = await ffprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", wslIn]);
    const data = JSON.parse(json);
    const stream = data.streams?.[0] || {};
    let fps = 30;
    if (stream.r_frame_rate) {
      const [num, den] = stream.r_frame_rate.split("/").map(Number);
      if (num && den) fps = Math.round(num / den);
    }
    return { duration, fps, width: stream.width || 0, height: stream.height || 0 };
  } catch {
    return { duration, fps: 30, width: 0, height: 0 };
  }
}

/**
 * Probe whether the source video codec is universally compatible with
 * consumer players (Windows Movies & TV, QuickTime, mobile, etc.).
 *
 * Returns true when stream copy is safe. Returns false when re-encoding
 * to H.264 yuv420p is required for the output to be playable everywhere.
 */
async function probeCanStreamCopy(wslIn) {
  try {
    const json = await ffprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,profile", "-of", "json", wslIn]);
    const data = JSON.parse(json);
    const stream = data.streams?.[0] || {};
    const codec = (stream.codec_name || "").toLowerCase();
    const pixFmt = (stream.pix_fmt || "").toLowerCase();
    const profile = (stream.profile || "").toLowerCase();

    // Only H.264 with yuv420p (8-bit 4:2:0) is universally compatible.
    // HEVC, VP9, AV1, and unusual H.264 profiles/pixel formats need re-encode.
    if (codec !== "h264") {
      console.log(`[COMPAT] Source codec "${codec}" is not H.264 — will re-encode`);
      return false;
    }
    if (pixFmt && pixFmt !== "yuv420p") {
      console.log(`[COMPAT] Source pixel format "${pixFmt}" is not yuv420p — will re-encode`);
      return false;
    }
    // H.264 High 4:4:4 Predictive and similar non-standard profiles
    if (profile.includes("4:4:4") || profile.includes("hi444")) {
      console.log(`[COMPAT] Source H.264 profile "${profile}" is non-standard — will re-encode`);
      return false;
    }
    console.log(`[COMPAT] Source is H.264/${pixFmt}/${profile} — stream copy is safe`);
    return true;
  } catch {
    // If probing fails, re-encode to be safe
    console.log("[COMPAT] Probe failed — will re-encode for safety");
    return false;
  }
}

/**
 * Render an EditPlan to a video file.
 *
 * Uses stream copy for hard_cut transitions when the source codec is universally
 * compatible (H.264 yuv420p). Otherwise re-encodes to H.264 High Profile yuv420p
 * to guarantee playback on all players (Windows, macOS, mobile).
 *
 * When re-encoding for transitions, preserves original resolution exactly.
 */
async function renderEditPlan(wslIn, editPlan, wslOut, tmpDir) {
  const segments = editPlan.segments || [];
  if (!segments.length) throw new Error("EditPlan has no segments");

  // Validate segment boundaries
  for (const seg of segments) {
    if (typeof seg.src_in !== "number" || typeof seg.src_out !== "number" ||
        !isFinite(seg.src_in) || !isFinite(seg.src_out) ||
        seg.src_in < 0 || seg.src_out <= seg.src_in) {
      throw new Error("Invalid segment boundaries");
    }
  }

  // Quality Guard render settings — use quality_guard-approved constraints
  const rc = editPlan.render_constraints || {};
  const qCodec = rc.codec || "libx264";
  const qCrf = String(rc.crf || 18);
  const qPreset = rc.preset || "medium";
  const qPixFmt = rc.pixel_format || "yuv420p";
  const qFpsMode = rc.fps_mode || "cfr";

  // Check if source codec allows stream copy
  const canCopy = await probeCanStreamCopy(wslIn);
  const reencodeArgs = ["-c:v", qCodec, "-crf", qCrf, "-preset", qPreset, "-pix_fmt", qPixFmt, "-movflags", "+faststart"];
  const copyOrReencode = canCopy ? ["-c", "copy"] : reencodeArgs;
  const copyLabel = canCopy ? "stream copy" : "re-encode (compat)";

  // Build a lookup of transitions by source segment id
  const transMap = {};
  for (const t of (editPlan.transitions || [])) {
    transMap[t.from] = t;
  }

  const needsReencode = (editPlan.transitions || []).some(t => t.type !== "hard_cut");

  // Single segment, no soft transitions
  if (segments.length === 1 && !needsReencode) {
    const seg = segments[0];
    console.log(`[RENDER] Single segment: ${seg.src_in}s → ${seg.src_out}s (${copyLabel})`);
    await ffmpeg(["-y", "-loglevel", "error", "-ss", String(seg.src_in), "-i", wslIn, "-t", String(seg.src_out - seg.src_in), ...copyOrReencode, "-avoid_negative_ts", "make_zero", wslOut]);
    return;
  }

  // All hard cuts — concat
  if (!needsReencode) {
    const segFiles = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segPath = path.join(tmpDir, `seg_${i}.mp4`);
      console.log(`[RENDER] Segment ${seg.id}: ${seg.src_in}s → ${seg.src_out}s (${copyLabel})`);
      await ffmpeg(["-y", "-loglevel", "error", "-ss", String(seg.src_in), "-i", wslIn, "-t", String(seg.src_out - seg.src_in), ...copyOrReencode, "-avoid_negative_ts", "make_zero", toWslPath(segPath)]);
      segFiles.push(segPath);
    }
    const concatFile = path.join(tmpDir, "concat.txt");
    fs.writeFileSync(concatFile, segFiles.map(f => `file '${toWslPath(f)}'`).join("\n"));
    await ffmpeg(["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", toWslPath(concatFile), "-c", "copy", "-movflags", "+faststart", wslOut]);
    for (const f of [...segFiles, concatFile]) try { fs.unlinkSync(f); } catch {}
    return;
  }

  // Has soft transitions — need to re-encode with filter_complex.
  // Uses xfade for ALL transitions when soft transitions are present
  // (hard_cut becomes a very short fade to keep the filter graph uniform).
  const FADE_DURATION = 0.5; // seconds for soft transition overlap

  // Extract each segment to its own re-encoded file (needed for uniform filter graph)
  const segFiles = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segPath = path.join(tmpDir, `seg_${i}.mp4`);
    console.log(`[RENDER] Extracting segment ${seg.id}: ${seg.src_in}s → ${seg.src_out}s`);
    await ffmpeg(["-y", "-loglevel", "error", "-ss", String(seg.src_in), "-i", wslIn, "-t", String(seg.src_out - seg.src_in), "-c", "copy", "-avoid_negative_ts", "make_zero", toWslPath(segPath)]);
    segFiles.push(segPath);
  }

  // Probe whether the first segment has audio
  let hasAudio = false;
  try {
    const audioProbe = await ffprobe(["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", toWslPath(segFiles[0])]);
    hasAudio = audioProbe.trim().length > 0;
  } catch { hasAudio = false; }

  // Build input args as array for execFile
  const inputArgs = segFiles.flatMap(f => ["-i", toWslPath(f)]);

  // Map transition type to xfade name
  const xfadeType = (type) => {
    switch (type) {
      case "dissolve": return "dissolve";
      case "fade": return "fade";
      case "dip_to_black": return "fadeblack";
      case "wipe": return "wipeleft";
      default: return "fade";
    }
  };

  // Calculate actual segment durations from extracted files (more reliable)
  const segDurations = segments.map(s => s.src_out - s.src_in);

  // Build the xfade filter chain. Every transition uses xfade to keep
  // a uniform filter graph (no mixing concat + xfade which is invalid).
  // For "hard_cut" transitions, use a very short fade (0.001s) that is invisible.
  let filterParts = [];
  let audioParts = [];
  let lastVideoLabel = "[0:v]";
  let lastAudioLabel = "[0:a]";
  let cumulativeOffset = segDurations[0];

  for (let i = 0; i < segments.length - 1; i++) {
    const trans = transMap[segments[i].id];
    const tType = trans?.type || "hard_cut";

    // Use real fade for soft transitions, negligible fade for hard cuts
    const fadeDur = tType === "hard_cut" ? 0.001 : FADE_DURATION;
    const offset = Math.max(0, cumulativeOffset - fadeDur);
    const outLabel = `[v${i + 1}]`;
    const aOutLabel = `[a${i + 1}]`;

    filterParts.push(`${lastVideoLabel}[${i + 1}:v]xfade=transition=${xfadeType(tType)}:duration=${fadeDur}:offset=${offset.toFixed(3)}${outLabel}`);
    if (hasAudio) {
      audioParts.push(`${lastAudioLabel}[${i + 1}:a]acrossfade=d=${fadeDur}${aOutLabel}`);
      lastAudioLabel = aOutLabel;
    }
    lastVideoLabel = outLabel;

    // Track cumulative position: next segment starts at (offset + fadeDur) + next segment's duration
    // but xfade overlaps by fadeDur, so net position = offset + segDurations[i+1]
    cumulativeOffset = offset + segDurations[i + 1];
  }

  try {
    if (filterParts.length > 0) {
      const allFilters = hasAudio ? [...filterParts, ...audioParts] : filterParts;
      const filterComplex = allFilters.join(";");
      const audioArgs = hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"];
      console.log(`[RENDER] Re-encoding with transitions: ${filterParts.length} video filters, hasAudio=${hasAudio}`);
      console.log(`[RENDER] Quality settings: ${qCodec} crf=${qCrf} preset=${qPreset} pix_fmt=${qPixFmt}`);
      try {
        const finalMapArgs = hasAudio
          ? ["-map", lastVideoLabel, "-map", lastAudioLabel]
          : ["-map", lastVideoLabel];
        await ffmpeg(["-y", "-loglevel", "error", ...inputArgs, "-filter_complex", filterComplex, ...finalMapArgs, "-c:v", qCodec, "-crf", qCrf, "-preset", qPreset, "-pix_fmt", qPixFmt, "-fps_mode", qFpsMode, ...audioArgs, "-movflags", "+faststart", wslOut]);
      } catch (filterErr) {
        console.log(`[RENDER] Filter complex failed (${filterErr.message}), falling back to stream copy concat`);
        const concatFile = path.join(tmpDir, "concat.txt");
        fs.writeFileSync(concatFile, segFiles.map(f => `file '${toWslPath(f)}'`).join("\n"));
        await ffmpeg(["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", toWslPath(concatFile), "-c", "copy", "-movflags", "+faststart", wslOut]);
      }
    } else {
      const concatFile = path.join(tmpDir, "concat.txt");
      fs.writeFileSync(concatFile, segFiles.map(f => `file '${toWslPath(f)}'`).join("\n"));
      await ffmpeg(["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", toWslPath(concatFile), "-c", "copy", "-movflags", "+faststart", wslOut]);
    }
  } finally {
    for (const f of segFiles) try { fs.unlinkSync(f); } catch {}
  }
}

//  POST /api/analyze — multi-agent EditPlan (web client)
app.post("/api/analyze", async (req, res) => {
  const { duration, frames, width, height, fps } = req.body;
  try {
    const frameData = (frames || []).map((f, i) => ({
      timestamp: Math.round((duration / frames.length) * i * 10) / 10,
      base64: f
    }));
    const videoMeta = { duration, fps: fps || 30, width: width || 0, height: height || 0 };
    const editPlan = await runEditPipeline(videoMeta, frameData);

    // Backward-compatible response: include editPlan + legacy fields
    const firstSeg = editPlan.segments?.[0];
    res.json({
      editPlan,
      segments: editPlan.segments,
      summary: `${editPlan.segments.length} highlights selected`,
    });
  } catch (err) {
    console.error("[ANALYZE ERROR]", err);
    res.status(500).json({ error: "Analysis failed" });
  }
});

//  POST /api/trim 
app.post("/api/trim", express.raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
  if (!req.body || req.body.length === 0) return res.status(400).json({ error: "No video data received" });
  const inSec  = parseFloat(req.query.in  || "0");
  const outSec = parseFloat(req.query.out || "0");
  const name   = req.query.name || "highlight";
  if (isNaN(inSec) || isNaN(outSec) || !isFinite(inSec) || !isFinite(outSec)) return res.status(400).json({ error: "in/out must be valid finite numbers" });
  if (inSec < 0 || outSec < 0) return res.status(400).json({ error: "in/out must be non-negative" });
  if (outSec <= inSec) return res.status(400).json({ error: "out must be > in" });
  const tmpIn = tmpFile("mp4"), tmpOut = tmpFile("mp4");
  try {
    fs.writeFileSync(tmpIn, req.body);
    const wslIn = toWslPath(tmpIn), wslOut = toWslPath(tmpOut);
    const canCopy = await probeCanStreamCopy(wslIn);
    const codecArgs = canCopy
      ? ["-c", "copy"]
      : ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
    console.log(`Trimming: in=${inSec}s out=${outSec}s duration=${outSec - inSec}s (${canCopy ? "stream copy" : "re-encode"})`);
    await ffmpeg(["-y", "-loglevel", "error", "-ss", String(inSec), "-i", wslIn, "-t", String(outSec - inSec), ...codecArgs, "-avoid_negative_ts", "make_zero", wslOut]);
    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", `attachment; filename="${name}.mp4"`);
    res.sendFile(tmpOut, () => cleanup(tmpIn, tmpOut));
  } catch (err) {
    cleanup(tmpIn, tmpOut);
    console.error("[TRIM ERROR]", err);
    res.status(500).json({ error: "Trim failed" });
  }
});

//  POST /api/auto-edit — multi-agent highlight reel (bots + API clients)
app.post("/api/auto-edit", express.raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
  if (!req.body || req.body.length === 0) return res.status(400).json({ error: "No video data received" });
  const name   = req.query.name || "video";
  const tmpIn  = tmpFile("mp4"), tmpOut = tmpFile("mp4");
  const tmpDir = path.join(os.tmpdir(), `edit_${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmpDir);
  try {
    fs.writeFileSync(tmpIn, req.body);
    const wslIn = toWslPath(tmpIn), wslOut = toWslPath(tmpOut);

    // Probe video metadata
    const durationStr = await ffprobe(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wslIn]);
    const duration = parseFloat(durationStr);
    if (isNaN(duration) || duration <= 0) {
      cleanup(tmpIn, tmpOut);
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
      return res.status(400).json({ error: "Could not determine video duration" });
    }
    const videoMeta = await probeVideoMeta(wslIn, duration);
    console.log(`[AUTO-EDIT] Video: ${videoMeta.width}x${videoMeta.height}, ${videoMeta.fps}fps, ${duration.toFixed(1)}s`);

    // Extract frames for vision analysis
    const frameCount = Math.min(24, Math.max(6, Math.floor(duration / 5)));
    console.log(`[AUTO-EDIT] Extracting ${frameCount} frames...`);
    const frames = await extractFrames(wslIn, duration, frameCount);

    // Run multi-agent pipeline: Cut → Structure → Continuity → Transition → Constraints
    console.log("[AUTO-EDIT] Running multi-agent editing pipeline...");
    const editPlan = await runEditPipeline(videoMeta, frames);

    const segments = editPlan.segments || [];
    const finalDuration = segments.reduce((sum, s) => sum + (s.src_out - s.src_in), 0);
    console.log(`[AUTO-EDIT] EditPlan: ${segments.length} segments, ${finalDuration.toFixed(1)}s of ${duration.toFixed(1)}s (${(finalDuration / duration * 100).toFixed(0)}%)`);

    // Render the EditPlan to video
    console.log(`[AUTO-EDIT] Rendering ${segments.length} segments...`);
    await renderEditPlan(wslIn, editPlan, wslOut, tmpDir);

    const summary = `${segments.length} highlights selected`;
    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", `attachment; filename="${name}_highlights.mp4"`);
    res.set("X-AI-Summary", summary);
    res.set("X-Segments-Count", String(segments.length));
    res.sendFile(tmpOut, () => { cleanup(tmpIn, tmpOut); try { fs.rmSync(tmpDir, { recursive: true }); } catch {} });
  } catch (err) {
    cleanup(tmpIn, tmpOut);
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    console.error("[AUTO-EDIT ERROR]", err);
    res.status(500).json({ error: "Auto-edit failed" });
  }
});

app.get("/api/health", (_, res) => res.json({ status: "ok" }));

app.listen(3001, () => {
  console.log("VideoAgent API on http://localhost:3001");
  console.log("  POST /api/analyze   - AI analysis (web client)");
  console.log("  POST /api/trim      - Single segment trim");
  console.log("  POST /api/auto-edit - Full highlight reel (bots)");
});
