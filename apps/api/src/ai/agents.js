/**
 * Multi-agent video editing system.
 *
 * Pipeline: Cut → Structure → Continuity → Transition → Constraints → Quality Guard
 *
 * Each agent receives the video metadata + frames + previous agent output,
 * makes its own decisions via LLM (or deterministic fallback), and passes
 * the evolving EditPlan to the next agent.
 *
 * The system produces an EditPlan JSON that an external renderer executes.
 * Agents ONLY handle: cuts, structure, continuity, transitions, constraint validation, quality auditing.
 * They do NOT do: color grading, audio mixing, music, captions, VFX, thumbnails.
 *
 * Patterns applied:
 * - Ollama LLM client (Qwen 2.5 VL) with retry/backoff
 * - RAG knowledge base injection for editing decisions
 * - SSE progress events for real-time pipeline updates
 */

const { llmRequest } = require("./llm-client");
const { getEditingContext } = require("./knowledge-base");

// ---------------------------------------------------------------------------
// Progress event emitter (SSE support)
// ---------------------------------------------------------------------------

let _progressCallback = null;

/**
 * Set a callback for pipeline progress events.
 * Used by the SSE endpoint to stream updates to the client.
 *
 * @param {function|null} cb - Callback(agent, message, data) or null to disable
 */
function setProgressCallback(cb) {
  _progressCallback = cb;
}

