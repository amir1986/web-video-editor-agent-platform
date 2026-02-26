import React, { useState, useEffect, useRef, useCallback } from "react";
import "./App.css";
import { saveProjectState as saveToDB, loadProjectState as loadFromDB } from "./utils/indexedDB";
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
}
const defaultState: ProjectState = { clips: [], inOut: { in: 0, out: 0 }, titles: [], exports: [], overlays: [], volume: 100 };

type Tab = "ai" | "overlays" | "audio";

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll progress feed
  useEffect(() => {
    progressEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [agentProgress]);

  useEffect(() => {
    loadFromDB().then((s) => {
      if (!s) return;
      const restored = s as ProjectState;
      restored.clips = restored.clips.filter(c => !c.url.startsWith("blob:"));
      if (restored.clips.length === 0) {
        restored.inOut = { in: 0, out: 0 };
        restored.editPlan = undefined;
      }
      if (!restored.overlays) restored.overlays = [];
      if (restored.volume == null) restored.volume = 100;
      setState(restored);
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

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    save({ ...state, clips: [...state.clips, { id: Date.now().toString(), name: file.name, url, duration: 0 }], editPlan: undefined, overlays: [] });
  };

  const handleVideoLoad = () => {
    const dur = videoRef.current?.duration || 0;
    const clips = state.clips.map((c, i) => i === state.clips.length - 1 ? { ...c, duration: dur } : c);
    save({ ...state, clips, inOut: { in: 0, out: dur } });
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    playing ? videoRef.current.pause() : videoRef.current.play();
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

  // Jump to segment start on click
  const jumpToSegment = (seg: Segment) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = seg.src_in;
    setCurrentTime(seg.src_in);
  };

  // Remove a segment from the edit plan
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

  const handleAutoEdit = async () => {
    if (!videoRef.current || !activeClip) return;
    if (agentLoading || exporting) return;
    setAgentLoading(true);
    setAgentSummary(null);
    setAgentProgress([]);
    setExportDone(false);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

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
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "progress") {
              setAgentProgress(prev => [...prev, `[${event.agent}] ${event.message}`]);
            } else if (event.type === "result") {
              data = event;
            } else if (event.type === "error") {
              throw new Error(event.message || event.error);
            }
          } catch (parseErr) {
            try { data = JSON.parse(line); } catch {}
          }
        }
      }
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === "result") data = event;
          else if (!data) data = event;
        } catch {}
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
      setAgentSummary(summary);

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(err);
      setAgentSummary(`Error: ${msg}`);
    } finally {
      clearTimeout(timeout);
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
      setAgentSummary(`Export error: ${err instanceof Error ? err.message : "Unknown"}`);
    }
    setExporting(false);
  };

  // Get transition type label
  const getTransLabel = (fromId: string): string => {
    const t = transitions.find(tr => tr.from === fromId);
    if (!t || t.type === "hard_cut") return "CUT";
    return t.type.replace(/_/g, " ").toUpperCase();
  };

  const totalHighlight = segments.reduce((sum, s) => sum + (s.src_out - s.src_in), 0);

  return (
    <div className="app">

      <aside className="sidebar">
        <div className="logo">VideoAgent</div>

        <div className="section-label">Assets</div>
        <label className="import-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Import Video
          <input type="file" accept="video/*" onChange={handleImport} style={{ display: "none" }} />
        </label>

        <div className="clip-list">
          {state.clips.length === 0
            ? <div className="empty-clips">No clips yet</div>
            : state.clips.map((c) => (
              <div key={c.id} className={`clip-item ${c.id === activeClip?.id ? "active" : ""}`}>
                <span className="clip-name">{c.name}</span>
                <span className="clip-dur">{fmt(c.duration)}</span>
              </div>
            ))
          }
        </div>

        <div className="spacer" />

        {/* Export section */}
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
            <span className="preview-title">Preview</span>
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
                <div className="empty-text">Import a video to get started</div>
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
            {/* Show individual segments if editPlan exists */}
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

          {/* Segment cards */}
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

          {/* In/Out controls (when no segments) */}
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
        {/* Tab navigation */}
        <div className="panel-tabs">
          <button className={`panel-tab ${activeTab === "ai" ? "active" : ""}`} onClick={() => setActiveTab("ai")}>AI Agent</button>
          <button className={`panel-tab ${activeTab === "overlays" ? "active" : ""}`} onClick={() => setActiveTab("overlays")}>Text</button>
          <button className={`panel-tab ${activeTab === "audio" ? "active" : ""}`} onClick={() => setActiveTab("audio")}>Audio</button>
        </div>

        <div className="agent-body">
          {/* AI Tab */}
          {activeTab === "ai" && (
            <>
              <div className="agent-desc">
                AI agents analyze your video and automatically select the best highlights.
              </div>

              <button
                className={`auto-edit-btn ${agentLoading || exporting ? "loading" : ""}`}
                onClick={handleAutoEdit}
                disabled={agentLoading || exporting || !activeClip}
              >
                {agentLoading ? (
                  <><span className="spinner" /> Analyzing...</>
                ) : exporting ? (
                  <><span className="spinner" /> Exporting {exportProgress}%...</>
                ) : (
                  "Auto Edit with AI"
                )}
              </button>

              {agentProgress.length > 0 && agentLoading && (
                <div className="agent-progress">
                  {agentProgress.map((msg, i) => (
                    <div key={i} className="agent-progress-item">
                      <span className="progress-dot" />
                      <span>{msg}</span>
                    </div>
                  ))}
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

          {/* Text Overlay Tab */}
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

          {/* Audio Tab */}
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

    </div>
  );
}
