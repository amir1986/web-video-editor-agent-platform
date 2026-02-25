const express = require("express");
const cors = require("cors");
const { execSync, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

//  UTILS 
function tmpFile(ext) {
  return path.join(os.tmpdir(), `videoagent_${crypto.randomBytes(6).toString("hex")}.${ext}`);
}

function cleanup(...files) {
  for (const f of files) try { fs.unlinkSync(f); } catch {}
}

//  POST /api/analyze 
// Input: { videoPath, duration, frames[] }
// Output: { editPlan: { timelineOps, summary } }
app.post("/api/analyze", async (req, res) => {
  const { duration, frames } = req.body;

  const content = [
    {
      type: "text",
      text: `You are a video highlight editor. You receive ${frames?.length || 0} frames from a ${parseFloat(duration || 0).toFixed(1)}-second video.
Analyze visually and find the single best highlight moment (action, kill, goal, key event).
Ignore menus, loading screens, idle time.
Return ONLY valid JSON, no markdown:
{"editPlan":{"timelineOps":[{"op":"setInOut","in":<number>,"out":<number>}],"summary":"<one sentence>"}}`
    },
    ...(frames || []).map(f => ({ type: "image_url", image_url: { url: f } }))
  ];

  try {
    const response = await fetch("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3-coder:30b",
        messages: [{ role: "user", content }],
        temperature: 0,
        stream: false
      })
    });
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: "No JSON in response", raw: text });
    res.json(JSON.parse(match[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//  POST /api/trim 
// Input: multipart or raw video bytes + query ?in=X&out=Y
// Output: trimmed mp4 file download
app.post("/api/trim", express.raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
  const inSec  = parseFloat(req.query.in  || "0");
  const outSec = parseFloat(req.query.out || "0");
  const name   = req.query.name || "highlight";

  if (outSec <= inSec) return res.status(400).json({ error: "out must be > in" });

  const tmpIn  = tmpFile("mp4");
  const tmpOut = tmpFile("mp4");

  try {
    fs.writeFileSync(tmpIn, req.body);

    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -y -ss ${inSec} -i "${tmpIn}" -t ${outSec - inSec} -c copy -avoid_negative_ts make_zero "${tmpOut}"`,
        (err, stdout, stderr) => err ? reject(new Error(stderr)) : resolve()
      );
    });

    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", `attachment; filename="${name}_highlight.mp4"`);
    res.sendFile(tmpOut, () => cleanup(tmpIn, tmpOut));
  } catch (err) {
    cleanup(tmpIn, tmpOut);
    res.status(500).json({ error: err.message });
  }
});

//  POST /api/auto-edit 
// Full pipeline: upload video -> analyze -> trim -> return file
// Perfect for bots (Telegram, WhatsApp, etc.)
app.post("/api/auto-edit", express.raw({ type: "*/*", limit: "2gb" }), async (req, res) => {
  const name = req.query.name || "video";
  const tmpIn  = tmpFile("mp4");
  const tmpOut = tmpFile("mp4");

  try {
    fs.writeFileSync(tmpIn, req.body);

    // Get duration
    const durationRaw = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${tmpIn}"`
    ).toString().trim();
    const duration = parseFloat(durationRaw);

    // Extract frames
    const framesDir = path.join(os.tmpdir(), `frames_${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(framesDir);
    const frameCount = Math.min(8, Math.floor(duration));
    const interval = duration / frameCount;

    execSync(
      `ffmpeg -i "${tmpIn}" -vf "fps=1/${interval},scale=256:144" -frames:v ${frameCount} "${framesDir}/frame%03d.jpg"`
    );

    const frames = fs.readdirSync(framesDir)
      .filter(f => f.endsWith(".jpg"))
      .sort()
      .map(f => {
        const buf = fs.readFileSync(path.join(framesDir, f));
        return `data:image/jpeg;base64,${buf.toString("base64")}`;
      });

    fs.rmSync(framesDir, { recursive: true });

    // Analyze with AI
    const content = [
      {
        type: "text",
        text: `You are a video highlight editor. You receive ${frames.length} frames from a ${duration.toFixed(1)}-second video.
Find the single best highlight moment. Ignore menus, loading, idle.
Return ONLY valid JSON:
{"editPlan":{"timelineOps":[{"op":"setInOut","in":<number>,"out":<number>}],"summary":"<one sentence>"}}`
      },
      ...frames.map(f => ({ type: "image_url", image_url: { url: f } }))
    ];

    const aiRes = await fetch("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3-coder:30b",
        messages: [{ role: "user", content }],
        temperature: 0,
        stream: false
      })
    });

    const aiData = await aiRes.json();
    const text = aiData.choices?.[0]?.message?.content || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: "AI returned no JSON", raw: text });

    const plan = JSON.parse(match[0]);
    const op = plan?.editPlan?.timelineOps?.find(o => o.op === "setInOut");
    if (!op) return res.status(422).json({ error: "No setInOut op", plan });

    const inSec  = Math.max(0, op.in);
    const outSec = Math.min(duration, op.out);

    // Trim
    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -y -ss ${inSec} -i "${tmpIn}" -t ${outSec - inSec} -c copy -avoid_negative_ts make_zero "${tmpOut}"`,
        (err, stdout, stderr) => err ? reject(new Error(stderr)) : resolve()
      );
    });

    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", `attachment; filename="${name}_highlight.mp4"`);
    res.set("X-AI-Summary", plan.editPlan.summary || "");
    res.set("X-Trim-In", String(inSec));
    res.set("X-Trim-Out", String(outSec));
    res.sendFile(tmpOut, () => cleanup(tmpIn, tmpOut));

  } catch (err) {
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
  console.log("Endpoints:");
  console.log("  POST /api/analyze    - AI frame analysis");
  console.log("  POST /api/trim       - Trim video");
  console.log("  POST /api/auto-edit  - Full pipeline (for bots)");
});
