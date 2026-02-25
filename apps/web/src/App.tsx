import React, { useState, useEffect, useRef } from "react";
import "./App.css";
import { saveProjectState as saveToDB, loadProjectState as loadFromDB } from "./utils/indexedDB";

interface Clip { id: string; name: string; url: string; duration: number; }
interface InOut { in: number; out: number; }
interface ProjectState { clips: Clip[]; inOut: InOut; titles: string[]; exports: string[]; }

const defaultState: ProjectState = { clips: [], inOut: { in: 0, out: 10 }, titles: [], exports: [] };

export default function App() {
  const [state, setState] = useState<ProjectState>(defaultState);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [agentGoal, setAgentGoal] = useState("");
  const [agentResponse, setAgentResponse] = useState<string | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

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
    const newState = { ...state, clips: [...state.clips, clip] };
    save(newState);
  };

  const handleVideoLoad = () => {
    if (!videoRef.current) return;
    const dur = videoRef.current.duration;
    const clips = state.clips.map((c, i) => i === state.clips.length - 1 ? { ...c, duration: dur } : c);
    save({ ...state, clips, inOut: { in: 0, out: dur } });
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (playing) { videoRef.current.pause(); } else { videoRef.current.play(); }
    setPlaying(!playing);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    if (videoRef.current) videoRef.current.currentTime = t;
    setCurrentTime(t);
  };

  const handleInChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    save({ ...state, inOut: { ...state.inOut, in: parseFloat(e.target.value) } });
  };

  const handleOutChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    save({ ...state, inOut: { ...state.inOut, out: parseFloat(e.target.value) } });
  };

  const formatTime = (t: number) => {
    const m = Math.floor(t / 60).toString().padStart(2, "0");
    const s = Math.floor(t % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
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
      setAgentResponse(JSON.stringify(data, null, 2));
    } catch (err) {
      setAgentResponse("Error: Could not reach agent API. Is apps/api running?");
    }
    setAgentLoading(false);
  };

  const activeClip = state.clips[state.clips.length - 1];
  const duration = activeClip?.duration || 0;

  return (
    <div className="app">
      <div className="panel assets-panel">
        <h2>Assets</h2>
        <label className="import-btn">
           Import Video
          <input type="file" accept="video/*" onChange={handleImport} style={{ display: "none" }} />
        </label>
        <div className="clip-list">
          {state.clips.map((c) => (
            <div key={c.id} className="clip-item"> {c.name}</div>
          ))}
        </div>
      </div>

      <div className="main-area">
        <div className="panel preview-panel">
          <h2>Preview <span className="timecode">{formatTime(currentTime)}</span></h2>
          {activeClip ? (
            <video
              ref={videoRef}
              src={activeClip.url}
              onLoadedMetadata={handleVideoLoad}
              onTimeUpdate={handleTimeUpdate}
              style={{ width: "100%", maxHeight: "300px", background: "#000" }}
            />
          ) : (
            <div className="empty-preview">Import a video to preview</div>
          )}
          <div className="controls">
            <button onClick={togglePlay} disabled={!activeClip}>{playing ? " Pause" : " Play"}</button>
            <input type="range" min={0} max={duration} step={0.1} value={currentTime} onChange={handleSeek} style={{ flex: 1 }} />
          </div>
        </div>

        <div className="panel timeline-panel">
          <h2>Timeline  In/Out Markers</h2>
          <div className="inout">
            <label>In: {formatTime(state.inOut.in)}
              <input type="range" min={0} max={duration} step={0.1} value={state.inOut.in} onChange={handleInChange} />
            </label>
            <label>Out: {formatTime(state.inOut.out)}
              <input type="range" min={0} max={duration} step={0.1} value={state.inOut.out} onChange={handleOutChange} />
            </label>
          </div>
          <div className="timeline-bar">
            <div className="timeline-in" style={{ left: duration ? `${(state.inOut.in / duration) * 100}%` : "0%" }} />
            <div className="timeline-out" style={{ left: duration ? `${(state.inOut.out / duration) * 100}%` : "100%" }} />
            <div className="timeline-range" style={{
              left: duration ? `${(state.inOut.in / duration) * 100}%` : "0%",
              width: duration ? `${((state.inOut.out - state.inOut.in) / duration) * 100}%` : "100%"
            }} />
          </div>
        </div>
      </div>

      <div className="panel agent-panel">
        <h2>Agent</h2>
        <textarea
          placeholder="Describe what you want... e.g. trim to first 10 seconds"
          value={agentGoal}
          onChange={(e) => setAgentGoal(e.target.value)}
          rows={4}
        />
        <button onClick={handleSuggest} disabled={agentLoading}>
          {agentLoading ? "Thinking..." : " Suggest Edit"}
        </button>
        {agentResponse && (
          <pre className="agent-response">{agentResponse}</pre>
        )}
      </div>
    </div>
  );
}
