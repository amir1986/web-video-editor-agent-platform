const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const WSL_DISTRO = process.env.WSL_DISTRO || "Ubuntu-24.04";

// ---------------------------------------------------------------------------
// Simple token-based authentication
// ---------------------------------------------------------------------------
const AUTH_SECRET = process.env.AUTH_SECRET || "";
const AUTH_ENABLED = !!AUTH_SECRET;

function generateToken(userId) {
  const payload = JSON.stringify({ uid: userId, iat: Date.now() });
  const hmac = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  return Buffer.from(payload).toString("base64url") + "." + hmac;
}

function verifyToken(token) {
  if (!AUTH_ENABLED) return { uid: "anonymous" };
  if (!token) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const payload = Buffer.from(payloadB64, "base64url").toString();
  const expected = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(payload);
    // Tokens expire after 24 hours
    if (Date.now() - data.iat > 86400000) return null;
    return data;
  } catch { return null; }
}

function authMiddleware(req, res, next) {
  if (!AUTH_ENABLED) return next();
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token;
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  req.user = user;
  next();
}

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

// Multi-agent editing pipeline with cookbook enhancements
const { runEditPipeline, setProgressCallback } = require("./ai/agents");

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
 * Probe the original video's full quality parameters.
 * These are saved and reused when creating the processed output so that
 * resolution, bitrate, frame-rate and audio settings match the source exactly.
 */
async function probeSourceQuality(wslIn) {
  try {
    const json = await ffprobe([
      "-v", "error",
      "-show_entries", "stream=codec_name,codec_type,width,height,r_frame_rate,bit_rate,pix_fmt,profile,level,sample_rate,channels",
      "-show_entries", "format=bit_rate",
      "-of", "json",
      wslIn,
    ]);
    const data = JSON.parse(json);
    const videoStream = (data.streams || []).find(s => s.codec_type === "video") || {};
    const audioStream = (data.streams || []).find(s => s.codec_type === "audio") || {};
    const format = data.format || {};

    // Video frame rate
    let fps = 30;
    if (videoStream.r_frame_rate) {
      const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
      if (num && den) fps = Math.round(num / den);
    }

    // Video bitrate: prefer stream-level, fall back to format-level (minus ~192k for audio)
    let videoBitrate = parseInt(videoStream.bit_rate) || 0;
    if (!videoBitrate && format.bit_rate) {
      videoBitrate = Math.max(0, parseInt(format.bit_rate) - 192000);
    }

    // Audio bitrate
    const audioBitrate = parseInt(audioStream.bit_rate) || 0;

    const result = {
      video: {
        codec: videoStream.codec_name || "",
        width: videoStream.width || 0,
        height: videoStream.height || 0,
        fps,
        bitrate: videoBitrate,
        pix_fmt: videoStream.pix_fmt || "yuv420p",
        profile: videoStream.profile || "",
      },
      audio: {
        codec: audioStream.codec_name || "",
        bitrate: audioBitrate,
        sample_rate: parseInt(audioStream.sample_rate) || 44100,
        channels: audioStream.channels || 2,
      },
    };
    console.log(`[PROBE] Source quality: ${result.video.width}x${result.video.height} ${result.video.fps}fps, v_bitrate=${result.video.bitrate}, a_bitrate=${result.audio.bitrate}, codec=${result.video.codec}/${result.video.pix_fmt}`);
    return result;
  } catch (err) {
    console.log(`[PROBE] Failed to probe source quality: ${err.message}`);
    return null;
  }
}

/**
 * Build ffmpeg encoding args that match the original source quality.
 * Uses the source video bitrate (ABR) instead of CRF so the output
 * has the same data-rate as the input — no quality guessing.
 */
