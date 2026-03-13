/**
 * Style Resolver — pre-pipeline step that loads a videographer's
 * style fingerprint and formats it for injection into agent prompts.
 *
 * Decision logic:
 *   - Projects 1-3 (or no profile): return null → pipeline runs as v1
 *   - Project 4+: return formatted fingerprint context string
 */

const { getOrCreateProfile, FINGERPRINT_THRESHOLD } = require("./style-store");

/**
 * Resolve the style context for a videographer.
 *
 * @param {string|null} userId - Videographer identifier (null = anonymous/v1 mode)
 * @returns {{ profile: object, styleContext: string|null, mode: "discovery"|"guided" }}
 */
function resolveStyle(userId) {
  if (!userId) {
    return { profile: null, styleContext: null, mode: "discovery" };
  }

  const profile = getOrCreateProfile(userId);

  // Not enough approved projects yet — discovery mode (v1 behavior)
  if (profile.projectCount < FINGERPRINT_THRESHOLD || !profile.fingerprint) {
    const remaining = FINGERPRINT_THRESHOLD - profile.projectCount;
    return {
      profile,
      styleContext: null,
      mode: "discovery",
      remaining,
    };
  }

  // Enough data — build the style context for prompt injection
  const styleContext = formatStyleContext(profile);
  return {
    profile,
    styleContext,
    mode: "guided",
  };
}

/**
 * Format a fingerprint into a prompt-injectable string.
 * The fingerprint is opaque JSON from Qwen — we render it as-is.
 */
function formatStyleContext(profile) {
  const fp = profile.fingerprint;
  if (!fp) return null;

  return `
--- VIDEOGRAPHER STYLE FINGERPRINT (Project #${profile.projectCount + 1}) ---
This videographer has ${profile.projectCount} approved edits. Their established style fingerprint is the PRIMARY creative brief. Match this style closely unless the footage clearly demands a different approach.

${JSON.stringify(fp, null, 2)}

IMPORTANT: This fingerprint represents the videographer's preferred editing style learned from their ${profile.projectCount} approved projects. Use it as your primary guide for all creative decisions — cut rhythm, segment selection, pacing, transitions, narrative structure. Only deviate when the footage content makes the fingerprint inapplicable.
--- END STYLE FINGERPRINT ---`;
}

module.exports = { resolveStyle, formatStyleContext };
