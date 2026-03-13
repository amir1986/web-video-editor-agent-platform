/**
 * Style Store — SQLite persistence layer for videographer style fingerprints.
 *
 * Tables:
 *   profiles          — one row per videographer (fingerprint, project count)
 *   delivery_history  — one row per approved delivery (full history, no cap)
 *
 * Exported API is identical to the previous flat-file implementation so that
 * all consumers (style-resolver, fingerprint-builder, index.js, tests) work
 * without changes.
 *
 * To swap to PostgreSQL: replace the `db.*` calls with `pg` equivalents.
 * The SQL is standard — no SQLite-specific syntax beyond AUTOINCREMENT.
 */

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, "../../../../data");
const DB_PATH = process.env.STYLE_DB_PATH || path.join(DATA_DIR, "styles.db");

let _db = null;

function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(SCHEMA);
  return _db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  user_id        TEXT PRIMARY KEY,
  project_count  INTEGER NOT NULL DEFAULT 0,
  fingerprint    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_history (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  project_number       INTEGER NOT NULL,
  edit_plan_summary    TEXT,
  fingerprint_snapshot TEXT,
  source_channel       TEXT,
  video_duration       REAL,
  video_resolution     TEXT,
  approved_at          TEXT NOT NULL,
  UNIQUE(user_id, project_number)
);

CREATE INDEX IF NOT EXISTS idx_history_user     ON delivery_history(user_id);
CREATE INDEX IF NOT EXISTS idx_history_approved ON delivery_history(approved_at);
`;

// ---------------------------------------------------------------------------
// Helpers — convert between DB rows and the profile objects callers expect
// ---------------------------------------------------------------------------

function rowToProfile(row, history) {
  return {
    userId: row.user_id,
    projectCount: row.project_count,
    fingerprint: row.fingerprint ? JSON.parse(row.fingerprint) : null,
    history,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function historyRows(userId) {
  const db = getDb();
  const rows = db.prepare(
    "SELECT project_number, edit_plan_summary, fingerprint_snapshot, source_channel, video_duration, video_resolution, approved_at FROM delivery_history WHERE user_id = ? ORDER BY project_number ASC"
  ).all(userId);
  return rows.map(r => ({
    projectNumber: r.project_number,
    editPlanSummary: r.edit_plan_summary ? JSON.parse(r.edit_plan_summary) : {},
    fingerprintSnapshot: r.fingerprint_snapshot ? JSON.parse(r.fingerprint_snapshot) : null,
    sourceChannel: r.source_channel || null,
    videoDuration: r.video_duration || null,
    videoResolution: r.video_resolution || null,
    approvedAt: r.approved_at,
  }));
}

// ---------------------------------------------------------------------------
// CRUD — same signatures as the previous flat-file implementation
// ---------------------------------------------------------------------------

/**
 * Load a videographer's style profile.
 * Returns null if no profile exists yet.
 */
function loadProfile(userId) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(userId);
  if (!row) return null;
  return rowToProfile(row, historyRows(userId));
}

/**
 * Save a videographer's style profile (full replace).
 * Kept for backward compatibility — prefer updateFingerprint for normal flow.
 */
function saveProfile(userId, profile) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO profiles (user_id, project_count, fingerprint, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      project_count = excluded.project_count,
      fingerprint   = excluded.fingerprint,
      updated_at    = excluded.updated_at
  `).run(
    userId,
    profile.projectCount || 0,
    profile.fingerprint ? JSON.stringify(profile.fingerprint) : null,
    profile.createdAt || now,
    now
  );
}

/**
 * Get or create a profile for a videographer.
 * On first encounter, creates an empty profile.
 */
function getOrCreateProfile(userId) {
  const db = getDb();
  let row = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(userId);
  if (!row) {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO profiles (user_id, project_count, fingerprint, created_at, updated_at) VALUES (?, 0, NULL, ?, ?)"
    ).run(userId, now, now);
    row = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(userId);
  }
  return rowToProfile(row, historyRows(userId));
}

/**
 * Update the fingerprint after an approved delivery.
 *
 * @param {string} userId
 * @param {object} newFingerprint   - Qwen's merged fingerprint
 * @param {object} editPlanSummary  - Summary of the approved edit
 * @param {object} deliveryMeta     - { sourceChannel, videoDuration, videoResolution }
 * @returns {object} Updated profile
 */
function updateFingerprint(userId, newFingerprint, editPlanSummary = {}, deliveryMeta = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  const fpJson = newFingerprint ? JSON.stringify(newFingerprint) : null;

  // Ensure profile exists
  getOrCreateProfile(userId);

  // Increment project count and update fingerprint
  db.prepare(
    "UPDATE profiles SET project_count = project_count + 1, fingerprint = ?, updated_at = ? WHERE user_id = ?"
  ).run(fpJson, now, userId);

  // Read back the new count
  const row = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(userId);

  // Insert delivery history row with full fingerprint snapshot
  db.prepare(`
    INSERT INTO delivery_history
      (user_id, project_number, edit_plan_summary, fingerprint_snapshot, source_channel, video_duration, video_resolution, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    row.project_count,
    Object.keys(editPlanSummary).length ? JSON.stringify(editPlanSummary) : null,
    fpJson,
    deliveryMeta.sourceChannel || null,
    deliveryMeta.videoDuration || null,
    deliveryMeta.videoResolution || null,
    now
  );

  return rowToProfile(row, historyRows(userId));
}

/**
 * Delete a videographer's style profile (reset).
 * CASCADE removes delivery_history rows automatically.
 */
function deleteProfile(userId) {
  const db = getDb();
  db.prepare("DELETE FROM profiles WHERE user_id = ?").run(userId);
}

/**
 * Close the database connection (for clean shutdown / tests).
 */
function closeDb() {
  if (_db) { try { _db.close(); } catch {} _db = null; }
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
  closeDb,
  FINGERPRINT_THRESHOLD,
};