function buildSourceMatchEncodingArgs(sourceQuality, rc) {
  const vArgs = [];
  const aArgs = [];

  // Video encoding — CRF 18 (visually lossless) capped at source bitrate
  vArgs.push("-c:v", rc?.codec || "libx264");
  if (sourceQuality?.video?.bitrate > 0) {
    const vbr = String(sourceQuality.video.bitrate);
    vArgs.push("-crf", String(rc?.crf || 18), "-maxrate", vbr, "-bufsize", String(sourceQuality.video.bitrate * 2));
  } else {
    vArgs.push("-crf", String(rc?.crf || 18));
  }
  vArgs.push("-preset", rc?.preset || "medium");
  vArgs.push("-pix_fmt", rc?.pixel_format || "yuv420p");

  // Preserve resolution explicitly
  if (sourceQuality?.video?.width > 0 && sourceQuality?.video?.height > 0) {
    vArgs.push("-s", `${sourceQuality.video.width}x${sourceQuality.video.height}`);
  }

  // Preserve frame rate explicitly
  if (sourceQuality?.video?.fps > 0) {
    vArgs.push("-r", String(sourceQuality.video.fps));
  }

  vArgs.push("-movflags", "+faststart");

  // Audio encoding — match source bitrate, sample rate, channels
  if (sourceQuality?.audio?.bitrate > 0) {
    aArgs.push("-c:a", "aac", "-b:a", String(sourceQuality.audio.bitrate));
  } else {
    aArgs.push("-c:a", "aac", "-b:a", "192k");
  }
  if (sourceQuality?.audio?.sample_rate) {
    aArgs.push("-ar", String(sourceQuality.audio.sample_rate));
  }
  if (sourceQuality?.audio?.channels) {
    aArgs.push("-ac", String(sourceQuality.audio.channels));
  }

  console.log(`[ENCODE-ARGS] Video: ${vArgs.join(" ")}`);
  console.log(`[ENCODE-ARGS] Audio: ${aArgs.join(" ")}`);
  return { vArgs, aArgs };
}

/**
 * Render an EditPlan to a video file.
 *
 * Uses stream copy for hard_cut transitions when the source codec is universally
 * compatible (H.264 yuv420p). Otherwise re-encodes to H.264 using the source
 * video's own bitrate/resolution/fps so the output matches the original quality.
 *
 * @param {string} wslIn          - WSL path to source video
 * @param {object} editPlan       - The validated EditPlan
 * @param {string} wslOut         - WSL path for output video
 * @param {string} tmpDir         - Temp directory for intermediate files
 * @param {object} sourceQuality  - Original video params from probeSourceQuality()
 */
