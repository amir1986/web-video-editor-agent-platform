const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

function toWslPath(p) {
  // On Linux, paths don't need conversion
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
function ffmpegCmd(args) {
  // On Windows use WSL, on Linux/Mac call ffmpeg directly
  if (process.platform === "win32") {
    return `wsl -d Ubuntu-24.04 -- ffmpeg ${args}`;
  }
  return `ffmpeg ${args}`;
}
function ffprobeCmd(args) {
  if (process.platform === "win32") {
    return `wsl -d Ubuntu-24.04 -- ffprobe ${args}`;
  }
  return `ffprobe ${args}`;
}
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    exec(ffmpegCmd(args), { maxBuffer: 100 * 1024 * 1024 }, (err, _, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}
function ffprobe(args) {
  return new Promise((resolve, reject) => {
    exec(ffprobeCmd(args), (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function extractFrames(wslIn, duration, count) {
  const framesDir = path.join(os.tmpdir(), `frames_${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(framesDir);
  const interval = duration / count;
  // scale=320:-2 preserves original aspect ratio (height auto-calculated, divisible by 2)
  await ffmpeg(`-i "${wslIn}" -vf "fps=1/${interval},scale=320:-2" -frames:v ${count} "${toWslPath(framesDir)}/frame%04d.jpg"`);
  const frames = fs.readdirSync(framesDir)
    .filter(f => f.endsWith(".jpg")).sort()
    .map((f, i) => ({
      timestamp: Math.round(interval * i * 10) / 10,
      base64: `data:image/jpeg;base64,${fs.readFileSync(path.join(framesDir, f)).toString("base64")}`
    }));
  fs.rmSync(framesDir, { recursive: true });
  return frames;
}

/**
 * Build time-based highlight segments when AI is unavailable.
 * Keeps the most interesting portions: intro, middle highlight, and ending.
 * Targets ~40-60% of the original duration.
 */
function buildFallbackSegments(duration) {
  if (duration <= 10) {
    // Very short video: keep first 70%
    return {
      segments: [{ in: 0, out: Math.round(duration * 0.7 * 10) / 10, reason: "short video - trimmed ending" }],
      summary: "Short video - trimmed the ending"
    };
  }
  if (duration <= 30) {
    // Short video: keep opening + best middle section (skip slow start/end)
    const seg1End = Math.round(duration * 0.35 * 10) / 10;
    const seg2Start = Math.round(duration * 0.45 * 10) / 10;
    const seg2End = Math.round(duration * 0.85 * 10) / 10;
    return {
      segments: [
        { in: 0, out: seg1End, reason: "opening section" },
        { in: seg2Start, out: seg2End, reason: "main highlight" }
      ],
      summary: "Kept the best parts of this short clip"
    };
  }
  // Longer video: pick 3-4 segments from different parts
  const segDur = duration * 0.15; // each segment ~15% of total
  const segments = [];
  // Opening hook (first 15%)
  segments.push({ in: 0, out: Math.round(segDur * 10) / 10, reason: "opening hook" });
  // Early highlight (around 25-40%)
  const s2Start = Math.round(duration * 0.25 * 10) / 10;
  segments.push({ in: s2Start, out: Math.round((s2Start + segDur) * 10) / 10, reason: "early highlight" });
  // Mid highlight (around 50-65%)
  const s3Start = Math.round(duration * 0.50 * 10) / 10;
  segments.push({ in: s3Start, out: Math.round((s3Start + segDur) * 10) / 10, reason: "mid highlight" });
  // Closing (last 10%)
  const closeStart = Math.round(duration * 0.85 * 10) / 10;
  segments.push({ in: closeStart, out: Math.round(duration * 10) / 10, reason: "closing moment" });
  return {
    segments,
    summary: "Auto-generated highlights from key moments"
  };
}

async function analyzeWithAI(frames, duration) {
  const timestamps = frames.map(f => `${f.timestamp}s`).join(", ");

  // Build a strong, explicit prompt for highlight extraction
  const textPrompt = `You are a professional video editor creating a HIGHLIGHT REEL. Your job is to CUT the video down to only the best moments.

VIDEO INFO: Total duration = ${duration.toFixed(1)} seconds. Frame timestamps: ${timestamps}.

RULES:
1. You MUST select between 2 and 6 segments that together cover 30%-60% of the original duration.
2. The total kept duration MUST be LESS than ${(duration * 0.65).toFixed(1)} seconds.
3. Each segment needs "in" (start time) and "out" (end time) in seconds.
4. CUT OUT: intros, outros, dead air, repetitive parts, pauses, filler.
5. KEEP: action moments, key points, interesting visuals, emotional peaks, humor.
6. Segments must not overlap and must be sorted by "in" time.

EXAMPLE for a 60-second video:
{"segments":[{"in":0,"out":8,"reason":"strong opening"},{"in":15,"out":28,"reason":"main action"},{"in":42,"out":55,"reason":"climax and ending"}],"summary":"Cut from 60s to 34s keeping the best action"}

Now analyze this ${duration.toFixed(1)}-second video and return ONLY valid JSON (no other text):
{"segments":[{"in":<seconds>,"out":<seconds>,"reason":"<why>"}],"summary":"<one sentence>"}`;

  const contentWithImages = [
    { type: "text", text: textPrompt },
    ...frames.map(f => ({ type: "image_url", image_url: { url: f.base64 } }))
  ];

  const tryRequest = async (content) => {
    const res = await fetch("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.VISION_MODEL || "qwen2.5vl:7b", messages: [{ role: "user", content }], temperature: 0, stream: false })
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI no JSON: " + text.slice(0, 300));
    const parsed = JSON.parse(match[0]);
    // If AI says it can't see images, throw so we retry text-only
    if (!parsed.segments?.length && text.toLowerCase().includes("missing visual")) {
      throw new Error("vision_not_supported");
    }
    return parsed;
  };

  try {
    const result = await tryRequest(contentWithImages);
    return result;
  } catch (err) {
    if (err.message === "vision_not_supported" || err.message.includes("missing visual")) {
      console.log("Vision not supported, retrying text-only...");
      try {
        return await tryRequest(textPrompt);
      } catch (textErr) {
        console.log("Text-only AI also failed, using time-based fallback:", textErr.message);
        return buildFallbackSegments(duration);
      }
    }
    // If AI is completely unavailable (connection refused, etc.), use fallback
    if (err.message.includes("ECONNREFUSED") || err.message.includes("fetch failed") || err.message.includes("AI no JSON")) {
      console.log("AI unavailable, using time-based fallback:", err.message);
      return buildFallbackSegments(duration);
    }
    throw err;
  }
}

async function stitchSegments(wslIn, segments, wslOut, tmpDir) {
  // Single segment: extract directly to output (no concat needed)
  if (segments.length === 1) {
    const seg = segments[0];
    console.log(`[STITCH] Single segment: ${seg.in}s → ${seg.out}s (stream copy)`);
    await ffmpeg(`-y -ss ${seg.in} -i "${wslIn}" -t ${seg.out - seg.in} -c copy -avoid_negative_ts make_zero "${wslOut}"`);
    return;
  }

  // Multiple segments: extract each then concatenate.
  // Uses stream copy (-c copy): zero quality loss, preserves resolution,
  // rotation metadata, aspect ratio, frame rate — everything.
  // Trade-off: cuts snap to the nearest keyframe (±0.5s), acceptable for highlights.
  const segFiles = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segPath = path.join(tmpDir, `seg_${i}.mp4`);
    console.log(`[STITCH] Segment ${i}: ${seg.in}s → ${seg.out}s (stream copy)`);
    await ffmpeg(`-y -ss ${seg.in} -i "${wslIn}" -t ${seg.out - seg.in} -c copy -avoid_negative_ts make_zero "${toWslPath(segPath)}"`);
    segFiles.push(segPath);
  }
  const concatFile = path.join(tmpDir, "concat.txt");
  fs.writeFileSync(concatFile, segFiles.map(f => `file '${toWslPath(f)}'`).join("\n"));
  await ffmpeg(`-y -f concat -safe 0 -i "${toWslPath(concatFile)}" -c copy "${wslOut}"`);
  for (const f of [...segFiles, concatFile]) try { fs.unlinkSync(f); } catch {}
}

//  POST /api/analyze 
app.post("/api/analyze", async (req, res) => {
  const { duration, frames } = req.body;
  try {
    const frameData = (frames || []).map((f, i) => ({
      timestamp: Math.round((duration / frames.length) * i * 10) / 10,
      base64: f
    }));
    const plan = await analyzeWithAI(frameData, duration);
    const firstSeg = plan.segments?.[0];
    res.json({
      editPlan: {
        timelineOps: firstSeg ? [{ op: "setInOut", in: firstSeg.in, out: firstSeg.out }] : [],
        summary: plan.summary || "Done"
      },
      segments: plan.segments,
      summary: plan.summary
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//  POST /api/trim 
app.post("/api/trim", express.raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
  const inSec  = parseFloat(req.query.in  || "0");
  const outSec = parseFloat(req.query.out || "0");
  const name   = req.query.name || "highlight";
  if (outSec <= inSec) return res.status(400).json({ error: "out must be > in" });
  const tmpIn = tmpFile("mp4"), tmpOut = tmpFile("mp4");
  try {
    fs.writeFileSync(tmpIn, req.body);
    console.log(`Trimming: in=${inSec}s out=${outSec}s duration=${outSec - inSec}s`);
    // Stream copy: no re-encoding, preserves original quality/resolution/rotation/aspect ratio
    await ffmpeg(`-y -ss ${inSec} -i "${toWslPath(tmpIn)}" -t ${outSec - inSec} -c copy -avoid_negative_ts make_zero "${toWslPath(tmpOut)}"`);
    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", `attachment; filename="${name}.mp4"`);
    res.sendFile(tmpOut, () => cleanup(tmpIn, tmpOut));
  } catch (err) {
    cleanup(tmpIn, tmpOut);
    res.status(500).json({ error: err.message });
  }
});

//  POST /api/auto-edit 
app.post("/api/auto-edit", express.raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
  const name   = req.query.name || "video";
  const tmpIn  = tmpFile("mp4"), tmpOut = tmpFile("mp4");
  const tmpDir = path.join(os.tmpdir(), `edit_${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmpDir);
  try {
    fs.writeFileSync(tmpIn, req.body);
    const wslIn = toWslPath(tmpIn), wslOut = toWslPath(tmpOut);

    const durationStr = await ffprobe(`-v error -show_entries format=duration -of csv=p=0 "${wslIn}"`);
    const duration = parseFloat(durationStr);

    const frameCount = Math.min(24, Math.max(6, Math.floor(duration / 5)));
    console.log(`Extracting ${frameCount} frames from ${duration.toFixed(1)}s...`);
    const frames = await extractFrames(wslIn, duration, frameCount);

    console.log("AI analyzing...");
    let plan;
    try {
      plan = await analyzeWithAI(frames, duration);
    } catch (aiErr) {
      console.log("AI analysis failed, using time-based fallback:", aiErr.message);
      plan = buildFallbackSegments(duration);
    }
    console.log(`AI found ${plan.segments?.length} segments:`, plan.summary);

    let rawSegments = (plan.segments || [])
      .filter(s => typeof s.in === "number" && typeof s.out === "number" && s.out > s.in)
      .map(s => ({ in: Math.max(0, s.in), out: Math.min(duration, s.out), reason: s.reason || "highlight" }))
      .sort((a, b) => a.in - b.in);

    // Validate: total kept duration must be < 90% of original (otherwise AI returned near-full video)
    const totalKept = rawSegments.reduce((sum, s) => sum + (s.out - s.in), 0);
    if (!rawSegments.length || totalKept >= duration * 0.90) {
      console.log(`[AUTO-EDIT] Segments invalid or cover ${(totalKept / duration * 100).toFixed(0)}% of video — using time-based fallback`);
      const fallback = buildFallbackSegments(duration);
      rawSegments = fallback.segments;
      plan.summary = fallback.summary;
    }

    const segments = rawSegments;
    const finalDuration = segments.reduce((sum, s) => sum + (s.out - s.in), 0);
    console.log(`[AUTO-EDIT] Keeping ${segments.length} segments, ${finalDuration.toFixed(1)}s of ${duration.toFixed(1)}s (${(finalDuration / duration * 100).toFixed(0)}%)`);

    console.log(`Stitching ${segments.length} segments...`);
    await stitchSegments(wslIn, segments, wslOut, tmpDir);

    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", `attachment; filename="${name}_highlights.mp4"`);
    res.set("X-AI-Summary", plan.summary || "");
    res.set("X-Segments-Count", String(segments.length));
    res.sendFile(tmpOut, () => { cleanup(tmpIn, tmpOut); try { fs.rmSync(tmpDir, { recursive: true }); } catch {} });
  } catch (err) {
    cleanup(tmpIn, tmpOut);
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (_, res) => res.json({ status: "ok" }));

app.listen(3001, () => {
  console.log("VideoAgent API on http://localhost:3001");
  console.log("  POST /api/analyze   - AI analysis (web client)");
  console.log("  POST /api/trim      - Single segment trim");
  console.log("  POST /api/auto-edit - Full highlight reel (bots)");
});
