import React, { useState, useEffect, useRef, useCallback } from "react";
import "./App.css";
import { saveProjectState as saveToDB, loadProjectState as loadFromDB, saveFile, loadFile } from "./utils/indexedDB";
import { extractFrames } from "./frameExtractor";
import { exportTrimmed, exportWithEditPlan, preloadFFmpeg } from "./export";
preloadFFmpeg().catch(console.error);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Clip { id: string; name: string; url: string; duration: number; }
interface Segment { id: string; src_in: number; src_out: number; }
interface Transition { from: string; to: string; type: string; }
interface EditPlan {
  segments: Segment[];
  transitions?: Transition[];
  render_constraints?: Record<string, unknown>;
  notes?: Record<string, unknown>;
  quality_guard?: { constraints_ok: boolean; checks: Record<string, boolean>; required_fixes: string[] };
}
interface TextOverlay { id: string; text: string; x: number; y: number; fontSize: number; color: string; from: number; to: number; }
interface ProjectState {
  clips: Clip[];
  inOut: { in: number; out: number };
  titles: string[];
  exports: string[];
  editPlan?: EditPlan;
  overlays?: TextOverlay[];
  volume?: number;
  savedAgentSummary?: string | null;
  savedActiveTab?: Tab;
  wasAnalyzing?: boolean;
}
const defaultState: ProjectState = { clips: [], inOut: { in: 0, out: 0 }, titles: [], exports: [], overlays: [], volume: 100 };

type Tab = "ai" | "overlays" | "audio";

const AI_STEPS = ["CUT", "STRUCTURE", "CONTINUITY", "TRANSITION", "CONSTRAINTS", "QUALITY_GUARD"] as const;
type AIStep = typeof AI_STEPS[number];