async function renderEditPlan(wslIn, editPlan, wslOut, tmpDir, sourceQuality) {
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

  // Build encoding args that match the original source quality
  const rc = editPlan.render_constraints || {};
  const { vArgs: srcVideoArgs, aArgs: srcAudioArgs } = buildSourceMatchEncodingArgs(sourceQuality, rc);
  const qFpsMode = rc.fps_mode || "cfr";

  // Check if source codec allows stream copy
  const canCopy = await probeCanStreamCopy(wslIn);
  const copyOrReencode = canCopy ? ["-c", "copy"] : srcVideoArgs;
  const copyLabel = canCopy ? "stream copy" : "re-encode (source-matched)";
  console.log(`[RENDER] Strategy: ${copyLabel}, needsReencode=${(editPlan.transitions || []).some(t => t.type !== "hard_cut")}, segments=${segments.length}`);

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

  // Extract each segment to its own file (stream copy — no quality loss yet)
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
      const audioArgs = hasAudio ? srcAudioArgs : ["-an"];
      console.log(`[RENDER] Re-encoding with transitions: ${filterParts.length} video filters, hasAudio=${hasAudio}`);
      console.log(`[RENDER] Source-matched quality: v_bitrate=${sourceQuality?.video?.bitrate || "crf-fallback"}, a_bitrate=${sourceQuality?.audio?.bitrate || "192k-fallback"}`);
      try {
        const finalMapArgs = hasAudio
          ? ["-map", lastVideoLabel, "-map", lastAudioLabel]
          : ["-map", lastVideoLabel];
        // Strip -s, -r, -movflags from source-matched args (xfade handles resolution/fps; movflags added at end)
        const skipFlags = new Set(["-s", "-r", "-movflags"]);
        const cleanVideoArgs = [];
        for (let j = 0; j < srcVideoArgs.length; j++) {
          if (skipFlags.has(srcVideoArgs[j])) { j++; continue; } // skip flag and its value
          cleanVideoArgs.push(srcVideoArgs[j]);
        }
        // Write filter_complex to a script file to avoid shell escaping issues.
        // WSL passes args through bash, which interprets semicolons as command
        // separators — using -filter_complex_script bypasses this entirely.
        const filterScriptPath = path.join(tmpDir, "filter.txt");
        fs.writeFileSync(filterScriptPath, filterComplex);
        console.log(`[RENDER] Filter script: ${filterComplex}`);
        await ffmpeg(["-y", "-loglevel", "error", ...inputArgs, "-filter_complex_script", toWslPath(filterScriptPath), ...finalMapArgs, ...cleanVideoArgs, "-fps_mode", qFpsMode, ...audioArgs, "-movflags", "+faststart", wslOut]);
      } catch (filterErr) {
        console.log(`[RENDER] Filter complex failed (${filterErr.message}), falling back to re-encode concat`);
        const concatFile = path.join(tmpDir, "concat.txt");
        fs.writeFileSync(concatFile, segFiles.map(f => `file '${toWslPath(f)}'`).join("\n"));
        // Re-encode fallback: use source-matched quality to preserve dimensions and bitrate
        await ffmpeg(["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", toWslPath(concatFile), ...srcVideoArgs, ...srcAudioArgs, wslOut]);
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
//  Streams NDJSON progress events automatically, final line is the result.
//  Client receives lines like: {"type":"progress","agent":"CUT","message":"..."}
//  Last line:                   {"type":"result","editPlan":{...},"summary":"..."}
app.post("/api/analyze", authMiddleware, async (req, res) => {
  const { duration, frames, width, height, fps } = req.body;

  // Stream NDJSON progress to the client in real-time
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Transfer-Encoding", "chunked");

  const sendLine = (obj) => {
    try { res.write(JSON.stringify(obj) + "\n"); } catch {}
  };

  // Wire pipeline progress directly into the response stream
  setProgressCallback((agent, message) => {
    sendLine({ type: "progress", agent, message, ts: Date.now() });
  });

  try {
    sendLine({ type: "progress", agent: "SYSTEM", message: "Starting analysis...", ts: Date.now() });

    const frameData = (frames || []).map((f, i) => ({
      timestamp: Math.round((duration / frames.length) * i * 10) / 10,
      base64: f
    }));
    const videoMeta = { duration, fps: fps || 30, width: width || 0, height: height || 0 };
    const editPlan = await runEditPipeline(videoMeta, frameData);

    // Final result line
    sendLine({
      type: "result",
      editPlan,
      segments: editPlan.segments,
      summary: `${editPlan.segments.length} highlights selected`,
    });
    res.end();
  } catch (err) {
    console.error("[ANALYZE ERROR]", err);
    sendLine({ type: "error", error: "Analysis failed", message: err.message });
    res.end();
  } finally {
    setProgressCallback(null);
  }
});

//  POST /api/trim 
app.post("/api/trim", authMiddleware, express.raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
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

    // Probe source quality BEFORE any processing
    const sourceQuality = await probeSourceQuality(wslIn);
    const canCopy = await probeCanStreamCopy(wslIn);

    let codecArgs;
    if (canCopy) {
      codecArgs = ["-c", "copy"];
    } else {
      // Re-encode using source-matched params (bitrate, resolution, fps)
      const { vArgs } = buildSourceMatchEncodingArgs(sourceQuality, {});
      codecArgs = vArgs;
    }
    const inputSize = fs.statSync(tmpIn).size;
    console.log(`[TRIM] Input: ${(inputSize / 1024 / 1024).toFixed(1)}MB`);
    console.log(`[TRIM] in=${inSec}s out=${outSec}s duration=${outSec - inSec}s (${canCopy ? "stream copy" : "re-encode source-matched"})`);
    console.log(`[TRIM] ffmpeg args: ${codecArgs.join(" ")}`);
    await ffmpeg(["-y", "-loglevel", "error", "-ss", String(inSec), "-i", wslIn, "-t", String(outSec - inSec), ...codecArgs, "-avoid_negative_ts", "make_zero", wslOut]);
    const outputSize = fs.statSync(tmpOut).size;
    console.log(`[TRIM] Output: ${(outputSize / 1024 / 1024).toFixed(1)}MB (ratio: ${(outputSize / inputSize * 100).toFixed(0)}%)`);
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
app.post("/api/auto-edit", authMiddleware, express.raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
  if (!req.body || req.body.length === 0) return res.status(400).json({ error: "No video data received" });
  const name   = req.query.name || "video";
  const tmpIn  = tmpFile("mp4"), tmpOut = tmpFile("mp4");
  const tmpDir = path.join(os.tmpdir(), `edit_${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmpDir);
  try {
    fs.writeFileSync(tmpIn, req.body);
    const inputSize = fs.statSync(tmpIn).size;
    console.log(`[AUTO-EDIT] Input file: ${(inputSize / 1024 / 1024).toFixed(1)}MB`);
    const wslIn = toWslPath(tmpIn), wslOut = toWslPath(tmpOut);

    // Probe video metadata
    const durationStr = await ffprobe(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wslIn]);
    const duration = parseFloat(durationStr);
    if (isNaN(duration) || duration <= 0) {
      cleanup(tmpIn, tmpOut);
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
      return res.status(400).json({ error: "Could not determine video duration" });
    }
    // Probe FULL source quality params BEFORE any processing
    const sourceQuality = await probeSourceQuality(wslIn);

    const videoMeta = await probeVideoMeta(wslIn, duration);
    console.log(`[AUTO-EDIT] Video: ${videoMeta.width}x${videoMeta.height}, ${videoMeta.fps}fps, ${duration.toFixed(1)}s`);

    // Extract frames for vision analysis
    const frameCount = Math.min(24, Math.max(6, Math.floor(duration / 5)));
    console.log(`[AUTO-EDIT] Extracting ${frameCount} frames...`);
    const frames = await extractFrames(wslIn, duration, frameCount);

    // Run multi-agent pipeline: Cut → Structure → Continuity → Transition → Constraints
    // Pass videoPath for Claude tool use (cookbook: agentic loop)
    console.log("[AUTO-EDIT] Running multi-agent editing pipeline...");
    const editPlan = await runEditPipeline(videoMeta, frames, sourceQuality, { videoPath: wslIn });

    const segments = editPlan.segments || [];
    const finalDuration = segments.reduce((sum, s) => sum + (s.src_out - s.src_in), 0);
    console.log(`[AUTO-EDIT] EditPlan: ${segments.length} segments, ${finalDuration.toFixed(1)}s of ${duration.toFixed(1)}s (${(finalDuration / duration * 100).toFixed(0)}%)`);

    // Render the EditPlan to video using source-matched quality
    console.log(`[AUTO-EDIT] Rendering ${segments.length} segments...`);
    const renderStart = Date.now();
    await renderEditPlan(wslIn, editPlan, wslOut, tmpDir, sourceQuality);
    const renderElapsed = ((Date.now() - renderStart) / 1000).toFixed(1);
    const outputSize = fs.statSync(tmpOut).size;
    console.log(`[AUTO-EDIT] Render done in ${renderElapsed}s`);
    console.log(`[AUTO-EDIT] Output: ${(outputSize / 1024 / 1024).toFixed(1)}MB (input was ${(inputSize / 1024 / 1024).toFixed(1)}MB, ratio: ${(outputSize / inputSize * 100).toFixed(0)}%)`);

    const summary = `${segments.length} highlights selected`;
    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", `attachment; filename="${name}_highlights.mp4"`);
    res.set("X-AI-Summary", summary);
    res.set("X-Segments-Count", String(segments.length));
    res.set("X-Video-Width", String(videoMeta.width));
    res.set("X-Video-Height", String(videoMeta.height));
    res.set("X-Video-Duration", String(Math.round(finalDuration)));
    res.sendFile(tmpOut, () => { cleanup(tmpIn, tmpOut); try { fs.rmSync(tmpDir, { recursive: true }); } catch {} });
  } catch (err) {
    cleanup(tmpIn, tmpOut);
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    console.error("[AUTO-EDIT ERROR]", err);
    res.status(500).json({ error: "Auto-edit failed" });
  }
});

//  POST /api/render — render a pre-built EditPlan (no AI pipeline)
//  The web client already has the EditPlan from /api/analyze, so this
//  endpoint skips AI entirely and only does the ffmpeg rendering step.
app.post("/api/render", authMiddleware, express.raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
  if (!req.body || req.body.length === 0) return res.status(400).json({ error: "No video data received" });
  const name = req.query.name || "video";

  // EditPlan is passed as a header to avoid multipart complexity
  const editPlanHeader = req.headers["x-edit-plan"];
  if (!editPlanHeader) return res.status(400).json({ error: "Missing X-Edit-Plan header" });
  let editPlan;
  try {
    editPlan = JSON.parse(editPlanHeader);
  } catch {
    return res.status(400).json({ error: "Invalid X-Edit-Plan JSON" });
  }
  const segments = editPlan.segments || [];
  if (!segments.length) return res.status(400).json({ error: "EditPlan has no segments" });

  const tmpIn  = tmpFile("mp4"), tmpOut = tmpFile("mp4");
  const tmpDir = path.join(os.tmpdir(), `render_${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmpDir);
  try {
    fs.writeFileSync(tmpIn, req.body);
    const inputSize = fs.statSync(tmpIn).size;
    console.log(`[RENDER-API] Input file: ${(inputSize / 1024 / 1024).toFixed(1)}MB`);
    const wslIn = toWslPath(tmpIn), wslOut = toWslPath(tmpOut);

    // Probe source quality for source-matched encoding
    const sourceQuality = await probeSourceQuality(wslIn);

    const finalDuration = segments.reduce((sum, s) => sum + (s.src_out - s.src_in), 0);
    console.log(`[RENDER-API] EditPlan: ${segments.length} segments, ${finalDuration.toFixed(1)}s`);

    // Render the EditPlan directly — no AI pipeline
    const renderStart = Date.now();
    await renderEditPlan(wslIn, editPlan, wslOut, tmpDir, sourceQuality);
    const renderElapsed = ((Date.now() - renderStart) / 1000).toFixed(1);
    const outputSize = fs.statSync(tmpOut).size;
    console.log(`[RENDER-API] Render done in ${renderElapsed}s`);
    console.log(`[RENDER-API] Output: ${(outputSize / 1024 / 1024).toFixed(1)}MB (input was ${(inputSize / 1024 / 1024).toFixed(1)}MB)`);

    const summary = `${segments.length} highlights rendered`;
    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", `attachment; filename="${name}_highlights.mp4"`);
    res.set("X-AI-Summary", summary);
    res.set("X-Segments-Count", String(segments.length));
    res.sendFile(tmpOut, () => { cleanup(tmpIn, tmpOut); try { fs.rmSync(tmpDir, { recursive: true }); } catch {} });
  } catch (err) {
    cleanup(tmpIn, tmpOut);
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    console.error("[RENDER-API ERROR]", err);
    res.status(500).json({ error: "Render failed" });
  }
});

// ---------------------------------------------------------------------------
// SSE Streaming endpoint — real-time pipeline progress (cookbook: streaming)
// ---------------------------------------------------------------------------

/**
 * POST /api/auto-edit-stream — Same as /api/auto-edit but with SSE progress.
 *
 * Claude Cookbook pattern: Server-Sent Events for real-time agent progress.
 * The client receives progress events as each agent completes, then the
 * final video binary at the end.
 *
 * Response format: SSE events followed by a final JSON with download URL.
 * Events: { agent, message, timestamp }
 */
app.post("/api/auto-edit-stream", authMiddleware, express.raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
  if (!req.body || req.body.length === 0) return res.status(400).json({ error: "No video data received" });

  // Set up SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "http://localhost:5173",
  });

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Set up progress callback for the pipeline
  setProgressCallback((agent, message) => {
    sendEvent("progress", { agent, message, timestamp: Date.now() });
  });

  const name = req.query.name || "video";
  const tmpIn = tmpFile("mp4"), tmpOut = tmpFile("mp4");
  const tmpDir = path.join(os.tmpdir(), `edit_${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmpDir);

  try {
    fs.writeFileSync(tmpIn, req.body);
    const wslIn = toWslPath(tmpIn), wslOut = toWslPath(tmpOut);

    sendEvent("progress", { agent: "SYSTEM", message: "Video received, probing metadata...", timestamp: Date.now() });

    const durationStr = await ffprobe(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wslIn]);
    const duration = parseFloat(durationStr);
    if (isNaN(duration) || duration <= 0) {
      sendEvent("error", { message: "Could not determine video duration" });
      res.end();
      cleanup(tmpIn, tmpOut);
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
      return;
    }

    const sourceQuality = await probeSourceQuality(wslIn);
    const videoMeta = await probeVideoMeta(wslIn, duration);

    sendEvent("progress", { agent: "SYSTEM", message: `Video: ${videoMeta.width}x${videoMeta.height}, ${videoMeta.fps}fps, ${duration.toFixed(1)}s`, timestamp: Date.now() });

    const frameCount = Math.min(24, Math.max(6, Math.floor(duration / 5)));
    sendEvent("progress", { agent: "SYSTEM", message: `Extracting ${frameCount} frames...`, timestamp: Date.now() });
    const frames = await extractFrames(wslIn, duration, frameCount);

    sendEvent("progress", { agent: "PIPELINE", message: "Starting multi-agent editing pipeline...", timestamp: Date.now() });
    const editPlan = await runEditPipeline(videoMeta, frames, sourceQuality, { videoPath: wslIn });

    const segments = editPlan.segments || [];
    const finalDuration = segments.reduce((sum, s) => sum + (s.src_out - s.src_in), 0);

    sendEvent("progress", { agent: "RENDER", message: `Rendering ${segments.length} segments...`, timestamp: Date.now() });
    await renderEditPlan(wslIn, editPlan, wslOut, tmpDir, sourceQuality);

    sendEvent("complete", {
      segments: segments.length,
      duration: Math.round(finalDuration),
      summary: `${segments.length} highlights selected`,
      width: videoMeta.width,
      height: videoMeta.height,
    });

    res.end();
    // Note: client must fetch the video via a separate request
    // The output video path is available for download
  } catch (err) {
    sendEvent("error", { message: err.message });
    res.end();
  } finally {
    setProgressCallback(null); // Clear callback
    cleanup(tmpIn, tmpOut);
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
});

app.get("/api/health", (_, res) => res.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// Authentication endpoints
// ---------------------------------------------------------------------------

app.post("/api/auth/login", (req, res) => {
  if (!AUTH_ENABLED) {
    return res.json({ token: generateToken("anonymous"), user: { uid: "anonymous" } });
  }
  const { password } = req.body || {};
  if (password !== AUTH_SECRET) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const uid = "user_" + crypto.randomBytes(4).toString("hex");
  const token = generateToken(uid);
  res.json({ token, user: { uid } });
});

app.get("/api/auth/verify", authMiddleware, (req, res) => {
  res.json({ valid: true, user: req.user || { uid: "anonymous" } });
});

// ---------------------------------------------------------------------------
// Text overlay endpoint
// ---------------------------------------------------------------------------

/**
 * POST /api/overlay — Burn text overlays onto a video
 * Body: raw video bytes
 * Header X-Overlays: JSON array of text overlay definitions
 * Each overlay: { text, x, y, fontSize, color, from, to }
 *   - text: string to display
 *   - x, y: position (0-100 percentage)
 *   - fontSize: number (default 24)
 *   - color: hex color (default "white")
 *   - from, to: time range in seconds (optional — full video if omitted)
 */
app.post("/api/overlay", authMiddleware, express.raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
  if (!req.body || req.body.length === 0) return res.status(400).json({ error: "No video data received" });

  const overlaysHeader = req.headers["x-overlays"];
  if (!overlaysHeader) return res.status(400).json({ error: "Missing X-Overlays header" });
  let overlays;
  try {
    overlays = JSON.parse(overlaysHeader);
    if (!Array.isArray(overlays) || overlays.length === 0) throw new Error("empty");
  } catch {
    return res.status(400).json({ error: "Invalid X-Overlays JSON" });
  }

  const name = req.query.name || "video";
  const tmpIn = tmpFile("mp4"), tmpOut = tmpFile("mp4");
  const tmpDir = path.join(os.tmpdir(), `overlay_${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmpDir);
  try {
    fs.writeFileSync(tmpIn, req.body);
    const wslIn = toWslPath(tmpIn), wslOut = toWslPath(tmpOut);
    const sourceQuality = await probeSourceQuality(wslIn);
    const { vArgs, aArgs } = buildSourceMatchEncodingArgs(sourceQuality, {});

    // Build drawtext filter chain
    const drawFilters = overlays.map((o, i) => {
      const text = (o.text || "").replace(/'/g, "'\\''").replace(/:/g, "\\:");
      const fontSize = o.fontSize || 24;
      const color = o.color || "white";
      const x = o.x != null ? `(w*${o.x / 100})` : "(w-text_w)/2";
      const y = o.y != null ? `(h*${o.y / 100})` : "(h-text_h)/2";
      let enable = "";
      if (o.from != null && o.to != null) {
        enable = `:enable='between(t,${o.from},${o.to})'`;
      }
      return `drawtext=text='${text}':fontsize=${fontSize}:fontcolor=${color}:x=${x}:y=${y}${enable}`;
    });

    const filterScriptPath = path.join(tmpDir, "overlay_filter.txt");
    fs.writeFileSync(filterScriptPath, drawFilters.join(","));
    console.log(`[OVERLAY] ${overlays.length} text overlays, filter: ${drawFilters.join(",").slice(0, 200)}...`);

    await ffmpeg(["-y", "-loglevel", "error", "-i", wslIn, "-filter_complex_script", toWslPath(filterScriptPath), ...vArgs, ...aArgs, wslOut]);

    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", `attachment; filename="${name}_overlay.mp4"`);
    res.sendFile(tmpOut, () => { cleanup(tmpIn, tmpOut); try { fs.rmSync(tmpDir, { recursive: true }); } catch {} });
  } catch (err) {
    cleanup(tmpIn, tmpOut);
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    console.error("[OVERLAY ERROR]", err);
    res.status(500).json({ error: "Overlay failed" });
  }
});

// ---------------------------------------------------------------------------
// Audio volume adjustment endpoint
// ---------------------------------------------------------------------------

/**
 * POST /api/adjust-audio — Adjust audio volume of a video
 * Body: raw video bytes
 * Query: volume (0-200, percentage, default 100)
 */
app.post("/api/adjust-audio", authMiddleware, express.raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
  if (!req.body || req.body.length === 0) return res.status(400).json({ error: "No video data received" });
  const volume = parseFloat(req.query.volume || "100");
  if (isNaN(volume) || volume < 0 || volume > 200) return res.status(400).json({ error: "Volume must be 0-200" });
  const name = req.query.name || "video";
  const tmpIn = tmpFile("mp4"), tmpOut = tmpFile("mp4");
  try {
    fs.writeFileSync(tmpIn, req.body);
    const wslIn = toWslPath(tmpIn), wslOut = toWslPath(tmpOut);
    const vol = (volume / 100).toFixed(2);
    console.log(`[AUDIO] Adjusting volume to ${volume}% (${vol}x)`);
    if (volume === 100) {
      // No change needed — stream copy
      await ffmpeg(["-y", "-loglevel", "error", "-i", wslIn, "-c", "copy", wslOut]);
    } else if (volume === 0) {
      // Mute — remove audio
      await ffmpeg(["-y", "-loglevel", "error", "-i", wslIn, "-c:v", "copy", "-an", wslOut]);
    } else {
      await ffmpeg(["-y", "-loglevel", "error", "-i", wslIn, "-c:v", "copy", "-af", `volume=${vol}`, "-c:a", "aac", wslOut]);
    }
    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", `attachment; filename="${name}_audio.mp4"`);
    res.sendFile(tmpOut, () => cleanup(tmpIn, tmpOut));
  } catch (err) {
    cleanup(tmpIn, tmpOut);
    console.error("[AUDIO ERROR]", err);
    res.status(500).json({ error: "Audio adjustment failed" });
  }
});

// POST /api/merge — Concatenate multiple video files in order
const multer = require("multer");
const mergeUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 200 * 1024 * 1024 } });