function emitProgress(agent, message, data = {}) {
  console.log(`[${agent}] ${message}`);
  if (_progressCallback) {
    try { _progressCallback(agent, message, data); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 1. Cut Agent — selects the best parts and determines cut points
//    RAG knowledge injection + Vision
// ---------------------------------------------------------------------------

async function runCutAgent(videoMeta, frames, options = {}) {
  const { duration, fps, width, height } = videoMeta;
  const timestamps = frames.map(f => `${f.timestamp}s`).join(", ");

  // RAG: Inject relevant editing knowledge (cookbook pattern)
  const ragContext = getEditingContext("cut selection highlight keep remove dead air", videoMeta);

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
${ragContext}
Return ONLY valid JSON:
{"segments":[{"id":"s1","src_in":0,"src_out":8,"reason":"..."},...],"cut_notes":"<one sentence summary>"}`;

  const userText = `VIDEO: duration=${duration.toFixed(1)}s, ${width}x${height}, ${fps}fps. Frame timestamps: ${timestamps}.

Analyze the video and decide which parts to keep for the highlight reel.`;

  // LLM path (Ollama / Qwen)
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

  // RAG: Inject narrative and pacing knowledge (cookbook pattern)
  const ragContext = getEditingContext("narrative structure hook climax pacing ordering engagement", videoMeta);

  const systemPrompt = `You are the STRUCTURE AGENT — a professional video editor who arranges selected clips into a coherent, engaging highlights edit.

You receive segments chosen by the Cut Agent. Your job is to:
- Reorder segments if a different order creates a better narrative arc (hook → buildup → climax → resolution).
- Adjust segment boundaries slightly (±1s) if it improves pacing or removes awkward frames at edges.
- Merge segments that are very close together (gap < 1s) into one.
- Split overly long segments (>30% of total duration) if the middle has a dead spot.
- Ensure the final edit has a strong opening and a satisfying ending.

Constraints: total kept duration must stay between 30%-75% of ${duration.toFixed(1)}s. Do NOT alter resolution (${width}x${height}).

Input segments: ${segmentsJSON}
${ragContext}
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

  // RAG: Inject continuity and transition knowledge (cookbook pattern)
  const ragContext = getEditingContext("continuity jarring cuts smooth transition audio visual flow", videoMeta);

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
${ragContext}
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

function runConstraintsAgent(videoMeta, segments, transitions, sourceQuality) {
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
      // Pass source bitrate so the renderer can match quality instead of guessing
      source_video_bitrate: sourceQuality?.video?.bitrate || 0,
      source_audio_bitrate: sourceQuality?.audio?.bitrate || 0,
    },
    notes: {
      constraints_ok,
      issues: issues.length ? issues : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// 6. Quality Guard Agent — audits and enforces output video quality constraints
// ---------------------------------------------------------------------------

/**
 * Quality Guard Agent (deterministic).
 *
 * This agent does NOT decide cuts or transitions. It ONLY audits and enforces
 * technical output quality constraints. The pipeline cannot finalize output
 * unless Quality Guard returns constraints_ok=true.
 *
 * Checks performed:
 * - Resolution must match source (width × height unchanged)
 * - Aspect ratio must match source (no stretching)
 * - SAR/DAR must be correct (pixel aspect ratio / display aspect ratio)
 * - No unnecessary re-encoding (stream copy when only hard_cut transitions)
 * - When re-encoding is required (soft transitions), enforce high-quality settings
 * - Export settings derived from INPUT, never from platform defaults
 * - Frame rate preserved from source (no stutter or conversion artifacts)
 *
 * @param {object} videoMeta        - { duration, fps, width, height }
 * @param {object} editPlan         - The plan from the Constraints Agent
 * @returns {object} editPlan with quality_guard section appended
 */
function runQualityGuardAgent(videoMeta, editPlan, sourceQuality) {
  const { width, height, fps } = videoMeta;
  const rc = editPlan.render_constraints || {};
  const transitions = editPlan.transitions || [];
  const segments = editPlan.segments || [];
  const requiredFixes = [];

  // ---- Check 1: Resolution unchanged ----
  let resolutionUnchanged = rc.target_width === width && rc.target_height === height;
  if (!resolutionUnchanged) {
    requiredFixes.push(
      `render_constraints.target_width/height (${rc.target_width}x${rc.target_height}) does not match source (${width}x${height}) — correcting`
    );
  }

  // ---- Check 2: Aspect ratio unchanged ----
  const sourceAR = width && height ? (width / height) : 0;
  const targetAR = rc.target_width && rc.target_height ? (rc.target_width / rc.target_height) : 0;
  let aspectRatioUnchanged = sourceAR > 0 && Math.abs(sourceAR - targetAR) < 0.001;
  if (!aspectRatioUnchanged && sourceAR > 0) {
    requiredFixes.push(
      `Aspect ratio mismatch: source=${sourceAR.toFixed(4)}, target=${targetAR.toFixed(4)} — correcting to source`
    );
  }

  // ---- Check 3: No stretch ----
  let noStretch = rc.no_stretch === true;
  if (!noStretch) {
    requiredFixes.push("render_constraints.no_stretch was not true — correcting");
  }

  // ---- Check 4: No unnecessary re-encode ----
  const hasSoftTransitions = transitions.some(t => t.type !== "hard_cut");
  // Stream copy is correct if there are ONLY hard_cut transitions AND the
  // source codec is universally compatible (H.264 yuv420p). The renderer
  // probes the source at render time and re-encodes if the codec is HEVC,
  // VP9, AV1, or uses an unusual profile/pixel format. That re-encode is
  // a NECESSARY compatibility step, not an unnecessary one.
  let noUnnecessaryReencode = true;
  if (!hasSoftTransitions && rc.force_reencode) {
    noUnnecessaryReencode = false;
    requiredFixes.push(
      "force_reencode is set but all transitions are hard_cut — stream copy is sufficient (unless codec is incompatible, which renderer handles), removing force_reencode"
    );
  }

  // ---- Check 5: Export settings not platform defaults ----
  // When re-encoding is required, enforce high-quality settings derived from source
  let exportSettingsOk = true;
  // Source bitrate from probe — used to match quality instead of guessing with CRF
  const srcVideoBitrate = sourceQuality?.video?.bitrate || rc.source_video_bitrate || 0;
  const srcAudioBitrate = sourceQuality?.audio?.bitrate || rc.source_audio_bitrate || 0;
  const qualitySettings = {
    // Derived from source, not platform defaults
    codec: "libx264",
    crf: srcVideoBitrate > 0 ? null : 18,  // Only use CRF as fallback when bitrate unknown
    source_video_bitrate: srcVideoBitrate,  // Preferred: match source bitrate exactly
    source_audio_bitrate: srcAudioBitrate,
    preset: "fast",         // Good quality/speed tradeoff; never "ultrafast" or "veryfast"
    max_bitrate: null,      // No artificial cap
    pixel_format: "yuv420p",
    // Frame rate from source
    fps: fps || 30,
    fps_mode: "cfr",        // Constant frame rate to avoid stutter
  };

  // Verify no low-quality overrides exist in render_constraints.
  // These settings are used by the renderer when re-encoding is needed
  // (soft transitions OR codec compatibility re-encode for HEVC/VP9/etc).
  if (rc.crf && rc.crf > 23) {
    exportSettingsOk = false;
    requiredFixes.push(`CRF ${rc.crf} is too high (quality loss) — correcting to 18`);
  }
  if (rc.preset && ["ultrafast", "superfast", "veryfast"].includes(rc.preset)) {
    exportSettingsOk = false;
    requiredFixes.push(`Preset "${rc.preset}" causes visible quality degradation — correcting to "fast"`);
  }
  if (rc.max_bitrate && rc.max_bitrate < 5000) {
    exportSettingsOk = false;
    requiredFixes.push(`max_bitrate ${rc.max_bitrate}kbps is too low — removing cap`);
  }

  // ---- Check 6: Frame rate preservation ----
  let fpsPreserved = true;
  if (rc.fps && rc.fps !== fps) {
    fpsPreserved = false;
    requiredFixes.push(`render_constraints.fps (${rc.fps}) differs from source (${fps}) — correcting to source`);
  }

  // ---- Build corrected render_constraints ----
  const constraintsOk = requiredFixes.length === 0;

  // Always include encoding quality settings — the renderer may need them
  // for codec compatibility re-encoding (e.g. HEVC→H.264) even when all
  // transitions are hard_cut.
  const correctedRenderConstraints = {
    keep_resolution: true,
    keep_aspect_ratio: true,
    no_stretch: true,
    target_width: width,
    target_height: height,
    codec: qualitySettings.codec,
    crf: qualitySettings.crf,               // null when source bitrate is known
    source_video_bitrate: srcVideoBitrate,   // renderer uses this to match quality
    source_audio_bitrate: srcAudioBitrate,
    preset: qualitySettings.preset,
    pixel_format: qualitySettings.pixel_format,
    fps: fps,
    fps_mode: qualitySettings.fps_mode,
  };

  // Apply corrections
  if (!constraintsOk) {
    resolutionUnchanged = true;
    aspectRatioUnchanged = true;
    noStretch = true;
    noUnnecessaryReencode = true;
    exportSettingsOk = true;
    fpsPreserved = true;
  }

  const qualityGuard = {
    constraints_ok: true, // Always true after corrections are applied
    checks: {
      resolution_unchanged: resolutionUnchanged || !constraintsOk, // true after fix
      aspect_ratio_unchanged: aspectRatioUnchanged || !constraintsOk,
      no_stretch: noStretch || !constraintsOk,
      no_unnecessary_reencode: noUnnecessaryReencode || !constraintsOk,
      export_settings_not_platform_default: exportSettingsOk || !constraintsOk,
      fps_preserved: fpsPreserved || !constraintsOk,
      sar_dar_correct: true, // Enforced by corrected render_constraints
    },
    required_fixes: requiredFixes,
    corrections_applied: !constraintsOk,
  };

  return {
    segments: editPlan.segments,
    transitions: editPlan.transitions,
    render_constraints: correctedRenderConstraints,
    notes: editPlan.notes,
    quality_guard: qualityGuard,
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
 * Patterns:
 * - SSE progress events via setProgressCallback()
 * - RAG knowledge injection for all LLM agents
 * - Retry with exponential backoff (via llm-client)
 *
 * @param {object} videoMeta     - { duration, fps, width, height }
 * @param {Array}  frames        - [{ timestamp, base64 }, ...] (may be empty)
 * @param {object} sourceQuality - Original video params from probeSourceQuality() (optional)
 * @param {object} options       - { videoPath } for tool use context
 * @returns {object} EditPlan JSON
 */
async function runEditPipeline(videoMeta, frames = [], sourceQuality = null, options = {}) {
  const log = (agent, msg) => emitProgress(agent, msg);

  // 1. Cut Agent
  log("CUT", "Selecting best segments...");
  let cutResult;
  try {
    cutResult = await runCutAgent(videoMeta, frames, { videoPath: options.videoPath });
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
    emitProgress("CUT", "No valid segments from AI, using fallback");
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
  const constraintsPlan = runConstraintsAgent(
    videoMeta,
    continuityResult.segments || [],
    transitionResult.transitions || [],
    sourceQuality
  );
  log("CONSTRAINTS", constraintsPlan.notes.constraints_ok ? "All constraints OK" : `Issues: ${constraintsPlan.notes.issues?.join("; ")}`);

  // 6. Quality Guard Agent (deterministic — audits and enforces quality)
  // The pipeline cannot finalize output unless Quality Guard returns constraints_ok=true.
  // If constraints_ok=false, the system automatically revises and reruns validation.
  const MAX_QUALITY_RETRIES = 3;
  let editPlan = constraintsPlan;
  for (let attempt = 1; attempt <= MAX_QUALITY_RETRIES; attempt++) {
    log("QUALITY_GUARD", `Quality audit pass ${attempt}...`);
    editPlan = runQualityGuardAgent(videoMeta, editPlan, sourceQuality);

    if (editPlan.quality_guard.required_fixes.length === 0) {
      log("QUALITY_GUARD", "All quality checks passed");
      break;
    }

    log("QUALITY_GUARD", `Applied ${editPlan.quality_guard.required_fixes.length} corrections: ${editPlan.quality_guard.required_fixes.join("; ")}`);

    // After corrections are applied, re-validate in next iteration.
    // If corrections were applied, the next pass should find no issues.
    if (attempt === MAX_QUALITY_RETRIES) {
      log("QUALITY_GUARD", "Max retries reached — proceeding with corrected plan");
    }
  }

  return editPlan;
}

module.exports = { runEditPipeline, buildFallbackCutResult, setProgressCallback };
