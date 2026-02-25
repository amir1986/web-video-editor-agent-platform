import React, { useState, useEffect, useRef } from "react";
import "./App.css";
import { saveProjectState as saveToDB, loadProjectState as loadFromDB } from "./utils/indexedDB";
import { extractFrames } from "./frameExtractor";
import { exportTrimmed } from "./export";

interface Clip { id: string; name: string; url: string; duration: number; }
interface ProjectState { clips: Clip[]; inOut: { in: number; out: number }; titles: string[]; exports: string[]; }
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
    loadFromDB().then((s) => { if (s) setState(s as ProjectState); }).catch(console.error);
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

  const handleAutoEdit = async () => {
    if (!videoRef.current || !activeClip) return;
    setAgentLoading(true);
    setAgentSummary(null);
    setExportDone(false);
    try {
      const frames = await extractFrames(videoRef.current, 10);
      const res = await fetch("http://localhost:3001/api/ai/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration, frames }),
      });
      const data = await res.json();

      let newInOut = state.inOut;
      if (data?.editPlan?.timelineOps) {
        for (const op of data.editPlan.timelineOps) {
          if (op.op === "setInOut") {
            newInOut = { in: op.in, out: op.out };
            save({ ...state, inOut: newInOut });
          }
        }
      }

      setAgentSummary(data?.editPlan?.summary || "Done");

      // הורד אוטומטית
      setExporting(true);
      setExportProgress(0);
      const name = activeClip.name.replace(/\.[^/.]+$/, "");
      await exportTrimmed(activeClip.url, newInOut.in, newInOut.out, `${name}_highlight.mp4`, setExportProgress);
      setExportDone(true);
      setExporting(false);

    } catch (err) {
      console.error(err);
      setAgentSummary("Error - check console");
      setExporting(false);
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
