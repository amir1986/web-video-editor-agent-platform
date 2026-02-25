const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.post("/api/ai/suggest", async (req, res) => {
  const { duration, frames } = req.body;

  const content = [
    {
      type: "text",
      text: `You are a video highlight editor. You receive ${frames?.length || 0} frames spread evenly across a ${parseFloat(duration).toFixed(1)}-second video.

Analyze the frames visually and find the single most exciting highlight moment (action, kill, goal, key event).
Ignore menus, loading screens, idle moments.

Respond ONLY with this exact JSON (no markdown, no extra text):
{"editPlan":{"timelineOps":[{"op":"setInOut","in":<number>,"out":<number>}],"summary":"<one sentence describing what you found>"}}`
    },
    ...(frames || []).map(f => ({
      type: "image_url",
      image_url: { url: f }
    }))
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
    if (!match) return res.status(422).json({ error: "No JSON", raw: text });
    res.json(JSON.parse(match[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3001, () => console.log(" API on http://localhost:3001"));
