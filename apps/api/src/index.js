const express = require("express");
const cors = require("cors");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
app.use(cors());
app.use(express.json({ limit: "500mb" }));

app.post("/api/ai/suggest", async (req, res) => {
  const { duration, frames } = req.body;
  const content = [
    {
      type: "text",
      text: `You are a video highlight editor. You receive ${frames?.length || 0} frames spread evenly across a ${parseFloat(duration).toFixed(1)}-second video.
Analyze the frames visually and find the single most exciting highlight moment.
Ignore menus, loading screens, idle moments. Keep action, kills, goals, key events.
Respond ONLY with this exact JSON (no markdown, no extra text):
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

app.post("/api/export", express.raw({ type: "video/*", limit: "500mb" }), async (req, res) => {
  const inSec = parseFloat(req.query.in);
  const outSec = parseFloat(req.query.out);
  const tmpIn = path.join(os.tmpdir(), `input_${Date.now()}.mp4`);
  const tmpOut = path.join(os.tmpdir(), `output_${Date.now()}.mp4`);

  try {
    fs.writeFileSync(tmpIn, req.body);
    execSync(`ffmpeg -y -ss ${inSec} -i "${tmpIn}" -t ${outSec - inSec} -c copy "${tmpOut}"`);
    const result = fs.readFileSync(tmpOut);
    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", "attachment; filename=highlight.mp4");
    res.send(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut); } catch {}
  }
});

app.listen(3001, () => console.log("API on http://localhost:3001"));
