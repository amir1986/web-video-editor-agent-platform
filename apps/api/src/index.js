const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.post("/api/ai/suggest", async (req, res) => {
  const { goal, currentState } = req.body;

  const prompt = `You are a video editing assistant. The user wants to edit a video.
Current state: ${JSON.stringify(currentState)}
User goal: ${goal}

Return ONLY a valid JSON object with this exact structure, no markdown, no explanation:
{
  "editPlan": {
    "timelineOps": [
      { "op": "setInOut", "in": <number_seconds>, "out": <number_seconds> }
    ],
    "summary": "<brief description of what you did>"
  }
}`;

  try {
    const response = await fetch("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3-coder:30b",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        stream: false
      })
    });

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";

    // extract JSON from response
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: "No JSON in response", raw: text });

    const parsed = JSON.parse(match[0]);
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3001, () => console.log("API running on http://localhost:3001"));