export default function App() {
  const [state, setState] = useState<ProjectState>(defaultState);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [agentSummary, setAgentSummary] = useState<string | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentProgress, setAgentProgress] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportDone, setExportDone] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("ai");
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    (localStorage.getItem("theme") as "dark" | "light") || "dark"
  );
  const [toast, setToast] = useState<string | null>(null);
  const [draggingOver, setDraggingOver] = useState(false);
  const [agentStartTime, setAgentStartTime] = useState<number | null>(null);
  const [agentElapsed, setAgentElapsed] = useState(0);
  const [agentCurrentStep, setAgentCurrentStep] = useState<string | null>(null);
  const [dragClipIdx, setDragClipIdx] = useState<number | null>(null);
  const [sessionResumeNeeded, setSessionResumeNeeded] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const progressEndRef = useRef<HTMLDivElement>(null);
  const stepTimestampsRef = useRef<Record<string, number>>({});

  // Theme
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Auto-scroll progress feed
  useEffect(() => {
    progressEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [agentProgress]);

  // Elapsed time counter during AI analysis
  useEffect(() => {
    if (!agentLoading || !agentStartTime) { setAgentElapsed(0); return; }
    const iv = setInterval(() => setAgentElapsed(Math.floor((Date.now() - agentStartTime) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [agentLoading, agentStartTime]);

  // Restore session from IndexedDB
  useEffect(() => {
    loadFromDB().then(async (s) => {
      if (!s) return;
      const restored = s as ProjectState;
      if (!restored.overlays) restored.overlays = [];
      if (restored.volume == null) restored.volume = 100;

      // Restore files from IndexedDB
      const restoredClips: Clip[] = [];
      for (const clip of restored.clips) {
        const file = await loadFile(clip.id).catch(() => null);
        if (file) {
          restoredClips.push({ ...clip, url: URL.createObjectURL(file) });
        }
        // If no file in IndexedDB, skip (blob URLs don't survive refresh)
      }
      restored.clips = restoredClips;

      if (restored.clips.length === 0) {
        restored.inOut = { in: 0, out: 0 };
        restored.editPlan = undefined;
      }

      setState(restored);
      if (restored.savedAgentSummary) setAgentSummary(restored.savedAgentSummary);
      if (restored.savedActiveTab) setActiveTab(restored.savedActiveTab);

      if (restoredClips.length > 0) {
        if (restored.wasAnalyzing) {
          // Analysis was interrupted by refresh
          setSessionResumeNeeded(true);
          setActiveTab("ai");
          setToast("Session restored — AI analysis was interrupted");
        } else if (restored.editPlan && restored.editPlan.segments.length > 0) {
          setToast(`Session restored — ${restored.editPlan.segments.length} segments recovered`);
        } else {
          setToast("Session restored");
        }
      }
    }).catch(console.error);
  }, []);

  // Auto-login (auth is transparent when disabled on server)
  useEffect(() => {
    fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
      .then(r => r.json())
      .then(d => { if (d.token) setAuthToken(d.token); })
      .catch(() => {});
  }, []);

  const save = useCallback((newState: ProjectState) => {
    setState(newState);
    saveToDB(newState).catch(console.error);
  }, []);

  // Persist agentSummary and activeTab changes
  const saveAgentSummary = useCallback((summary: string | null) => {
    setAgentSummary(summary);
    setState(prev => {
      const next = { ...prev, savedAgentSummary: summary };
      saveToDB(next).catch(console.error);
      return next;
    });
  }, []);

  const switchTab = useCallback((tab: Tab) => {
    setActiveTab(tab);
    setState(prev => {
      const next = { ...prev, savedActiveTab: tab };
      saveToDB(next).catch(console.error);
      return next;
    });
  }, []);

  // Multi-file import
  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const newClips: Clip[] = files.map(file => {
      const clipId = Date.now().toString() + Math.random().toString(36).slice(2, 6);
      const url = URL.createObjectURL(file);
      saveFile(clipId, file).catch(console.error);
      return { id: clipId, name: file.name, url, duration: 0 };
    });
    save({ ...state, clips: [...state.clips, ...newClips], editPlan: undefined, overlays: [] });
    e.target.value = ""; // reset so same file can be re-imported
  };

  // Drag-and-drop import
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingOver(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingOver(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingOver(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("video/"));
    if (files.length === 0) return;
    const newClips: Clip[] = files.map(file => {
      const clipId = Date.now().toString() + Math.random().toString(36).slice(2, 6);
      const url = URL.createObjectURL(file);
      saveFile(clipId, file).catch(console.error);
      return { id: clipId, name: file.name, url, duration: 0 };
    });
    save({ ...state, clips: [...state.clips, ...newClips], editPlan: undefined, overlays: [] });
  };

  const handleVideoLoad = () => {
    const dur = videoRef.current?.duration || 0;
    const clips = state.clips.map((c, i) => i === state.clips.length - 1 ? { ...c, duration: dur } : c);
    save({ ...state, clips, inOut: { in: 0, out: dur } });
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (playing) { videoRef.current.pause(); } else { videoRef.current.play(); }
    setPlaying(!playing);
  };

  const fmt = (t: number) => {
    const m = Math.floor(t / 60).toString().padStart(2, "0");
    const s = Math.floor(t % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  const fmtDec = (t: number) => {
    const m = Math.floor(t / 60).toString().padStart(2, "0");
    const s = (t % 60).toFixed(1).padStart(4, "0");
    return `${m}:${s}`;
  };

  const activeClip = state.clips[state.clips.length - 1];
  const duration = activeClip?.duration || 0;
  const segments = state.editPlan?.segments || [];
  const transitions = state.editPlan?.transitions || [];

  const API_BASE = (import.meta as any).env?.VITE_API_URL || "http://localhost:3001";

  const authHeaders = (): Record<string, string> => {
    if (!authToken) return {};
    return { Authorization: `Bearer ${authToken}` };
  };

  const jumpToSegment = (seg: Segment) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = seg.src_in;
    setCurrentTime(seg.src_in);
  };

  const removeSegment = (segId: string) => {
    if (!state.editPlan) return;
    const newSegs = state.editPlan.segments.filter(s => s.id !== segId);
    const newTrans = (state.editPlan.transitions || []).filter(t => t.from !== segId && t.to !== segId);
    save({ ...state, editPlan: { ...state.editPlan, segments: newSegs, transitions: newTrans } });
  };

  // Text overlay management
  const addOverlay = () => {
    const overlay: TextOverlay = {
      id: Date.now().toString(),
      text: "Title",
      x: 50, y: 10,
      fontSize: 32,
      color: "#ffffff",
      from: 0,
      to: duration || 5,
    };
    save({ ...state, overlays: [...(state.overlays || []), overlay] });
  };

  const updateOverlay = (id: string, patch: Partial<TextOverlay>) => {
    const overlays = (state.overlays || []).map(o => o.id === id ? { ...o, ...patch } : o);
    save({ ...state, overlays });
  };

  const removeOverlay = (id: string) => {
    save({ ...state, overlays: (state.overlays || []).filter(o => o.id !== id) });
  };

  // AI analysis with step-based progress
  const handleAutoEdit = async () => {
    if (!videoRef.current || !activeClip) return;
    if (agentLoading || exporting) return;
    setAgentLoading(true);
    saveAgentSummary(null);
    setAgentProgress([]);
    setExportDone(false);
    setAgentStartTime(Date.now());
    setAgentCurrentStep(null);
    setSessionResumeNeeded(false);
    stepTimestampsRef.current = {};

    // Mark that analysis is in progress (for refresh recovery)
    setState(prev => {
      const next = { ...prev, wasAnalyzing: true };
      saveToDB(next).catch(console.error);
      return next;
    });

    const controller = new AbortController();
    const IDLE_MS = 60_000;
    let timeout = setTimeout(() => controller.abort(), IDLE_MS);

    try {
      const frames = await extractFrames(videoRef.current, 10);
      const width = videoRef.current.videoWidth || 0;
      const height = videoRef.current.videoHeight || 0;

      const res = await fetch(`${API_BASE}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ duration, frames, width, height, fps: 30 }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Server error ${res.status}: ${errText}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let data: Record<string, unknown> | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        clearTimeout(timeout);
        timeout = setTimeout(() => controller.abort(), IDLE_MS);
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "progress") {
              setAgentProgress(prev => [...prev, `[${event.agent}] ${event.message}`]);
              if (event.agent && event.agent !== "SYSTEM") {
                const stepKey = event.agent as string;
                if (!stepTimestampsRef.current[stepKey]) {
                  stepTimestampsRef.current[stepKey] = Date.now();
                }
                setAgentCurrentStep(stepKey);
              }
            } else if (event.type === "result") {
              data = event;
            } else if (event.type === "error") {
              throw new Error(event.message || event.error);
            }
          } catch {
            try { data = JSON.parse(line); } catch { /* non-JSON line, skip */ }
          }
        }
      }
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === "result") data = event;
          else if (!data) data = event;
        } catch { /* ignore trailing non-JSON */ }
      }

      if (!data) throw new Error("No result received from server");

      const editPlan: EditPlan | undefined = (data.editPlan as EditPlan) || undefined;
      const segs = editPlan?.segments || (data.segments as EditPlan["segments"]) || [];

      let newInOut = state.inOut;
      if (segs.length > 0) {
        newInOut = { in: segs[0].src_in, out: segs[segs.length - 1].src_out };
      }
      save({ ...state, inOut: newInOut, editPlan });

      const summary = (data.summary as string) || `${segs.length} highlights selected`;
      saveAgentSummary(summary);

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(err);
      saveAgentSummary(`Error: ${msg}`);
    } finally {
      clearTimeout(timeout);
      setAgentStartTime(null);
      setAgentCurrentStep(null);
      // Clear wasAnalyzing flag
      setState(prev => {
        const next = { ...prev, wasAnalyzing: false };
        saveToDB(next).catch(console.error);
        return next;
      });
    }
    setAgentLoading(false);
  };

  const handleExport = async () => {
    if (!activeClip || exporting || agentLoading) return;
    setExporting(true);
    setExportProgress(0);
    setExportDone(false);
    try {
      const name = activeClip.name.replace(/\.[^/.]+$/, "");
      const editPlan = state.editPlan;
      if (editPlan && editPlan.segments.length > 1) {
        await exportWithEditPlan(activeClip.url, `${name}_highlight.mp4`, setExportProgress, editPlan, API_BASE);
      } else {
        await exportTrimmed(activeClip.url, state.inOut.in, state.inOut.out, `${name}_highlight.mp4`, setExportProgress, API_BASE);
      }
      setExportDone(true);
    } catch (err) {
      console.error(err);
      saveAgentSummary(`Export error: ${err instanceof Error ? err.message : "Unknown"}`);
    }
    setExporting(false);
  };

  // Merge all clips into one
  const handleMerge = async () => {
    if (state.clips.length < 2 || exporting) return;
    setExporting(true);
    setExportProgress(0);
    setExportDone(false);
    try {
      const formData = new FormData();
      for (const clip of state.clips) {
        const resp = await fetch(clip.url);
        const blob = await resp.blob();
        formData.append("videos", blob, clip.name);
      }
      setExportProgress(30);
      const res = await fetch(`${API_BASE}/api/merge?name=merged`, {
        method: "POST",
        headers: { ...authHeaders() },
        body: formData,
      });
      setExportProgress(80);
      if (!res.ok) throw new Error(`Merge failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "merged.mp4"; document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportProgress(100);
      setExportDone(true);
      setToast("Merge complete — download started");
    } catch (err) {
      saveAgentSummary(`Merge error: ${err instanceof Error ? err.message : "Unknown"}`);
    }
    setExporting(false);
  };

  const getTransLabel = (fromId: string): string => {
    const t = transitions.find(tr => tr.from === fromId);
    if (!t || t.type === "hard_cut") return "CUT";
    return t.type.replace(/_/g, " ").toUpperCase();
  };

  const totalHighlight = segments.reduce((sum, s) => sum + (s.src_out - s.src_in), 0);

  // Time estimate for AI analysis
  const estimateRemaining = (): string | null => {
    if (!agentCurrentStep || !agentStartTime) return null;
    const stepIndex = AI_STEPS.indexOf(agentCurrentStep as AIStep);
    if (stepIndex < 0) return null;
    const progress = (stepIndex + 1) / AI_STEPS.length;
    if (progress <= 0) return null;
    const elapsedMs = Date.now() - agentStartTime;
    const totalEstMs = elapsedMs / progress;
    const remainSec = Math.max(0, Math.round((totalEstMs - elapsedMs) / 1000));
    if (remainSec < 5) return "Almost done...";
    return `~${Math.ceil(remainSec / 10) * 10}s remaining`;
  };

  // Current step index for progress display
  const currentStepIdx = agentCurrentStep ? AI_STEPS.indexOf(agentCurrentStep as AIStep) : -1;

  return (
    <div className={`app ${draggingOver ? "drag-over" : ""}`} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>

      <aside className="sidebar">
        <div className="logo">
          <span>VideoAgent</span>
          <button className="theme-toggle" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} title="Toggle theme">
            {theme === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
            )}
          </button>
        </div>

        <div className="section-label">Assets</div>
        <label className="import-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Import Video
          <input type="file" accept="video/*" multiple onChange={handleImport} style={{ display: "none" }} />
        </label>

        <div className="clip-list">
          {state.clips.length === 0
            ? <div className="empty-clips">No clips imported</div>
            : state.clips.map((c, idx) => (
              <div
                key={c.id}
                className={`clip-item ${c.id === activeClip?.id ? "active" : ""} ${dragClipIdx !== null && dragClipIdx !== idx ? "drag-over" : ""}`}
                draggable
                onDragStart={() => setDragClipIdx(idx)}
                onDragEnd={() => setDragClipIdx(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (dragClipIdx === null || dragClipIdx === idx) return;
                  const clips = [...state.clips];
                  const [moved] = clips.splice(dragClipIdx, 1);
                  clips.splice(idx, 0, moved);
                  save({ ...state, clips });
                  setDragClipIdx(null);
                }}
              >
                <span className="clip-name">{c.name}</span>
                <span className="clip-dur">{fmt(c.duration)}</span>
              </div>
            ))
          }
        </div>

        {state.clips.length >= 2 && !agentLoading && !exporting && (
          <button className="merge-btn" onClick={handleMerge}>
            Merge ({state.clips.length} clips)
          </button>
        )}

        <div className="spacer" />

        {activeClip && !exporting && !exportDone && (
          <button className="export-btn" onClick={handleExport} disabled={exporting || agentLoading}>
            Export {segments.length > 0 ? `(${segments.length} segments)` : "Trim"}
          </button>
        )}

        {exporting && (
          <div className="export-box">
            <div className="section-label">Exporting...</div>
            <div className="progress-wrap">
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${exportProgress}%` }} /></div>
              <div className="progress-label">{exportProgress}%</div>
            </div>
          </div>
        )}

        {exportDone && !exporting && (
          <div className="export-done-box">Download started!</div>
        )}
      </aside>

      <main className="main">
        <div className="preview-area">
          <div className="preview-header">
            <span className="preview-title">{activeClip?.name || "Preview"}</span>
            <span className="timecode">{fmtDec(currentTime)}</span>
          </div>

          <div className="video-wrap">
            {activeClip ? (
              <video
                ref={videoRef}
                src={activeClip.url}
                onLoadedMetadata={handleVideoLoad}
                onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime || 0)}
                onEnded={() => setPlaying(false)}
                onClick={togglePlay}
              />
            ) : (
              <div className="empty-video">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3 }}>
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <div className="empty-text">Drop a video here or click Import</div>
              </div>
            )}
            {activeClip && (
              <button className="play-overlay" onClick={togglePlay}>
                {playing ? "\u23F8" : "\u25B6"}
              </button>
            )}
          </div>

          <div className="scrubber-row">
            <input type="range" className="scrubber" min={0} max={duration} step={0.05} value={currentTime}
              onChange={e => { const t = parseFloat(e.target.value); if (videoRef.current) videoRef.current.currentTime = t; setCurrentTime(t); }} />
          </div>
        </div>

        {/* Timeline with segment visualization */}
        <div className="timeline-area">
          <div className="timeline-header">
            <span className="tl-label">In <strong>{fmtDec(state.inOut.in)}</strong></span>
            <span className="tl-dur">{fmt(state.inOut.out - state.inOut.in)}</span>
            <span className="tl-label">Out <strong>{fmtDec(state.inOut.out)}</strong></span>
          </div>
          <div className="timeline-track">
            <div className="tl-bg" />
            {segments.length > 0 ? (
              segments.map((seg) => (
                <div
                  key={seg.id}
                  className="tl-segment"
                  title={`${seg.id}: ${fmtDec(seg.src_in)} - ${fmtDec(seg.src_out)}`}
                  style={{
                    left: duration ? `${(seg.src_in / duration) * 100}%` : "0%",
                    width: duration ? `${((seg.src_out - seg.src_in) / duration) * 100}%` : "0%",
                  }}
                  onClick={() => jumpToSegment(seg)}
                />
              ))
            ) : (
              <div className="tl-range" style={{
                left: duration ? `${(state.inOut.in / duration) * 100}%` : "0%",
                width: duration ? `${((state.inOut.out - state.inOut.in) / duration) * 100}%` : "100%"
              }} />
            )}
            <div className="tl-head" style={{ left: duration ? `${(currentTime / duration) * 100}%` : "0%" }} />
          </div>

          {segments.length > 0 && (
            <div className="segment-cards">
              {segments.map((seg, i) => (
                <React.Fragment key={seg.id}>
                  <div
                    className={`seg-card ${currentTime >= seg.src_in && currentTime <= seg.src_out ? "active" : ""}`}
                    onClick={() => jumpToSegment(seg)}
                  >
                    <span className="seg-id">{seg.id}</span>
                    <span className="seg-time">{fmtDec(seg.src_in)} - {fmtDec(seg.src_out)}</span>
                    <span className="seg-dur">{(seg.src_out - seg.src_in).toFixed(1)}s</span>
                    <button className="seg-remove" onClick={(e) => { e.stopPropagation(); removeSegment(seg.id); }} title="Remove segment">&times;</button>
                  </div>
                  {i < segments.length - 1 && (
                    <span className="seg-transition">{getTransLabel(seg.id)}</span>
                  )}
                </React.Fragment>
              ))}
              <div className="seg-total">Total: {totalHighlight.toFixed(1)}s ({duration ? Math.round(totalHighlight / duration * 100) : 0}%)</div>
            </div>
          )}

          {segments.length === 0 && (
            <div className="inout-row">
              <label>
                <span>In</span>
                <input type="range" min={0} max={duration} step={0.05} value={state.inOut.in}
                  onChange={e => save({ ...state, inOut: { ...state.inOut, in: parseFloat(e.target.value) } })} />
              </label>
              <label>
                <span>Out</span>
                <input type="range" min={0} max={duration} step={0.05} value={state.inOut.out}
                  onChange={e => save({ ...state, inOut: { ...state.inOut, out: parseFloat(e.target.value) } })} />
              </label>
            </div>
          )}
        </div>
      </main>

      <aside className="agent-panel">
        <div className="panel-tabs">
          <button className={`panel-tab ${activeTab === "ai" ? "active" : ""}`} onClick={() => switchTab("ai")}>AI Agent</button>
          <button className={`panel-tab ${activeTab === "overlays" ? "active" : ""}`} onClick={() => switchTab("overlays")}>Text</button>
          <button className={`panel-tab ${activeTab === "audio" ? "active" : ""}`} onClick={() => switchTab("audio")}>Audio</button>
        </div>

        <div className="agent-body">
          {activeTab === "ai" && (
            <>
              {!sessionResumeNeeded && (
                <div className="agent-desc">
                  AI agents analyze your video and automatically select the best highlights.
                </div>
              )}

              {sessionResumeNeeded && activeClip && !agentLoading && (
                <div className="agent-result" style={{ borderColor: "var(--orange)" }}>
                  <div className="agent-result-label" style={{ color: "var(--orange)" }}>Analysis Interrupted</div>
                  <div className="agent-result-text">Your AI analysis was interrupted by a page refresh. Would you like to restart it?</div>
                </div>
              )}

              <button
                className={`auto-edit-btn ${agentLoading || exporting ? "loading" : ""}`}
                onClick={handleAutoEdit}
                disabled={agentLoading || exporting || !activeClip}
              >
                {agentLoading ? (
                  <><span className="spinner" /> Analyzing...</>
                ) : exporting ? (
                  <><span className="spinner" /> Exporting {exportProgress}%...</>
                ) : sessionResumeNeeded ? (
                  "Restart AI Analysis"
                ) : (
                  "Auto Edit with AI"
                )}
              </button>

              {/* Step-based pipeline progress */}
              {agentLoading && (
                <div className="agent-steps">
                  {AI_STEPS.map((step, stepIdx) => {
                    const status = stepIdx < currentStepIdx ? "done" : stepIdx === currentStepIdx ? "active" : "pending";
                    const stepTs = stepTimestampsRef.current[step];
                    const nextStepTs = stepIdx < AI_STEPS.length - 1 ? stepTimestampsRef.current[AI_STEPS[stepIdx + 1]] : undefined;
                    return (
                      <div key={step} className={`agent-step ${status}`}>
                        <span className="step-indicator">
                          {status === "done" ? (
                            <span className="step-check">{"\u2713"}</span>
                          ) : status === "active" ? (
                            <span className="spinner" />
                          ) : (
                            <span className="step-pending-dot" />
                          )}
                        </span>
                        <span className="step-label">{step.replace(/_/g, " ")}</span>
                        {status === "done" && stepTs && nextStepTs && (
                          <span className="step-time">{Math.round((nextStepTs - stepTs) / 1000)}s</span>
                        )}
                        {status === "active" && stepTs && (
                          <span className="step-time">{Math.round((Date.now() - stepTs) / 1000)}s</span>
                        )}
                      </div>
                    );
                  })}
                  <div className="agent-progress-bar">
                    <div className="progress-bar">
                      <div className="progress-fill" style={{ width: `${currentStepIdx >= 0 ? Math.round(((currentStepIdx + 1) / AI_STEPS.length) * 100) : 0}%` }} />
                    </div>
                    <span className="progress-label">{currentStepIdx >= 0 ? Math.round(((currentStepIdx + 1) / AI_STEPS.length) * 100) : 0}%</span>
                  </div>
                  <div className="agent-time-row">
                    <span className="agent-elapsed">{fmt(agentElapsed)}</span>
                    <span className="agent-estimate">{estimateRemaining() || ""}</span>
                  </div>
                  <div ref={progressEndRef} />
                </div>
              )}

              {agentSummary && (
                <div className={`agent-result ${agentSummary.startsWith("Error") ? "error" : ""}`}>
                  <div className="agent-result-label">{agentSummary.startsWith("Error") ? "Error" : "AI Decision"}</div>
                  <div className="agent-result-text">{agentSummary}</div>
                </div>
              )}
            </>
          )}

          {activeTab === "overlays" && (
            <>
              <div className="agent-desc">
                Add text overlays to your video. They will be burned into the export.
              </div>

              <button className="auto-edit-btn" onClick={addOverlay} disabled={!activeClip}>
                + Add Text Overlay
              </button>

              <div className="overlay-list">
                {(state.overlays || []).map(o => (
                  <div key={o.id} className="overlay-card">
                    <div className="overlay-row">
                      <input
                        className="overlay-text-input"
                        value={o.text}
                        onChange={e => updateOverlay(o.id, { text: e.target.value })}
                        placeholder="Enter text..."
                      />
                      <button className="seg-remove" onClick={() => removeOverlay(o.id)}>&times;</button>
                    </div>
                    <div className="overlay-row">
                      <label className="overlay-label">
                        Size
                        <input type="range" min={12} max={72} value={o.fontSize}
                          onChange={e => updateOverlay(o.id, { fontSize: parseInt(e.target.value) })} />
                        <span className="overlay-val">{o.fontSize}</span>
                      </label>
                    </div>
                    <div className="overlay-row">
                      <label className="overlay-label">
                        Color
                        <input type="color" value={o.color} onChange={e => updateOverlay(o.id, { color: e.target.value })} />
                      </label>
                      <label className="overlay-label">
                        X
                        <input type="range" min={0} max={100} value={o.x}
                          onChange={e => updateOverlay(o.id, { x: parseInt(e.target.value) })} />
                      </label>
                      <label className="overlay-label">
                        Y
                        <input type="range" min={0} max={100} value={o.y}
                          onChange={e => updateOverlay(o.id, { y: parseInt(e.target.value) })} />
                      </label>
                    </div>
                    <div className="overlay-row">
                      <label className="overlay-label">
                        From
                        <input type="number" min={0} max={duration} step={0.1} value={o.from}
                          onChange={e => updateOverlay(o.id, { from: parseFloat(e.target.value) || 0 })} />
                      </label>
                      <label className="overlay-label">
                        To
                        <input type="number" min={0} max={duration} step={0.1} value={o.to}
                          onChange={e => updateOverlay(o.id, { to: parseFloat(e.target.value) || duration })} />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {activeTab === "audio" && (
            <>
              <div className="agent-desc">
                Adjust the audio volume for your video export.
              </div>

              <div className="volume-control">
                <div className="volume-header">
                  <span className="volume-label">Volume</span>
                  <span className="volume-value">{state.volume ?? 100}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={state.volume ?? 100}
                  onChange={e => save({ ...state, volume: parseInt(e.target.value) })}
                />
                <div className="volume-presets">
                  <button onClick={() => save({ ...state, volume: 0 })}>Mute</button>
                  <button onClick={() => save({ ...state, volume: 50 })}>50%</button>
                  <button onClick={() => save({ ...state, volume: 100 })}>100%</button>
                  <button onClick={() => save({ ...state, volume: 150 })}>150%</button>
                </div>
              </div>
            </>
          )}
        </div>
      </aside>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
