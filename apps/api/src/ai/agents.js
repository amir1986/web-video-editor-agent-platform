/**
 * Multi-agent video editing system.
 *
 * Pipeline: Cut → Structure → Continuity → Transition → Constraints
 *
 * Each agent receives the video metadata + frames + previous agent output,
 * makes its own decisions via LLM (or deterministic fallback), and passes
 * the evolving EditPlan to the next agent.
 *
 * The system produces an EditPlan JSON that an external renderer executes.
 * Agents ONLY handle: cuts, structure, continuity, transitions, constraint validation.
 * They do NOT do: color grading, audio mixing, music, captions, VFX, thumbnails.
 */

const OLLAMA_URL = "http://localhost:11434/v1/chat/completions";
const VISION_MODEL = process.env.VISION_MODEL || "qwen2.5vl:7b";
const TEXT_MODEL = process.env.TEXT_MODEL || VISION_MODEL;

// ---------------------------------------------------------------------------
// LLM helper
// ---------------------------------------------------------------------------

async function llmRequest(systemPrompt, userContent, { useVision = false, temperature = 0 } = {}) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: useVision ? VISION_MODEL : TEXT_MODEL,
      messages,
      temperature,
      stream: false,
    }),
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("LLM returned no JSON: " + text.slice(0, 300));
  return JSON.parse(match[0]);
}

// ---------------------------------------------------------------------------
// 1. Cut Agent — selects the best parts and determines cut points
// ---------------------------------------------------------------------------

