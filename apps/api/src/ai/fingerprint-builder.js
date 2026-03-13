/**
 * Fingerprint Builder — post-approval step that sends the approved
 * EditPlan to Qwen for style analysis and fingerprint extraction.
 *
 * Qwen decides what parameters matter for this videographer's style.
 * We don't prescribe the schema — the fingerprint is opaque JSON.
 *
 * Flow:
 *   1. Receive approved EditPlan + video metadata
 *   2. Send to Qwen: "Analyze this approved edit, extract a style fingerprint"
 *   3. If existing fingerprint exists, ask Qwen to merge (weighted average)
 *   4. Store the result via style-store
 */

const { llmRequest } = require("./llm-client");
const { updateFingerprint } = require("./style-store");

/**
 * Build or update a videographer's style fingerprint from an approved edit.
 *
 * @param {string} userId            - Videographer identifier
 * @param {object} editPlan          - The approved EditPlan
 * @param {object} videoMeta         - { duration, fps, width, height }
 * @param {object|null} existingFp   - Current fingerprint (null for first project)
 * @param {number} projectCount      - How many projects approved so far (before this one)
 * @returns {object} Updated profile
 */
async function buildFingerprint(userId, editPlan, videoMeta, existingFp, projectCount) {
  const segments = editPlan.segments || [];
  const transitions = editPlan.transitions || [];

  // Compute observable metrics to feed Qwen
  const totalKept = segments.reduce((sum, s) => sum + (s.src_out - s.src_in), 0);
  const segDurations = segments.map(s => (s.src_out - s.src_in).toFixed(1) + "s");
  const transitionTypes = transitions.map(t => t.type);
  const hardCutRatio = transitions.length > 0
    ? (transitions.filter(t => t.type === "hard_cut").length / transitions.length * 100).toFixed(0)
    : "100";

  const editSummary = {
    segmentCount: segments.length,
    totalKeptSeconds: Math.round(totalKept),
    keepRatio: (totalKept / videoMeta.duration * 100).toFixed(0) + "%",
    segmentDurations: segDurations,
    transitionTypes,
    hardCutPercentage: hardCutRatio + "%",
    sourceDuration: videoMeta.duration,
    sourceResolution: `${videoMeta.width}x${videoMeta.height}`,
    sourceFps: videoMeta.fps,
  };

  const systemPrompt = existingFp
    ? buildMergePrompt(existingFp, projectCount)
    : buildFirstPrompt();

  const userContent = `APPROVED EDIT DETAILS:
${JSON.stringify(editSummary, null, 2)}

FULL EDIT PLAN:
${JSON.stringify({ segments: editPlan.segments, transitions: editPlan.transitions }, null, 2)}

Analyze this approved edit and ${existingFp ? "merge with the existing fingerprint" : "extract the initial style fingerprint"}.`;

  try {
    const fingerprint = await llmRequest(systemPrompt, userContent, { useVision: false });

    // Store the updated fingerprint
    const profile = updateFingerprint(userId, fingerprint, editSummary);
    console.log(`[FINGERPRINT] Updated for user=${userId}, project #${profile.projectCount}, keys=${Object.keys(fingerprint).join(", ")}`);
    return profile;
  } catch (err) {
    console.error(`[FINGERPRINT] Failed to build fingerprint for user=${userId}: ${err.message}`);
    // Non-fatal — don't block the user's workflow
    // Still increment the project count with null fingerprint delta
    const profile = updateFingerprint(userId, existingFp, editSummary);
    return profile;
  }
}

function buildFirstPrompt() {
  return `You are a style analysis engine for a video editing platform. You have just received the first approved edit from a new videographer.

Your job: Analyze the editing decisions and extract a STYLE FINGERPRINT as a JSON object.

YOU decide which parameters are relevant. Think about:
- Cut rhythm: average segment duration, segment count preference, cuts per minute
- Pacing: keep ratio (how much of the original they keep), whether they prefer tight or loose edits
- Transition style: ratio of hard cuts to soft transitions, preferred transition types
- Narrative structure: do they lead with the strongest moment or build chronologically?
- Segment selection: do they favor short punchy clips or longer flowing segments?
- Any other patterns you observe

This is the FIRST project — you're establishing the baseline. Be descriptive but don't over-index on a single data point.

Return ONLY valid JSON — the style fingerprint object. No markdown, no explanation.`;
}

function buildMergePrompt(existingFp, projectCount) {
  return `You are a style analysis engine for a video editing platform. You have a videographer's existing style fingerprint from ${projectCount} approved projects, and a new approved edit to incorporate.

EXISTING FINGERPRINT:
${JSON.stringify(existingFp, null, 2)}

Your job: Analyze the new approved edit and MERGE it with the existing fingerprint using weighted averaging. The existing fingerprint carries the weight of ${projectCount} projects; the new edit is 1 project.

Rules:
- Numeric values: weighted average — (existing * ${projectCount} + new) / ${projectCount + 1}
- Categorical preferences: update frequencies/ratios, don't discard existing data
- If the new edit reveals a parameter not in the existing fingerprint, add it
- If an existing parameter is contradicted by the new edit, adjust gradually — don't flip
- Preserve the structure of the existing fingerprint where possible

Return ONLY valid JSON — the merged style fingerprint object. No markdown, no explanation.`;
}

module.exports = { buildFingerprint };