app.post("/api/merge", authMiddleware, mergeUpload.array("videos", 20), async (req, res) => {
  const files = req.files || [];
  const tmpDir = path.join(os.tmpdir(), `merge_${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  let tmpOut = "";

  try {
    if (files.length < 2) {
      return res.status(400).json({ error: "Need at least 2 files to merge" });
    }

    // Build concat list
    const concatFile = path.join(tmpDir, "concat.txt");
    const lines = files.map(f => `file '${toWslPath(f.path)}'`);
    fs.writeFileSync(concatFile, lines.join("\n"));

    tmpOut = tmpFile("mp4");
    console.log(`[MERGE] Merging ${files.length} files...`);

    await ffmpeg([
      "-y", "-loglevel", "error",
      "-f", "concat", "-safe", "0",
      "-i", toWslPath(concatFile),
      "-c:v", "libx264", "-crf", "18", "-preset", "fast",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      toWslPath(tmpOut),
    ]);

    const outSize = fs.statSync(tmpOut).size;
    console.log(`[MERGE] Done: ${(outSize / 1024 / 1024).toFixed(1)}MB from ${files.length} files`);

    const name = req.query.name || "merged";
    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", `attachment; filename="${name}.mp4"`);
    res.sendFile(tmpOut, () => {
      cleanup(tmpOut);
      files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    });
  } catch (err) {
    cleanup(tmpOut);
    files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    console.error("[MERGE ERROR]", err);
    res.status(500).json({ error: "Merge failed" });
  }
});

// Serve built frontend in production
const webDist = path.join(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(webDist, "index.html"));
  });
}

const PORT = parseInt(process.env.PORT || "3001", 10);
app.listen(PORT, () => {
  const provider = process.env.ANTHROPIC_API_KEY ? "Claude API (auto-detected)" : "Ollama (local)";
  console.log(`VideoAgent API on http://localhost:${PORT}`);
  console.log(`  LLM Provider: ${provider}`);
  console.log(`  Auth: ${AUTH_ENABLED ? "ENABLED (set AUTH_SECRET)" : "DISABLED (open access)"}`);
  console.log("  POST /api/auth/login       - Get auth token");
  console.log("  GET  /api/auth/verify      - Verify token");
  console.log("  POST /api/analyze          - AI analysis (web client)");
  console.log("  POST /api/render           - Render pre-built EditPlan (web client)");
  console.log("  POST /api/trim             - Single segment trim");
  console.log("  POST /api/auto-edit        - Full highlight reel (bots)");
  console.log("  POST /api/auto-edit-stream - Full highlight reel with SSE progress");
  console.log("  POST /api/overlay          - Burn text overlays onto video");
  console.log("  POST /api/adjust-audio     - Adjust audio volume");
  console.log("  POST /api/merge            - Merge multiple videos");
  console.log("  GET  /api/health           - Health check");
  console.log("  MCP: node src/mcp-server.js (stdio transport)");
});
