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

// Convert Windows path to WSL path
function toWslPath(winPath) {
  return winPath.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
}

function tmpFile(ext) {
  return path.join(os.tmpdir(), `va_${crypto.randomBytes(6).toString("hex")}.${ext}`);
}

function cleanup(...files) {
  for (const f of files) try { fs.unlinkSync(f); } catch {}
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    exec(`wsl -d Ubuntu-24.04 -- ffmpeg ${args}`, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function ffprobe(args) {
  return new Promise((resolve, reject) => {
    exec(`wsl -d Ubuntu-24.04 -- ffprobe ${args}`, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

//  POST /api/analyze 
app.post("/api/analyze", async (req, res) => {
  const { duration, frames } = req.body;
  const content = [
    {
      type: "text",
      text: `You are a video highlight editor. You receive ${frames?.length || 0} frames from a ${parseFloat(duration || 0).toFixed(1)}-second video.
Find the single best highlight moment (action, kill, goal, key event). Ignore menus, loading, idle.
Return ONLY valid JSON, no markdown:
{"editPlan":{"timelineOps":[{"op":"setInOut","in":<number>,"out":<number>}],"summary":"<one sentence>"}}`
    },
    ...(frames || []).map(f => ({ type: "image_url", image_url: { url: f } }))
  ];

  try {
    const response = await fetch("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-coder:30b", messages: [{ role: "user", content }], temperature: 0, stream: false })
    });
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: "No JSON", raw: text });
    res.json(JSON.parse(match[0]));
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

  const tmpIn  = tmpFile("mp4");
  const tmpOut = tmpFile("mp4");

  try {
    fs.writeFileSync(tmpIn, req.body);

    const wslIn  = toWslPath(tmpIn);
    const wslOut = toWslPath(tmpOut);

    await ffmpeg(`-y -ss ${inSec} -i "${wslIn}" -t ${outSec - inSec} -c copy -avoid_negative_ts make_zero "${wslOut}"`);

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
  const tmpIn  = tmpFile("mp4");
  const tmpOut = tmpFile("mp4");
  const framesDir = path.join(os.tmpdir(), `frames_${crypto.randomBytes(4).toString("hex")}`);

  try {
    fs.writeFileSync(tmpIn, req.body);
    fs.mkdirSync(framesDir);

    const wslIn     = toWslPath(tmpIn);
    const wslFrames = toWslPath(framesDir);
    const wslOut    = toWslPath(tmpOut);

    // Get duration
    const durationStr = await ffprobe(`-v error -show_entries format=duration -of csv=p=0 "${wslIn}"`);
    const duration = parseFloat(durationStr);

    // Extract 6 frames
    const frameCount = 6;
    const interval = duration / frameCount;
    await ffmpeg(`-i "${wslIn}" -vf "fps=1/${interval},scale=256:144" -frames:v ${frameCount} "${wslFrames}/frame%03d.jpg"`);

    const frames = fs.readdirSync(framesDir)
      .filter(f => f.endsWith(".jpg")).sort()
      .map(f => `data:image/jpeg;base64,${fs.readFileSync(path.join(framesDir, f)).toString("base64")}`);

    fs.rmSync(framesDir, { recursive: true });

    // AI analyze
    const content = [
      { type: "text", text: `You are a video highlight editor. ${frames.length} frames from ${duration.toFixed(1)}s video. Find best highlight. Return ONLY JSON: {"editPlan":{"timelineOps":[{"op":"setInOut","in":<n>,"out":<n>}],"summary":"<text>"}}` },
      ...frames.map(f => ({ type: "image_url", image_url: { url: f } }))
    ];

    const aiRes = await fetch("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-coder:30b", messages: [{ role: "user", content }], temperature: 0, stream: false })
    });

    const aiData = await aiRes.json();
    const text = aiData.choices?.[0]?.message?.content || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: "AI no JSON", raw: text });

    const plan = JSON.parse(match[0]);
    const op = plan?.editPlan?.timelineOps?.find(o => o.op === "setInOut");
    if (!op) return res.status(422).json({ error: "No setInOut", plan });

    const inSec  = Math.max(0, op.in);
    const outSec = Math.min(duration, op.out);

    await ffmpeg(`-y -ss ${inSec} -i "${wslIn}" -t ${outSec - inSec} -c copy -avoid_negative_ts make_zero "${wslOut}"`);

    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", `attachment; filename="${name}_highlight.mp4"`);
    res.set("X-AI-Summary", plan.editPlan.summary || "");
    res.set("X-Trim-In", String(inSec));
    res.set("X-Trim-Out", String(outSec));
    res.sendFile(tmpOut, () => cleanup(tmpIn, tmpOut));

  } catch (err) {
    try { fs.rmSync(framesDir, { recursive: true }); } catch {}
    cleanup(tmpIn, tmpOut);
    res.status(500).json({ error: err.message });
  }
});

//  GET /api/health 
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", endpoints: ["/api/analyze", "/api/trim", "/api/auto-edit"] });
});

app.listen(3001, () => {
  console.log("VideoAgent API on http://localhost:3001");
  console.log("  POST /api/analyze   - AI frame analysis");
  console.log("  POST /api/trim      - Trim video (via WSL ffmpeg)");
  console.log("  POST /api/auto-edit - Full pipeline for bots");
});
