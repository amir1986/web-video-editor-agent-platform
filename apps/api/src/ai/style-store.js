/**
 * Style Store — persistence layer for videographer style fingerprints.
 *
 * Each videographer gets a JSON file in the data directory:
 *   data/styles/<userId>.json
 *
 * Schema per file:
 *   {
 *     userId: string,
 *     projectCount: number,          // approved deliveries
 *     fingerprint: object | null,    // opaque JSON — Qwen decides the shape
 *     history: [                     // last N approved edit summaries
 *       { approvedAt, editPlanSummary, fingerprintDelta }
 *     ],
 *     createdAt: string,
 *     updatedAt: string,
 *   }
 *
 * No database dependency — flat JSON files, safe for Railway fs.
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.STYLE_DATA_DIR || path.join(__dirname, "../../../../data/styles");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(userId) {
  // Sanitize userId to prevent path traversal
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(DATA_DIR, `${safe}.json`);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Load a videographer's style profile.
 * Returns null if no profile exists yet.
 */
function loadProfile(userId) {
  ensureDir();
  const fp = filePath(userId);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Save a videographer's style profile (full replace).
 */
function saveProfile(userId, profile) {
  ensureDir();
  const fp = filePath(userId);
  fs.writeFileSync(fp, JSON.stringify(profile, null, 2));
}

/**
 * Get or create a profile for a videographer.
 * On first encounter, creates an empty profile.
 */
function getOrCreateProfile(userId) {
  let profile = loadProfile(userId);
  if (!profile) {
    profile = {
      userId,
      projectCount: 0,
      fingerprint: null,
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveProfile(userId, profile);
  }
  return profile;
}

/**
 * Update the fingerprint after an approved delivery.
 *
 * @param {string} userId
 * @param {object} newFingerprint   - Qwen's merged fingerprint
 * @param {object} editPlanSummary  - Summary of the approved edit (segments count, duration, etc.)
 */
function updateFingerprint(userId, newFingerprint, editPlanSummary = {}) {
  const profile = getOrCreateProfile(userId);
  profile.projectCount += 1;
  profile.fingerprint = newFingerprint;
  profile.history.push({
    approvedAt: new Date().toISOString(),
    editPlanSummary,
    projectNumber: profile.projectCount,
  });
  // Keep only last 20 history entries
  if (profile.history.length > 20) {
    profile.history = profile.history.slice(-20);
  }
  profile.updatedAt = new Date().toISOString();
  saveProfile(userId, profile);
  return profile;
}

/**
 * Delete a videographer's style profile (reset).
 */
function deleteProfile(userId) {
  const fp = filePath(userId);
  try { fs.unlinkSync(fp); } catch {}
}

/**
 * Minimum approved projects before fingerprint becomes the primary brief.
 */
const FINGERPRINT_THRESHOLD = 4;

module.exports = {
  loadProfile,
  saveProfile,
  getOrCreateProfile,
  updateFingerprint,
  deleteProfile,
  FINGERPRINT_THRESHOLD,
};
