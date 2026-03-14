// ---------------------------------------------------------------------------
// Shared types — single source of truth for the entire monorepo.
// Used by: apps/web (TypeScript), apps/api (JSDoc references)
// ---------------------------------------------------------------------------

// ── Video Clips ─────────────────────────────────────────────────────────────

export interface Clip {
  id: string;
  name: string;
  duration: number; // in seconds
  /** File URL (web: blob URL) or file path (server: filesystem path) */
  url: string;
}

// ── In/Out Markers ──────────────────────────────────────────────────────────

export interface InOut {
  in: number;   // seconds
  out: number;  // seconds
}

// ── Edit Plan Types ─────────────────────────────────────────────────────────

export interface Segment {
  id: string;
  src_in: number;
  src_out: number;
}

export interface Transition {
  from: string;
  to: string;
  type: string;
}

export interface EditPlan {
  segments: Segment[];
  transitions?: Transition[];
  render_constraints?: Record<string, unknown>;
  notes?: Record<string, unknown>;
  quality_guard?: {
    constraints_ok: boolean;
    checks: Record<string, boolean>;
    required_fixes: string[];
  };
}

// ── Text Overlays ───────────────────────────────────────────────────────────

export interface TextOverlay {
  id: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  from: number;
  to: number;
}

// ── Exports ─────────────────────────────────────────────────────────────────

export interface Export {
  id: string;
  status: "pending" | "in-progress" | "completed" | "failed";
  outputPath: string;
  duration: number; // in seconds
}

// ── Project State ───────────────────────────────────────────────────────────

export type Tab = "ai" | "overlays" | "audio";

export interface ProjectState {
  clips: Clip[];
  inOut: InOut;
  titles: string[];
  exports: string[];
  editPlan?: EditPlan;
  overlays?: TextOverlay[];
  volume?: number;
  savedAgentSummary?: string | null;
  savedActiveTab?: Tab;
  wasAnalyzing?: boolean;
}

// ── Video Metadata ──────────────────────────────────────────────────────────

export interface VideoMeta {
  duration: number;
  fps: number;
  width: number;
  height: number;
}

// ── Auto-edit response metadata ─────────────────────────────────────────────

export interface AutoEditMetadata {
  summary: string;
  segments: number;
  width: number;
  height: number;
  duration: number;
  styleMode: string;
  projectCount: number;
}

// ── Progress event (standardized across NDJSON, SSE, WebSocket) ─────────────

export interface ProgressEvent {
  type: "progress" | "result" | "error" | "style" | "complete";
  agent?: string;
  message?: string;
  timestamp: number;
}
