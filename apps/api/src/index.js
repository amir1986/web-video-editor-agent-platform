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
  await ffmpeg(`-i "${wslIn}" -vf "fps=1/${interval},scale=320:180" -frames:v ${count} "${toWslPath(framesDir)}/frame%04d.jpg"`);
  const frames = fs.readdirSync(framesDir)
    .filter(f => f.endsWith(".jpg")).sort()
    .map((f, i) => ({
      timestamp: Math.round(interval * i * 10) / 10,
      base64: `data:image/jpeg;base64,${fs.readFileSync(path.join(framesDir, f)).toString("base64")}`
    }));
  fs.rmSync(framesDir, { recursive: true });
  return frames;
}

async function analyzeWithAI(frames, duration) {
  const timestamps = frames.map(f => `${f.timestamp}s`).join(", ");
  const content = [
    {
      type: "text",
      text: `You are a professional video editor. You see ${frames.length} frames from a ${duration.toFixed(1)}-second video at timestamps: ${timestamps}

Analyze freely what you see and decide what to keep. No rules, no constraints, no time limits.
Use pure judgment - keep exciting moments, cut boring parts. You decide everything.

Return ONLY valid JSON:
{
  "segments": [
    { "in": <seconds>, "out": <seconds>, "reason": "<why keep this>" }
  ],
  "summary": "<describe the edit>"
}`
    },
    ...frames.map(f => ({ type: "image_url", image_url: { url: f.base64 } }))
  ];

  const res = await fetch("http://localhost:11434/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3-coder:30b", messages: [{ role: "user", content }], temperature: 0, stream: false })
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI no JSON: " + text.slice(0, 300));
  return JSON.parse(match[0]);
}

async function stitchSegments(wslIn, segments, wslOut, tmpDir) {
  const segFiles = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segPath = path.join(tmpDir, `seg_${i}.mp4`);
    await ffmpeg(`-y -ss ${seg.in} -i "${wslIn}" -t ${seg.out - seg.in} -c:v libx264 -c:a aac -preset ultrafast -avoid_negative_ts make_zero "${toWslPath(segPath)}"`);
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
    await ffmpeg(`-y -ss ${inSec} -i "${toWslPath(tmpIn)}" -t ${outSec - inSec} -c:v libx264 -c:a aac -preset ultrafast -avoid_negative_ts make_zero "${toWslPath(tmpOut)}"`);
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
    const plan = await analyzeWithAI(frames, duration);
    console.log(`AI found ${plan.segments?.length} segments:`, plan.summary);

    const rawSegments = plan.segments?.filter(s => s.out > s.in) || [];
    const segments = rawSegments.length
      ? rawSegments.map(s => ({ in: Math.max(0, s.in), out: Math.min(duration, s.out), reason: s.reason })).sort((a, b) => a.in - b.in)
      : [{ in: 0, out: duration, reason: "full video" }];

    if (!rawSegments.length) {
      plan.summary = plan.summary || "No highlights found - sending full video";
      console.log("AI found no segments, using full video as fallback");
    }

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
