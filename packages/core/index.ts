// ---------------------------------------------------------------------------
// Shared types — single source of truth for web, API, and bot packages
// ---------------------------------------------------------------------------

// ── Video clip ──────────────────────────────────────────────────────────────

export interface Clip {
  id: string;
  name: string;
  url?: string;      // web: object URL
  path?: string;     // api/bot: filesystem path
  duration: number;  // seconds
}

// ── Edit plan types ─────────────────────────────────────────────────────────

export interface Segment {
  id: string;
  src_in: number;   // seconds
  src_out: number;  // seconds
  needs_soft_transition?: boolean;
}

export interface Transition {
  from: string;
  to: string;
  type: string;     // "hard_cut" | "fade" | "dissolve" | "dip_to_black"
}

export interface RenderConstraints {
  keep_resolution?: boolean;
  keep_aspect_ratio?: boolean;
  no_stretch?: boolean;
  target_width?: number;
  target_height?: number;
  codec?: string;
  preset?: string;
  pixel_format?: string;
  fps?: number;
  fps_mode?: string;
}

export interface QualityGuard {
  constraints_ok: boolean;
  checks: Record<string, boolean>;
  required_fixes: string[];
}

export interface EditPlan {
  segments: Segment[];
  transitions?: Transition[];
  render_constraints?: RenderConstraints;
  notes?: Record<string, unknown>;
  quality_guard?: QualityGuard;
}

// ── In/out markers ──────────────────────────────────────────────────────────

export interface InOut {
  in: number;   // seconds
  out: number;  // seconds
}

// ── Text overlay ────────────────────────────────────────────────────────────

export interface TextOverlay {
  id: string;
  text: string;
  x: number;        // 0-100 percentage
  y: number;        // 0-100 percentage
  fontSize: number;
  color: string;     // hex color
  from?: number;     // seconds
  to?: number;       // seconds
}

// ── Export ───────────────────────────────────────────────────────────────────

export interface Export {
  id: string;
  status: "pending" | "in-progress" | "completed" | "failed";
  outputPath: string;
  duration: number;  // seconds
}

// ── Project state ───────────────────────────────────────────────────────────

export interface ProjectState {
  clips: Clip[];
  inOut: InOut;
  editPlan?: EditPlan;
  titles: Title[];
  exports: Export[];
  wasAnalyzing?: boolean;
}

export interface Title {
  id: string;
  text: string;
  position: { x: number; y: number };
  fontSize: number;
}

// ── API response types ──────────────────────────────────────────────────────

/** Unified API error response shape */
export interface ApiError {
  error: string;
  message?: string;
}

/** Video metadata returned alongside video binary responses */
export interface VideoMetadata {
  summary: string;
  segmentsCount: number;
  width: number;
  height: number;
  duration: number;
}

/** NDJSON progress event from /api/analyze */
export interface ProgressEvent {
  type: "progress";
  agent: string;
  message: string;
  ts: number;
}

/** NDJSON result event from /api/analyze */
export interface AnalyzeResult {
  type: "result";
  editPlan: EditPlan;
  segments: Segment[];
  summary: string;
}

/** NDJSON error event */
export interface ErrorEvent {
  type: "error";
  error: string;
  message: string;
}
