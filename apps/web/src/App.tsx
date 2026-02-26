import React, { useState, useEffect, useRef } from "react";
import "./App.css";
import { saveProjectState as saveToDB, loadProjectState as loadFromDB } from "./utils/indexedDB";
import { extractFrames } from "./frameExtractor";
import { exportTrimmed, exportWithEditPlan, preloadFFmpeg } from "./export";
// preload ffmpeg in background
preloadFFmpeg().catch(console.error);

interface Clip { id: string; name: string; url: string; duration: number; }
interface EditPlan { segments: { id: string; src_in: number; src_out: number }[]; transitions?: { from: string; to: string; type: string }[]; render_constraints?: Record<string, unknown>; notes?: Record<string, unknown>; quality_guard?: { constraints_ok: boolean; checks: Record<string, boolean>; required_fixes: string[] }; }
interface ProjectState { clips: Clip[]; inOut: { in: number; out: number }; titles: string[]; exports: string[]; editPlan?: EditPlan; }
const defaultState: ProjectState = { clips: [], inOut: { in: 0, out: 0 }, titles: [], exports: [] };

export default function App() {
  const [state, setState] = useState<ProjectState>(defaultState);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [agentSummary, setAgentSummary] = useState<string | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportDone, setExportDone] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    loadFromDB().then((s) => {
      if (!s) return;
      const restored = s as ProjectState;
      // Blob URLs don't survive page reloads — drop stale clips
      restored.clips = restored.clips.filter(c => !c.url.startsWith("blob:"));
      if (restored.clips.length === 0) {
        restored.inOut = { in: 0, out: 0 };
        restored.editPlan = undefined;
      }
      setState(restored);
    }).catch(console.error);
  }, []);

  const save = (newState: ProjectState) => { setState(newState); saveToDB(newState).catch(console.error); };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    save({ ...state, clips: [...state.clips, { id: Date.now().toString(), name: file.name, url, duration: 0 }] });
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

  const activeClip = state.clips[state.clips.length - 1];
  const duration = activeClip?.duration || 0;

  const API_BASE = (import.meta as any).env?.VITE_API_URL || "http://localhost:3001";

  const handleAutoEdit = async () => {
    if (!videoRef.current || !activeClip) return;
    if (agentLoading || exporting) return;
    setAgentLoading(true);
    setAgentSummary(null);
    setExportDone(false);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const frames = await extractFrames(videoRef.current, 10);
      const width = videoRef.current.videoWidth || 0;
      const height = videoRef.current.videoHeight || 0;
      const res = await fetch(`${API_BASE}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration, frames, width, height, fps: 30 }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Server error ${res.status}: ${errText}`);
      }

      const data = await res.json();

      // Parse the new EditPlan schema (segments array + transitions)
      const editPlan: EditPlan | undefined = data?.editPlan;
      const segs = editPlan?.segments || data?.segments || [];

      let newInOut = state.inOut;
      if (segs.length > 0) {
        // Use first/last segment bounds for the UI in/out display
        newInOut = { in: segs[0].src_in, out: segs[segs.length - 1].src_out };
      }
      save({ ...state, inOut: newInOut, editPlan });

      const summary = data?.summary || `${segs.length} highlights selected`;
      setAgentSummary(summary);

      // Export: use multi-segment auto-edit if we have an editPlan
      setExporting(true);
      setExportProgress(0);
      const name = activeClip.name.replace(/\.[^/.]+$/, "");
      if (editPlan && segs.length > 1) {
        await exportWithEditPlan(activeClip.url, `${name}_highlight.mp4`, setExportProgress, API_BASE);
      } else {
        await exportTrimmed(activeClip.url, newInOut.in, newInOut.out, `${name}_highlight.mp4`, setExportProgress, API_BASE);
      }
      setExportDone(true);
      setExporting(false);

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(err);
      setAgentSummary(`Error: ${msg}`);
      setExporting(false);
    } finally {
      clearTimeout(timeout);
    }
    setAgentLoading(false);
  };

  return (
    <div className="app">

      <aside className="sidebar">
        <div className="logo"> VideoAgent</div>

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
                <span className="clip-icon"></span>
                <span className="clip-name">{c.name}</span>
                <span className="clip-dur">{fmt(c.duration)}</span>
              </div>
            ))
          }
        </div>

        <div className="spacer" />

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
          <div className="export-done-box"> Download started!</div>
        )}
      </aside>

      <main className="main">
        <div className="preview-area">
          <div className="preview-header">
            <span className="preview-title">Preview</span>
            <span className="timecode">{fmt(currentTime)}</span>
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
                <div className="empty-icon"></div>
                <div className="empty-text">Import a video to get started</div>
              </div>
            )}
            {activeClip && (
              <button className="play-overlay" onClick={togglePlay}>
                {playing ? "" : ""}
              </button>
            )}
          </div>

          <div className="scrubber-row">
            <input type="range" className="scrubber" min={0} max={duration} step={0.05} value={currentTime}
              onChange={e => { const t = parseFloat(e.target.value); if (videoRef.current) videoRef.current.currentTime = t; setCurrentTime(t); }} />
          </div>
        </div>

        <div className="timeline-area">
          <div className="timeline-header">
            <span className="tl-label">In <strong>{fmt(state.inOut.in)}</strong></span>
            <span className="tl-dur"> {fmt(state.inOut.out - state.inOut.in)} </span>
            <span className="tl-label">Out <strong>{fmt(state.inOut.out)}</strong></span>
          </div>
          <div className="timeline-track">
            <div className="tl-bg" />
            <div className="tl-range" style={{
              left: duration ? `${(state.inOut.in / duration) * 100}%` : "0%",
              width: duration ? `${((state.inOut.out - state.inOut.in) / duration) * 100}%` : "100%"
            }} />
            <div className="tl-head" style={{ left: duration ? `${(currentTime / duration) * 100}%` : "0%" }} />
          </div>
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
        </div>
      </main>

      <aside className="agent-panel">
        <div className="agent-header">
          <span className="pulse" />
          <span>AI Agent</span>
          <span className="agent-model">qwen-vision</span>
        </div>

        <div className="agent-body">
          <div className="agent-desc">
            Qwen will analyze your video frames and automatically find the best highlight moment, then download it.
          </div>

          <button
            className={`auto-edit-btn ${agentLoading || exporting ? "loading" : ""}`}
            onClick={handleAutoEdit}
            disabled={agentLoading || exporting || !activeClip}
          >
            {agentLoading ? (
              <><span className="spinner" /> Analyzing frames...</>
            ) : exporting ? (
              <><span className="spinner" /> Exporting {exportProgress}%...</>
            ) : (
              <><span></span> Auto Edit with Vision</>
            )}
          </button>

          {agentSummary && (
            <div className="agent-result">
              <div className="agent-result-label">AI Decision</div>
              <div className="agent-result-text">{agentSummary}</div>
              <div className="agent-result-range">
                {fmt(state.inOut.in)}  {fmt(state.inOut.out)}
              </div>
            </div>
          )}
        </div>
      </aside>

    </div>
  );
}