async function runCutAgent(videoMeta, frames) {
  const { duration, fps, width, height } = videoMeta;
  const timestamps = frames.map(f => `${f.timestamp}s`).join(", ");

  const systemPrompt = `You are the CUT AGENT — a world-class professional video editor whose only job is deciding what to keep and what to remove.

You receive video metadata and sampled frames. You select the strongest segments to keep for a highlight edit.

RULES:
- Select 2-6 segments that together cover 30%-60% of the original duration.
- Total kept time MUST be less than ${(duration * 0.75).toFixed(1)} seconds.
- Each segment: {"id": "s1", "src_in": <seconds>, "src_out": <seconds>, "reason": "<why>"}
- CUT OUT: dead air, filler, repetition, long pauses, boring parts, intros/outros if uninteresting.
- KEEP: action, key points, emotional peaks, humor, strong visuals, story beats.
- Segments must not overlap and must be sorted by src_in.
- Do NOT change the resolution or aspect ratio. Your job is ONLY cut decisions.

Return ONLY valid JSON:
{"segments":[{"id":"s1","src_in":0,"src_out":8,"reason":"..."},...],"cut_notes":"<one sentence summary>"}`;

  const userText = `VIDEO: duration=${duration.toFixed(1)}s, ${width}x${height}, ${fps}fps. Frame timestamps: ${timestamps}.

Analyze the video and decide which parts to keep for the highlight reel.`;

  const userContent = frames.length > 0
    ? [{ type: "text", text: userText }, ...frames.map(f => ({ type: "image_url", image_url: { url: f.base64 } }))]
    : userText;

  try {
    const result = await llmRequest(systemPrompt, userContent, { useVision: frames.length > 0 });
    if (result.segments?.length) return result;
    throw new Error("No segments returned");
  } catch (err) {
    // Vision not supported or failed — retry text-only
    if (frames.length > 0) {
      try {
        const result = await llmRequest(systemPrompt, userText, { useVision: false });
        if (result.segments?.length) return result;
      } catch {}
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 2. Structure Agent — arranges segments into a coherent highlights edit
// ---------------------------------------------------------------------------

async function runStructureAgent(videoMeta, cutResult) {
  const { duration, width, height } = videoMeta;
  const segmentsJSON = JSON.stringify(cutResult.segments);

  const systemPrompt = `You are the STRUCTURE AGENT — a professional video editor who arranges selected clips into a coherent, engaging highlights edit.

You receive segments chosen by the Cut Agent. Your job is to:
- Reorder segments if a different order creates a better narrative arc (hook → buildup → climax → resolution).
- Adjust segment boundaries slightly (±1s) if it improves pacing or removes awkward frames at edges.
- Merge segments that are very close together (gap < 1s) into one.
- Split overly long segments (>30% of total duration) if the middle has a dead spot.
- Ensure the final edit has a strong opening and a satisfying ending.

Constraints: total kept duration must stay between 30%-75% of ${duration.toFixed(1)}s. Do NOT alter resolution (${width}x${height}).

Input segments: ${segmentsJSON}

Return ONLY valid JSON:
{"segments":[{"id":"s1","src_in":<sec>,"src_out":<sec>,"reason":"..."},...],"structure_notes":"<what you changed and why>"}`;

  try {
    return await llmRequest(systemPrompt, `Original duration: ${duration.toFixed(1)}s. Arrange these segments into the best possible highlight edit.`);
  } catch {
    // Fallback: return cut result as-is
    return { segments: cutResult.segments, structure_notes: "passthrough — structure agent unavailable" };
  }
}

// ---------------------------------------------------------------------------
// 3. Continuity Agent — reviews for jarring cuts and fixes flow
// ---------------------------------------------------------------------------

async function runContinuityAgent(videoMeta, structureResult) {
  const { duration } = videoMeta;
  const segmentsJSON = JSON.stringify(structureResult.segments);

  const systemPrompt = `You are the CONTINUITY AGENT — an expert editor focused on smooth flow between cuts.

You receive an ordered list of segments. Review adjacent pairs for potential jarring transitions:
- Large jumps in visual content or motion between segment boundaries
- Segments that end or start mid-sentence (if transcript context suggests speech)
- Very short segments (<1s) that would flash by too fast
- Segments where the ending of one and beginning of next are visually too similar (jump-cut feel)

Fixes you can make:
- Extend a segment boundary by up to 0.5s to include a natural pause point
- Trim a segment boundary by up to 0.5s to remove a jarring frame
- Flag specific cuts as "needs_soft_transition" for the Transition Agent
- Remove segments shorter than 0.5s that add nothing

IMPORTANT: Do NOT add new segments. Do NOT change resolution. Only adjust existing boundaries and flag transitions.

Input segments: ${segmentsJSON}

Return ONLY valid JSON:
{"segments":[{"id":"s1","src_in":<sec>,"src_out":<sec>,"reason":"...","needs_soft_transition":false},...],"continuity_notes":"<what you adjusted>"}`;

  try {
    return await llmRequest(systemPrompt, `Video duration: ${duration.toFixed(1)}s. Review these segments for continuity issues and fix them.`);
  } catch {
    // Fallback: passthrough, mark no transitions needed
    const segments = (structureResult.segments || []).map(s => ({ ...s, needs_soft_transition: false }));
    return { segments, continuity_notes: "passthrough — continuity agent unavailable" };
  }
}

// ---------------------------------------------------------------------------
// 4. Transition Agent — assigns transitions between segments
// ---------------------------------------------------------------------------

function runTransitionAgent(videoMeta, continuityResult) {
  // Deterministic agent — no LLM needed. Professional editors use hard cuts
  // for 90%+ of transitions. Soft transitions only when specifically flagged
  // by the continuity agent or when the time gap between segments is large.
  const segments = continuityResult.segments || [];
  const transitions = [];

  for (let i = 0; i < segments.length - 1; i++) {
    const curr = segments[i];
    const next = segments[i + 1];
    const gap = next.src_in - curr.src_out;

    let type = "hard_cut";

    if (curr.needs_soft_transition) {
      // Continuity agent flagged this as needing a softer transition
      type = gap > 10 ? "dip_to_black" : "dissolve";
    } else if (gap > 30) {
      // Very large time jump — signal the change
      type = "dip_to_black";
    } else if (gap > 15) {
      // Moderate time jump
      type = "fade";
    }
    // Everything else: hard_cut (the professional default)

    transitions.push({ from: curr.id, to: next.id, type });
  }

  return {
    transitions,
    transition_notes: `Assigned ${transitions.length} transitions: ${transitions.filter(t => t.type !== "hard_cut").length} soft, rest hard cuts`,
  };
}

// ---------------------------------------------------------------------------
// 5. Constraints Agent — validates the plan obeys all hard constraints
// ---------------------------------------------------------------------------

function runConstraintsAgent(videoMeta, segments, transitions) {
  const { duration, width, height } = videoMeta;
  const issues = [];

  // Validate segments are sorted and non-overlapping
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.src_in < 0) { s.src_in = 0; issues.push(`${s.id}: src_in was negative, clamped to 0`); }
    if (s.src_out > duration) { s.src_out = parseFloat(duration.toFixed(1)); issues.push(`${s.id}: src_out exceeded duration, clamped`); }
    if (s.src_out <= s.src_in) { issues.push(`${s.id}: zero/negative duration, removed`); segments.splice(i, 1); i--; continue; }
    if (i > 0 && s.src_in < segments[i - 1].src_out) {
      // Overlapping — trim start of current to fix
      s.src_in = segments[i - 1].src_out;
      issues.push(`${s.id}: overlapped previous segment, trimmed`);
      if (s.src_out <= s.src_in) { segments.splice(i, 1); i--; continue; }
    }
  }

  // Map old IDs to positions BEFORE reassigning
  const oldIdToIndex = {};
  segments.forEach((s, i) => { oldIdToIndex[s.id] = i; });

  // Re-assign sequential IDs
  segments.forEach((s, i) => { s.id = `s${i + 1}`; });

  // Rebuild transitions using position-based matching (old IDs no longer exist)
  const fixedTransitions = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const existing = transitions.find(t => oldIdToIndex[t.from] === i);
    fixedTransitions.push({
      from: segments[i].id,
      to: segments[i + 1].id,
      type: existing?.type || "hard_cut",
    });
  }

  // Validate total duration constraint (30-65% of original)
  const totalKept = segments.reduce((sum, s) => sum + (s.src_out - s.src_in), 0);
  const ratio = totalKept / duration;
  if (ratio > 0.75) {
    issues.push(`Total kept ${(ratio * 100).toFixed(0)}% exceeds 75% — not a highlights edit`);
  }

  // Resolution/aspect constraint is always enforced at render level
  const constraints_ok = issues.length === 0 || !issues.some(iss => iss.includes("not a highlights edit"));

  return {
    segments: segments.map(s => ({ id: s.id, src_in: s.src_in, src_out: s.src_out })),
    transitions: fixedTransitions,
    render_constraints: {
      keep_resolution: true,
      keep_aspect_ratio: true,
      no_stretch: true,
      target_width: width,
      target_height: height,
    },
    notes: {
      constraints_ok,
      issues: issues.length ? issues : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Fallback: deterministic highlight segments when all AI agents fail
// ---------------------------------------------------------------------------

function buildFallbackCutResult(duration) {
  if (duration <= 10) {
    return {
      segments: [{ id: "s1", src_in: 0, src_out: Math.round(duration * 0.7 * 10) / 10, reason: "short video — trimmed ending" }],
      cut_notes: "Short video — kept first 70%",
    };
  }
  if (duration <= 30) {
    const seg1End = Math.round(duration * 0.35 * 10) / 10;
    const seg2Start = Math.round(duration * 0.45 * 10) / 10;
    const seg2End = Math.round(duration * 0.85 * 10) / 10;
    return {
      segments: [
        { id: "s1", src_in: 0, src_out: seg1End, reason: "opening section" },
        { id: "s2", src_in: seg2Start, src_out: seg2End, reason: "main highlight" },
      ],
      cut_notes: "Short clip — kept best parts",
    };
  }
  const segDur = duration * 0.15;
  const s2Start = Math.round(duration * 0.25 * 10) / 10;
  const s3Start = Math.round(duration * 0.50 * 10) / 10;
  const closeStart = Math.round(duration * 0.85 * 10) / 10;
  return {
    segments: [
      { id: "s1", src_in: 0, src_out: Math.round(segDur * 10) / 10, reason: "opening hook" },
      { id: "s2", src_in: s2Start, src_out: Math.round((s2Start + segDur) * 10) / 10, reason: "early highlight" },
      { id: "s3", src_in: s3Start, src_out: Math.round((s3Start + segDur) * 10) / 10, reason: "mid highlight" },
      { id: "s4", src_in: closeStart, src_out: Math.round(duration * 10) / 10, reason: "closing moment" },
    ],
    cut_notes: "Time-based fallback highlights",
  };
}

// ---------------------------------------------------------------------------
// Orchestrator — runs the full agent pipeline
// ---------------------------------------------------------------------------

/**
 * Run the multi-agent editing pipeline.
 *
 * @param {object} videoMeta - { duration, fps, width, height }
 * @param {Array}  frames    - [{ timestamp, base64 }, ...] (may be empty)
 * @returns {object} EditPlan JSON
 */
async function runEditPipeline(videoMeta, frames = []) {
  const log = (agent, msg) => console.log(`[${agent}] ${msg}`);

  // 1. Cut Agent
  log("CUT", "Selecting best segments...");
  let cutResult;
  try {
    cutResult = await runCutAgent(videoMeta, frames);
    log("CUT", `Selected ${cutResult.segments?.length} segments: ${cutResult.cut_notes || ""}`);
  } catch (err) {
    log("CUT", `AI failed (${err.message}), using time-based fallback`);
    cutResult = buildFallbackCutResult(videoMeta.duration);
  }

  // Validate cut result has usable segments
  const validSegments = (cutResult.segments || []).filter(
    s => typeof s.src_in === "number" && typeof s.src_out === "number" && s.src_out > s.src_in
  );
  if (!validSegments.length) {
    log("CUT", "No valid segments from AI, using fallback");
    cutResult = buildFallbackCutResult(videoMeta.duration);
  } else {
    cutResult.segments = validSegments;
  }

  // Check if AI returned near-full video (>90%) — override with fallback
  const totalKept = cutResult.segments.reduce((sum, s) => sum + (s.src_out - s.src_in), 0);
  if (totalKept >= videoMeta.duration * 0.75) {
    log("CUT", `Segments cover ${(totalKept / videoMeta.duration * 100).toFixed(0)}% — too much, using fallback`);
    cutResult = buildFallbackCutResult(videoMeta.duration);
  }

  // 2. Structure Agent
  log("STRUCTURE", "Arranging segments for best narrative...");
  let structureResult;
  try {
    structureResult = await runStructureAgent(videoMeta, cutResult);
    log("STRUCTURE", structureResult.structure_notes || "done");
  } catch (err) {
    log("STRUCTURE", `Failed (${err.message}), keeping original order`);
    structureResult = { segments: cutResult.segments, structure_notes: "passthrough" };
  }

  // 3. Continuity Agent
  log("CONTINUITY", "Checking for jarring cuts...");
  let continuityResult;
  try {
    continuityResult = await runContinuityAgent(videoMeta, structureResult);
    log("CONTINUITY", continuityResult.continuity_notes || "done");
  } catch (err) {
    log("CONTINUITY", `Failed (${err.message}), skipping`);
    continuityResult = {
      segments: (structureResult.segments || []).map(s => ({ ...s, needs_soft_transition: false })),
      continuity_notes: "skipped",
    };
  }

  // 4. Transition Agent (deterministic — no LLM)
  log("TRANSITION", "Assigning transitions...");
  const transitionResult = runTransitionAgent(videoMeta, continuityResult);
  log("TRANSITION", transitionResult.transition_notes);

  // 5. Constraints Agent (deterministic — validates and fixes)
  log("CONSTRAINTS", "Validating plan...");
  const editPlan = runConstraintsAgent(
    videoMeta,
    continuityResult.segments || [],
    transitionResult.transitions || []
  );
  log("CONSTRAINTS", editPlan.notes.constraints_ok ? "All constraints OK" : `Issues: ${editPlan.notes.issues?.join("; ")}`);

  return editPlan;
}

module.exports = { runEditPipeline, buildFallbackCutResult };
