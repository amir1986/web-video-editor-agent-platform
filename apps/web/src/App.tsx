import React, { useState, useEffect, useRef } from "react";
import "./App.css";
import { saveProjectState as saveToDB, loadProjectState as loadFromDB } from "./utils/indexedDB";

interface Clip { id: string; name: string; url: string; duration: number; }
interface ProjectState { clips: Clip[]; inOut: { in: number; out: number }; titles: string[]; exports: string[]; }

const defaultState: ProjectState = { clips: [], inOut: { in: 0, out: 0 }, titles: [], exports: [] };

export default function App() {
  const [state, setState] = useState<ProjectState>(defaultState);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [agentGoal, setAgentGoal] = useState("");
  const [agentResponse, setAgentResponse] = useState<string | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    loadFromDB().then((s) => { if (s) setState(s as ProjectState); }).catch(console.error);
  }, []);

  const save = (newState: ProjectState) => {
    setState(newState);
    saveToDB(newState).catch(console.error);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const clip: Clip = { id: Date.now().toString(), name: file.name, url, duration: 0 };
    save({ ...state, clips: [...state.clips, clip] });
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

  const fmt = (t: number) => `${Math.floor(t/60).toString().padStart(2,"0")}:${Math.floor(t%60).toString().padStart(2,"0")}`;

  const activeClip = state.clips[state.clips.length - 1];
  const duration = activeClip?.duration || 0;

  const handleExport = async () => {
    if (!videoRef.current || !activeClip) return;
    setExporting(true);
    setExportProgress(0);

    try {
      const video = videoRef.current;
      video.currentTime = state.inOut.in;
      video.pause();
      setPlaying(false);

      const stream = (video as any).captureStream(30);
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const originalName = activeClip.name.replace(/\.[^/.]+$/, "");
        a.download = `${originalName}_edited.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setExporting(false);
        setExportProgress(100);
        setTimeout(() => setExportProgress(0), 2000);
      };

      recorder.start(100);
      await video.play();

      const trimDuration = state.inOut.out - state.inOut.in;
      const startTime = Date.now();

      const interval = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        const progress = Math.min((elapsed / trimDuration) * 100, 99);
        setExportProgress(progress);

        if (video.currentTime >= state.inOut.out || elapsed >= trimDuration) {
          clearInterval(interval);
          video.pause();
          recorder.stop();
          stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        }
      }, 200);

    } catch (err) {
      console.error(err);
      setExporting(false);
    }
  };

  const cancelExport = () => {
    mediaRecorderRef.current?.stop();
    videoRef.current?.pause();
    setExporting(false);
    setExportProgress(0);
  };

  const handleSuggest = async () => {
    if (!agentGoal.trim()) return;
    setAgentLoading(true);
    setAgentResponse(null);
    try {
      const res = await fetch("http://localhost:3001/api/ai/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: agentGoal, currentState: state }),
      });
      const data = await res.json();
      if (data?.editPlan?.timelineOps) {
        for (const op of data.editPlan.timelineOps) {
          if (op.op === "setInOut") {
            save({ ...state, inOut: { in: op.in, out: op.out } });
          }
        }
      }
      setAgentResponse(JSON.stringify(data, null, 2));
    } catch {
      setAgentResponse(" Could not reach agent API.\nMake sure apps/api is running on port 3001.");
    }
    setAgentLoading(false);
  };

  return (
    <div className="app">
      {/* ASSETS */}
      <div className="panel">
        <div className="panel-header">Assets</div>
        <label className="import-btn">
          <span>＋</span> Import Video
          <input type="file" accept="video/*" onChange={handleImport} style={{ display: "none" }} />
        </label>
        <div className="clip-list">
          {state.clips.length === 0 && <div style={{ color: "#333", fontSize: 12 }}>No clips yet</div>}
          {state.clips.map((c) => (
            <div key={c.id} className="clip-item"> {c.name}</div>
          ))}
        </div>

        {activeClip && (
          <div className="export-section">
            <div className="panel-header" style={{marginTop: 8}}>Export</div>
            {exporting ? (
              <>
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${exportProgress}%` }} />
                </div>
                <div className="progress-label">{Math.round(exportProgress)}% exporting...</div>
                <button className="cancel-btn" onClick={cancelExport}> Cancel</button>
              </>
            ) : (
              <button className="export-btn" onClick={handleExport}>
                 Export & Download
              </button>
            )}
            {exportProgress === 100 && (
              <div className="export-done"> Download started!</div>
            )}
          </div>
        )}
      </div>

      {/* MAIN */}
      <div className="main-area">
        <div className="preview-panel">
          <div className="preview-top">
            <div className="panel-header" style={{ borderBottom: "none", paddingBottom: 0 }}>Preview</div>
            <div className="timecode">{fmt(currentTime)}</div>
          </div>
          <div className="video-container">
            {activeClip ? (
              <video
                ref={videoRef}
                src={activeClip.url}
                onLoadedMetadata={handleVideoLoad}
                onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime || 0)}
                onEnded={() => setPlaying(false)}
              />
            ) : (
              <div className="empty-preview">
                <span></span>
                Import a video to get started
              </div>
            )}
          </div>
          <div className="controls">
            <button className="play-btn" onClick={togglePlay} disabled={!activeClip}>
              {playing ? "" : ""}
            </button>
            <input type="range" min={0} max={duration} step={0.05} value={currentTime}
              onChange={e => { const t = parseFloat(e.target.value); if (videoRef.current) videoRef.current.currentTime = t; setCurrentTime(t); }} />
          </div>
        </div>

        <div className="timeline-panel">
          <div className="timeline-labels">
            <span>In: <strong style={{color:"#7c3aed"}}>{fmt(state.inOut.in)}</strong></span>
            <span>Duration: <strong style={{color:"#aaa"}}>{fmt(state.inOut.out - state.inOut.in)}</strong></span>
            <span>Out: <strong style={{color:"#7c3aed"}}>{fmt(state.inOut.out)}</strong></span>
          </div>
          <div className="timeline-track">
            <div className="timeline-range" style={{
              left: duration ? `${(state.inOut.in/duration)*100}%` : "0%",
              width: duration ? `${((state.inOut.out-state.inOut.in)/duration)*100}%` : "100%"
            }} />
            <div className="timeline-playhead" style={{ left: duration ? `${(currentTime/duration)*100}%` : "0%" }} />
          </div>
          <div className="inout-controls">
            <label>In <span>{fmt(state.inOut.in)}</span>
              <input type="range" min={0} max={duration} step={0.05} value={state.inOut.in}
                onChange={e => save({ ...state, inOut: { ...state.inOut, in: parseFloat(e.target.value) } })} />
            </label>
            <label>Out <span>{fmt(state.inOut.out)}</span>
              <input type="range" min={0} max={duration} step={0.05} value={state.inOut.out}
                onChange={e => save({ ...state, inOut: { ...state.inOut, out: parseFloat(e.target.value) } })} />
            </label>
          </div>
        </div>
      </div>

      {/* AGENT */}
      <div className="panel agent-panel">
        <div className="panel-header"><span className="status-dot" />Agent</div>
        <textarea
          placeholder={"Describe your edit...\ne.g. trim to first 30 seconds"}
          value={agentGoal}
          onChange={e => setAgentGoal(e.target.value)}
          rows={5}
        />
        <button className="suggest-btn" onClick={handleSuggest} disabled={agentLoading}>
          {agentLoading ? " Thinking..." : " Suggest Edit"}
        </button>
        {agentResponse && <pre className="agent-response">{agentResponse}</pre>}
      </div>
    </div>
  );
}
