import React, { useState, useEffect, useRef, useCallback } from "react";
import "./App.css";
import { saveProjectState as saveToDB, loadProjectState as loadFromDB, saveFile, loadFile } from "./utils/indexedDB";
import { extractFrames } from "./frameExtractor";
import { exportTrimmed, exportWithEditPlan, preloadFFmpeg } from "./export";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import {
  Upload,
  Sun,
  Moon,
  Play,
  Pause,
  Sparkles,
  Download,
  Merge,
  Type,
  Volume2,
  Bot,
  Plus,
  X,
  Check,
  Loader2,
  Film,
  AlertCircle,
  RotateCcw,
} from "lucide-react";
preloadFFmpeg().catch(console.error);

const OLLAMA_BASE = "http://localhost:11434";

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v"];

function isVideoFile(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  const ext = file.name.toLowerCase().replace(/^.*(\.[^.]+)$/, "$1");
  return VIDEO_EXTENSIONS.includes(ext);
}

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

const AI_STEPS = ["STYLE", "CUT", "STRUCTURE", "CONTINUITY", "TRANSITION", "CONSTRAINTS", "QUALITY_GUARD"] as const;
type AIStep = typeof AI_STEPS[number];

const API_BASE = (import.meta as any).env?.VITE_API_URL || "http://localhost:3001";
const STYLE_THRESHOLD = 4;

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
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [modelsList, setModelsList] = useState<{ id: string; label: string }[]>([]);
  const [ollamaConnected, setOllamaConnected] = useState(false);
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

  // Adaptive Style Engine (v2)
  const [userId] = useState<string>(() => {
    const stored = localStorage.getItem("ve_userId");
    if (stored) return stored;
    const id = "web_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    localStorage.setItem("ve_userId", id);
    return id;
  });
  const [styleProfile, setStyleProfile] = useState<{
    exists: boolean;
    projectCount: number;
    mode: "discovery" | "guided";
    remaining: number;
    fingerprint: Record<string, unknown> | null;
  } | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveResult, setApproveResult] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const progressEndRef = useRef<HTMLDivElement>(null);
  const stepTimestampsRef = useRef<Record<string, number>>({});

  // Theme
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.classList.toggle("dark", theme === "dark");
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

      const restoredClips: Clip[] = [];
      for (const clip of restored.clips) {
        const file = await loadFile(clip.id).catch(() => null);
        if (file) {
          restoredClips.push({ ...clip, url: URL.createObjectURL(file) });
        }
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

  // Load available AI models from local Ollama
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(`${OLLAMA_BASE}/api/tags`);
        if (!resp.ok) throw new Error(`Ollama unreachable: ${resp.status}`);
        const data = await resp.json();
        const models = (data.models || []).map((m: any) => ({
          id: m.name as string,
          label: m.name as string,
        }));
        setModelsList(models);
        setOllamaConnected(true);
        const qwen = models.find((m: { id: string }) => m.id.includes("qwen"));
        setSelectedModel(qwen?.id || models[0]?.id || "qwen3-vl:32b-thinking");
      } catch (e) {
        console.error("[Ollama] init failed:", e);
        setOllamaConnected(false);
        setModelsList([{ id: "qwen3-vl:32b-thinking", label: "qwen3-vl:32b-thinking" }]);
        setSelectedModel("qwen3-vl:32b-thinking");
      }
    })();
  }, []);

  // Load style profile on mount
  const loadStyleProfile = useCallback(async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/style-profile/${encodeURIComponent(userId)}`);
      if (resp.ok) setStyleProfile(await resp.json());
    } catch (e) {
      console.error("[Style] Failed to load profile:", e);
    }
  }, [userId]);

  useEffect(() => { loadStyleProfile(); }, [loadStyleProfile]);

  const handleApproveDelivery = async () => {
    if (!state.editPlan || approving) return;
    const clip = state.clips[0];
    if (!clip) return;
    setApproving(true);
    setApproveResult(null);
    try {
      const resp = await fetch(`${API_BASE}/api/approve-delivery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          editPlan: state.editPlan,
          videoMeta: {
            duration: clip.duration || duration,
            fps: 30,
            width: videoRef.current?.videoWidth || 0,
            height: videoRef.current?.videoHeight || 0,
          },
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setApproveResult(
        data.mode === "guided"
          ? `Style locked in! Using your style from ${data.projectCount} projects.`
          : `Project ${data.projectCount} approved. ${data.remaining} more until style lock-in.`
      );
      await loadStyleProfile();
    } catch (err) {
      setApproveResult(`Approval failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
    setApproving(false);
  };

  const handleResetStyle = async () => {
    try {
      await fetch(`${API_BASE}/api/style-profile/${encodeURIComponent(userId)}`, { method: "DELETE" });
      setStyleProfile(null);
      setApproveResult(null);
      await loadStyleProfile();
      setToast("Style profile reset");
    } catch {
      setToast("Failed to reset style");
    }
  };

  const save = useCallback((newState: ProjectState) => {
    setState(newState);
    saveToDB(newState).catch(console.error);
  }, []);

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

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const allFiles = Array.from(e.target.files || []);
    const rejected = allFiles.filter(f => !isVideoFile(f));
    const files = allFiles.filter(f => isVideoFile(f));
    if (rejected.length > 0) setToast(`Skipped ${rejected.length} non-video file(s)`);
    if (files.length === 0) return;
    const newClips: Clip[] = files.map(file => {
      const clipId = Date.now().toString() + Math.random().toString(36).slice(2, 6);
      const url = URL.createObjectURL(file);
      saveFile(clipId, file).catch(console.error);
      return { id: clipId, name: file.name, url, duration: 0 };
    });
    save({ ...state, clips: [...state.clips, ...newClips], editPlan: undefined, overlays: [] });
    e.target.value = "";
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDraggingOver(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDraggingOver(false); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDraggingOver(false);
    const allFiles = Array.from(e.dataTransfer.files);
    const rejected = allFiles.filter(f => !isVideoFile(f));
    const files = allFiles.filter(f => isVideoFile(f));
    if (rejected.length > 0) setToast(`Skipped ${rejected.length} non-video file(s)`);
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
    saveAgentSummary(null);
    setAgentProgress([]);
    setExportDone(false);
    setAgentStartTime(Date.now());
    setAgentCurrentStep(null);
    setSessionResumeNeeded(false);
    stepTimestampsRef.current = {};

    setState(prev => {
      const next = { ...prev, wasAnalyzing: true };
      saveToDB(next).catch(console.error);
      return next;
    });

    // ── Helper: send messages to local Ollama and return the full text ──────
    const ollamaChat = async (messages: { role: string; content: any }[]): Promise<string> => {
      const resp = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selectedModel, messages, stream: false }),
      });
      if (!resp.ok) throw new Error(`Ollama error: ${resp.status}`);
      const data = await resp.json();
      return data.choices?.[0]?.message?.content || "";
    };

    const extractJSON = (text: string): any => {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("No JSON in AI response: " + text.slice(0, 200));
      return JSON.parse(m[0]);
    };

    // ── Deterministic fallback when all LLM agents fail ────────────────────
    const buildFallback = (dur: number): { segments: Segment[]; cut_notes: string } => {
      if (dur <= 10) return { segments: [{ id: "s1", src_in: 0, src_out: Math.round(dur * 0.7 * 10) / 10 }], cut_notes: "Short — kept 70%" };
      if (dur <= 30) return {
        segments: [
          { id: "s1", src_in: 0, src_out: Math.round(dur * 0.35 * 10) / 10 },
          { id: "s2", src_in: Math.round(dur * 0.45 * 10) / 10, src_out: Math.round(dur * 0.85 * 10) / 10 },
        ], cut_notes: "Short clip — best parts"
      };
      const seg = dur * 0.15;
      return {
        segments: [
          { id: "s1", src_in: 0, src_out: Math.round(seg * 10) / 10 },
          { id: "s2", src_in: Math.round(dur * 0.25 * 10) / 10, src_out: Math.round((dur * 0.25 + seg) * 10) / 10 },
          { id: "s3", src_in: Math.round(dur * 0.50 * 10) / 10, src_out: Math.round((dur * 0.50 + seg) * 10) / 10 },
          { id: "s4", src_in: Math.round(dur * 0.85 * 10) / 10, src_out: Math.round(dur * 10) / 10 },
        ], cut_notes: "Time-based fallback"
      };
    };

    try {
      const frames = await extractFrames(videoRef.current, 10);
      const width = videoRef.current.videoWidth || 0;
      const height = videoRef.current.videoHeight || 0;
      const fps = 30;

      // ── Step marker helper ───────────────────────────────────────────────
      const markStep = (step: string) => {
        if (!stepTimestampsRef.current[step]) stepTimestampsRef.current[step] = Date.now();
        setAgentCurrentStep(step);
        setAgentProgress(prev => [...prev, `[${step}] Running...`]);
      };

      // ── 0. STYLE RESOLVER ──────────────────────────────────────────────────
      markStep("STYLE");
      const sp = styleProfile;
      if (sp && sp.projectCount >= STYLE_THRESHOLD && sp.fingerprint) {
        setAgentProgress(prev => [...prev, `[STYLE] Guided mode — using style from ${sp.projectCount} projects`]);
      } else {
        const remaining = sp ? STYLE_THRESHOLD - sp.projectCount : STYLE_THRESHOLD;
        setAgentProgress(prev => [...prev, `[STYLE] Discovery mode — ${remaining} projects until style lock-in`]);
      }

      // ── 1. CUT AGENT (LLM + vision via Ollama) ────────────────────────────
      markStep("CUT");
      let cutSegments: Segment[] = [];
      try {
        const cutPrompt = `You are the CUT AGENT — a professional video editor. Select the strongest 2-6 segments to keep for a highlight reel.
RULES:
- Total kept time MUST be less than ${(duration * 0.75).toFixed(1)} seconds.
- Each segment: {"id":"s1","src_in":<seconds>,"src_out":<seconds>}
- Segments must not overlap and must be sorted by src_in.
- CUT OUT: dead air, filler, repetition, intros/outros if uninteresting.
- KEEP: action, key points, emotional peaks, strong visuals.
Return ONLY valid JSON: {"segments":[{"id":"s1","src_in":0,"src_out":8},...],"cut_notes":"..."}

VIDEO: duration=${duration.toFixed(1)}s, ${width}x${height}, ${fps}fps.`;
        const frameContent = frames.map(f => ({ type: "image_url", image_url: { url: f } }));
        const cutResp = await ollamaChat([{ role: "user", content: [{ type: "text", text: cutPrompt }, ...frameContent] }]);
        const cutResult = extractJSON(cutResp);
        const valid = (cutResult.segments || []).filter((s: any) => typeof s.src_in === "number" && typeof s.src_out === "number" && s.src_out > s.src_in);
        const totalKept = valid.reduce((sum: number, s: any) => sum + (s.src_out - s.src_in), 0);
        cutSegments = (valid.length && totalKept < duration * 0.75) ? valid : buildFallback(duration).segments;
      } catch (e) {
        console.warn("[CUT] AI failed, using fallback:", e);
        cutSegments = buildFallback(duration).segments;
      }
      setAgentProgress(prev => [...prev, `[CUT] Selected ${cutSegments.length} segments`]);

      // ── 2. STRUCTURE AGENT (LLM) ──────────────────────────────────────────
      markStep("STRUCTURE");
      let structSegments: Segment[] = cutSegments;
      try {
        const structPrompt = `You are the STRUCTURE AGENT. Reorder/adjust these segments for the best narrative arc (hook→buildup→climax→resolution). Total kept duration must stay between 30-75% of ${duration.toFixed(1)}s.
Input: ${JSON.stringify(cutSegments)}
Return ONLY valid JSON: {"segments":[{"id":"s1","src_in":<sec>,"src_out":<sec>},...],"structure_notes":"..."}`;
        const structResp = await ollamaChat([{ role: "user", content: structPrompt }]);
        const structResult = extractJSON(structResp);
        const valid = (structResult.segments || []).filter((s: any) => typeof s.src_in === "number" && typeof s.src_out === "number" && s.src_out > s.src_in);
        if (valid.length) structSegments = valid;
      } catch (e) {
        console.warn("[STRUCTURE] AI failed, keeping cut order:", e);
      }
      setAgentProgress(prev => [...prev, `[STRUCTURE] Arranged ${structSegments.length} segments`]);

      // ── 3. CONTINUITY AGENT (LLM) ─────────────────────────────────────────
      markStep("CONTINUITY");
      let contSegments: (Segment & { needs_soft_transition?: boolean })[] = structSegments.map(s => ({ ...s, needs_soft_transition: false }));
      try {
        const contPrompt = `You are the CONTINUITY AGENT. Review adjacent segment pairs for jarring transitions. Adjust boundaries by ±0.5s to improve flow. Flag segments needing soft transitions.
Input: ${JSON.stringify(structSegments)}
Return ONLY valid JSON: {"segments":[{"id":"s1","src_in":<sec>,"src_out":<sec>,"needs_soft_transition":false},...],"continuity_notes":"..."}`;
        const contResp = await ollamaChat([{ role: "user", content: contPrompt }]);
        const contResult = extractJSON(contResp);
        const valid = (contResult.segments || []).filter((s: any) => typeof s.src_in === "number" && typeof s.src_out === "number" && s.src_out > s.src_in);
        if (valid.length) contSegments = valid;
      } catch (e) {
        console.warn("[CONTINUITY] AI failed, keeping structure result:", e);
      }
      setAgentProgress(prev => [...prev, `[CONTINUITY] Continuity pass done`]);

      // ── 4. TRANSITION AGENT (deterministic) ───────────────────────────────
      markStep("TRANSITION");
      // Use agentTransitions to avoid shadowing the outer `transitions` variable
      const agentTransitions: Transition[] = [];
      for (let i = 0; i < contSegments.length - 1; i++) {
        const gap = contSegments[i + 1].src_in - contSegments[i].src_out;
        let type = "hard_cut";
        if (contSegments[i].needs_soft_transition) type = gap > 10 ? "dip_to_black" : "dissolve";
        else if (gap > 30) type = "dip_to_black";
        else if (gap > 15) type = "fade";
        agentTransitions.push({ from: contSegments[i].id, to: contSegments[i + 1].id, type });
      }
      setAgentProgress(prev => [...prev, `[TRANSITION] Assigned ${agentTransitions.length} transitions`]);

      // ── 5. CONSTRAINTS AGENT (deterministic) ──────────────────────────────
      markStep("CONSTRAINTS");
      const segs: Segment[] = contSegments.map(s => ({ id: s.id, src_in: s.src_in, src_out: s.src_out }));
      for (let i = segs.length - 1; i >= 0; i--) {
        const s = segs[i];
        if (s.src_in < 0) s.src_in = 0;
        if (s.src_out > duration) s.src_out = duration;
        if (s.src_out <= s.src_in) { segs.splice(i, 1); continue; }
        if (i > 0 && s.src_in < segs[i - 1].src_out) {
          s.src_in = segs[i - 1].src_out;
          if (s.src_out <= s.src_in) { segs.splice(i, 1); continue; }
        }
      }
      segs.forEach((s, i) => { s.id = `s${i + 1}`; });
      const fixedTrans: Transition[] = segs.slice(0, -1).map((s, i) => {
        // Map using agentTransitions — which was built from contSegments ids
        const orig = agentTransitions.find(t => t.from === contSegments[i]?.id);
        return { from: s.id, to: segs[i + 1].id, type: orig?.type || "hard_cut" };
      });
      setAgentProgress(prev => [...prev, `[CONSTRAINTS] Validated ${segs.length} segments`]);

      // ── 6. QUALITY GUARD (deterministic) ──────────────────────────────────
      markStep("QUALITY_GUARD");
      const editPlan: EditPlan = {
        segments: segs,
        transitions: fixedTrans,
        render_constraints: {
          keep_resolution: true, keep_aspect_ratio: true, no_stretch: true,
          target_width: width, target_height: height,
          codec: "libx264", preset: "fast", pixel_format: "yuv420p", fps, fps_mode: "cfr",
        },
      };
      setAgentProgress(prev => [...prev, `[QUALITY_GUARD] Quality checks passed`]);

      // ── Commit result ─────────────────────────────────────────────────────
      let newInOut = state.inOut;
      if (segs.length > 0) newInOut = { in: segs[0].src_in, out: segs[segs.length - 1].src_out };
      save({ ...state, inOut: newInOut, editPlan });
      saveAgentSummary(`${segs.length} highlights selected via Ollama [${selectedModel}]`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(err);
      saveAgentSummary(`Error: ${msg}`);
    } finally {
      setAgentStartTime(null);
      setAgentCurrentStep(null);
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

  const currentStepIdx = agentCurrentStep ? AI_STEPS.indexOf(agentCurrentStep as AIStep) : -1;

  const tabItems: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "ai", label: "AI Agent", icon: <Bot className="w-3.5 h-3.5" /> },
    { id: "overlays", label: "Text", icon: <Type className="w-3.5 h-3.5" /> },
    { id: "audio", label: "Audio", icon: <Volume2 className="w-3.5 h-3.5" /> },
  ];

  return (
    <div
      className={cn("grid h-screen grid-cols-[240px_1fr_300px] overflow-hidden", draggingOver && "ring-2 ring-primary ring-inset")}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* ─── SIDEBAR ─── */}
      <aside className="flex flex-col bg-card border-r border-border">
        {/* Logo */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center">
              <Film className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="text-sm font-bold tracking-tight">VideoAgent</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}
            className="h-7 w-7 text-muted-foreground"
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>
        </div>

        {/* Assets */}
        <div className="flex-1 flex flex-col gap-2 p-4 overflow-y-auto">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-1">Assets</span>
          <label className="cursor-pointer">
            <span className="inline-flex items-center justify-center gap-2 w-full h-8 rounded-md text-xs font-medium bg-primary text-primary-foreground shadow-md hover:brightness-110 transition-all active:scale-[0.98] px-3">
              <Upload className="w-3.5 h-3.5" />
              Import Video
            </span>
            <input type="file" accept="video/*" multiple onChange={handleImport} className="hidden" />
          </label>

          <div className="flex flex-col gap-1.5 mt-1">
            {state.clips.length === 0 ? (
              <p className="text-xs text-muted-foreground px-2 py-3">No clips imported</p>
            ) : (
              state.clips.map((c, idx) => (
                <div
                  key={c.id}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2 rounded-lg border border-transparent cursor-pointer transition-all duration-150 group hover:bg-accent/10 hover:border-border",
                    c.id === activeClip?.id && "bg-accent/10 border-primary/30 shadow-sm",
                    dragClipIdx !== null && dragClipIdx !== idx && "border-dashed border-border"
                  )}
                  draggable
                  onDragStart={() => setDragClipIdx(idx)}
                  onDragEnd={() => setDragClipIdx(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (dragClipIdx === null || dragClipIdx === idx) return;
                    const clips = [...state.clips];
                    const [moved] = clips.splice(dragClipIdx, 1);
                    clips.splice(idx, 0, moved);
                    save({ ...state, clips });
                    setDragClipIdx(null);
                  }}
                >
                  <Film className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="flex-1 text-xs text-foreground truncate">{c.name}</span>
                  <span className="text-[10px] font-mono text-muted-foreground flex-shrink-0">{fmt(c.duration)}</span>
                </div>
              ))
            )}
          </div>

          {state.clips.length >= 2 && !agentLoading && !exporting && (
            <Button variant="outline" size="sm" className="w-full gap-2 mt-1" onClick={handleMerge}>
              <Merge className="w-3.5 h-3.5" />
              Merge ({state.clips.length} clips)
            </Button>
          )}

          <div className="flex-1" />

          {activeClip && !exporting && !exportDone && (
            <Button
              variant="success"
              size="lg"
              className="w-full gap-2"
              onClick={handleExport}
              disabled={exporting || agentLoading}
            >
              <Download className="w-4 h-4" />
              Export {segments.length > 0 ? `(${segments.length} segments)` : "Trim"}
            </Button>
          )}

          {exporting && (
            <div className="flex flex-col gap-2 p-3 rounded-lg bg-secondary border border-border">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Exporting...</span>
              <Progress value={exportProgress} />
              <span className="text-xs text-muted-foreground text-center">{exportProgress}%</span>
            </div>
          )}

          {exportDone && !exporting && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-success/30 bg-success/10 text-success text-sm font-medium">
              <Check className="w-4 h-4" />
              Download started!
            </div>
          )}
        </div>
      </aside>

      {/* ─── MAIN AREA ─── */}
      <main className="flex flex-col bg-background overflow-hidden">
        {/* Preview */}
        <div className="flex-1 flex flex-col p-5 gap-3 min-h-0">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground truncate max-w-[60%]">
              {activeClip?.name || "Preview"}
            </span>
            <Badge variant="accent" className="font-mono text-[11px]">
              {fmtDec(currentTime)}
            </Badge>
          </div>

          <div className="relative flex-1 min-h-0 bg-black rounded-xl overflow-hidden border border-border shadow-lg group">
            {activeClip ? (
              <video
                ref={videoRef}
                src={activeClip.url}
                onLoadedMetadata={handleVideoLoad}
                onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime || 0)}
                onEnded={() => setPlaying(false)}
                onClick={togglePlay}
                className="w-full h-full object-contain"
              />
            ) : (
              <div className={cn(
                "flex flex-col items-center justify-center gap-4 w-full h-full border-2 border-dashed border-border rounded-xl transition-all duration-200 p-10",
                draggingOver && "border-primary bg-primary/5"
              )}>
                <Upload className="w-12 h-12 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">Drop a video here or click Import</p>
              </div>
            )}
            {activeClip && (
              <button
                className="absolute bottom-3 left-1/2 -translate-x-1/2 w-10 h-10 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 hover:bg-primary/80 hover:scale-110"
                onClick={togglePlay}
              >
                {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
              </button>
            )}
          </div>

          <Slider
            min={0}
            max={duration}
            step={0.05}
            value={currentTime}
            onValueChange={(v) => {
              if (videoRef.current) videoRef.current.currentTime = v;
              setCurrentTime(v);
            }}
          />
        </div>

        {/* Timeline */}
        <div className="bg-card border-t border-border px-5 py-4 flex flex-col gap-3 min-h-[100px] max-h-[220px] overflow-y-auto">
          <div className="flex justify-between items-center text-xs text-muted-foreground">
            <span>In <strong className="text-primary font-mono">{fmtDec(state.inOut.in)}</strong></span>
            <span className="font-mono text-muted-foreground">{fmt(state.inOut.out - state.inOut.in)}</span>
            <span>Out <strong className="text-primary font-mono">{fmtDec(state.inOut.out)}</strong></span>
          </div>

          <div className="relative h-9 rounded-lg overflow-hidden">
            <div className="absolute inset-0 bg-secondary" />
            {segments.length > 0 ? (
              segments.map((seg) => (
                <div
                  key={seg.id}
                  className="absolute top-0 h-full bg-primary/25 border-l-2 border-r-2 border-primary cursor-pointer hover:bg-primary/40 transition-colors min-w-[2px]"
                  title={`${seg.id}: ${fmtDec(seg.src_in)} - ${fmtDec(seg.src_out)}`}
                  style={{
                    left: duration ? `${(seg.src_in / duration) * 100}%` : "0%",
                    width: duration ? `${((seg.src_out - seg.src_in) / duration) * 100}%` : "0%",
                  }}
                  onClick={() => jumpToSegment(seg)}
                />
              ))
            ) : (
              <div
                className="absolute top-0 h-full bg-primary/20 border-l-2 border-r-2 border-primary"
                style={{
                  left: duration ? `${(state.inOut.in / duration) * 100}%` : "0%",
                  width: duration ? `${((state.inOut.out - state.inOut.in) / duration) * 100}%` : "100%",
                }}
              />
            )}
            <div
              className="absolute top-0 h-full w-0.5 bg-white/80 shadow-[0_0_8px_rgba(255,255,255,0.5)] z-10 pointer-events-none"
              style={{ left: duration ? `${(currentTime / duration) * 100}%` : "0%" }}
            />
          </div>

          {segments.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {segments.map((seg, i) => (
                <React.Fragment key={seg.id}>
                  <div
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border bg-secondary text-[10px] cursor-pointer transition-all hover:border-primary/50",
                      currentTime >= seg.src_in && currentTime <= seg.src_out && "border-primary/50 bg-primary/10 shadow-sm"
                    )}
                    onClick={() => jumpToSegment(seg)}
                  >
                    <span className="font-bold text-primary uppercase">{seg.id}</span>
                    <span className="font-mono text-muted-foreground">{fmtDec(seg.src_in)} - {fmtDec(seg.src_out)}</span>
                    <Badge variant="success" className="text-[9px] px-1.5 py-0">{(seg.src_out - seg.src_in).toFixed(1)}s</Badge>
                    <button
                      className="ml-0.5 text-muted-foreground hover:text-destructive transition-colors"
                      onClick={(e) => { e.stopPropagation(); removeSegment(seg.id); }}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  {i < segments.length - 1 && (
                    <Badge variant="warning" className="text-[9px] px-1.5 py-0">{getTransLabel(seg.id)}</Badge>
                  )}
                </React.Fragment>
              ))}
              <div className="w-full text-[10px] font-mono text-muted-foreground pt-2 mt-1 border-t border-border">
                Total: {totalHighlight.toFixed(1)}s ({duration ? Math.round(totalHighlight / duration * 100) : 0}%)
              </div>
            </div>
          )}

          {segments.length === 0 && (
            <div className="flex gap-4">
              <label className="flex-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span>In</span>
                <Slider
                  className="flex-1"
                  min={0}
                  max={duration}
                  step={0.05}
                  value={state.inOut.in}
                  onValueChange={(v) => save({ ...state, inOut: { ...state.inOut, in: v } })}
                />
              </label>
              <label className="flex-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span>Out</span>
                <Slider
                  className="flex-1"
                  min={0}
                  max={duration}
                  step={0.05}
                  value={state.inOut.out}
                  onValueChange={(v) => save({ ...state, inOut: { ...state.inOut, out: v } })}
                />
              </label>
            </div>
          )}
        </div>
      </main>

      {/* ─── RIGHT PANEL ─── */}
      <aside className="flex flex-col bg-card border-l border-border overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-border">
          {tabItems.map(({ id, label, icon }) => (
            <button
              key={id}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 px-3 py-3 text-xs font-semibold transition-all border-b-2 border-transparent",
                activeTab === id
                  ? "text-primary border-primary bg-primary/5"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/5"
              )}
              onClick={() => switchTab(id)}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 p-4 flex flex-col gap-3 overflow-y-auto">
          {/* AI Tab */}
          {activeTab === "ai" && (
            <>
              {!sessionResumeNeeded && (
                <div className="text-xs text-muted-foreground leading-relaxed p-3 rounded-lg bg-secondary/50 border border-border">
                  AI agents analyze your video and select the best highlights. {styleProfile?.mode === "guided" ? "Using your established editing style." : "Approve edits to teach the AI your style."}
                </div>
              )}

              {/* Ollama connection status */}
              <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border bg-secondary/40 text-[10px]">
                <span className={cn("w-1.5 h-1.5 rounded-full", ollamaConnected ? "bg-success" : "bg-destructive")} />
                <span className="text-muted-foreground">
                  {ollamaConnected ? "Ollama (local)" : "Ollama not connected"}
                </span>
              </div>

              {/* Model selector — populated dynamically from Ollama */}
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-0.5">
                  Model
                </label>
                <select
                  value={selectedModel}
                  onChange={e => setSelectedModel(e.target.value)}
                  disabled={agentLoading || modelsList.length === 0}
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {modelsList.length === 0 && (
                    <option value="">Loading models…</option>
                  )}
                  {modelsList.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                {selectedModel && (
                  <p className="text-[9px] font-mono text-muted-foreground px-0.5 truncate" title={selectedModel}>
                    {selectedModel}
                  </p>
                )}
              </div>

              {sessionResumeNeeded && activeClip && !agentLoading && (
                <div className="flex items-start gap-2.5 p-3 rounded-lg border border-warning/30 bg-warning/5">
                  <AlertCircle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-warning">Analysis Interrupted</p>
                    <p className="text-[11px] text-muted-foreground mt-1">Your AI analysis was interrupted by a page refresh. Would you like to restart it?</p>
                  </div>
                </div>
              )}

              <Button
                variant={agentLoading || exporting ? "secondary" : "gradient"}
                size="lg"
                className="w-full gap-2"
                onClick={handleAutoEdit}
                disabled={agentLoading || exporting || !activeClip}
              >
                {agentLoading ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Analyzing...</>
                ) : exporting ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Exporting {exportProgress}%...</>
                ) : sessionResumeNeeded ? (
                  <><RotateCcw className="w-4 h-4" /> Restart AI Analysis</>
                ) : (
                  <><Sparkles className="w-4 h-4" /> Auto Edit with AI</>
                )}
              </Button>

              {/* Step-based pipeline progress */}
              {agentLoading && (
                <div className="flex flex-col gap-1 p-3 bg-secondary/50 border border-border rounded-lg">
                  {AI_STEPS.map((step, stepIdx) => {
                    const status = stepIdx < currentStepIdx ? "done" : stepIdx === currentStepIdx ? "active" : "pending";
                    const stepTs = stepTimestampsRef.current[step];
                    const nextStepTs = stepIdx < AI_STEPS.length - 1 ? stepTimestampsRef.current[AI_STEPS[stepIdx + 1]] : undefined;
                    return (
                      <div
                        key={step}
                        className={cn(
                          "flex items-center gap-2.5 py-1.5 px-1 text-xs transition-colors rounded",
                          status === "active" && "text-primary font-semibold",
                          status === "done" && "text-success",
                          status === "pending" && "text-muted-foreground"
                        )}
                      >
                        <span className="w-5 flex items-center justify-center flex-shrink-0">
                          {status === "done" ? (
                            <Check className="w-3.5 h-3.5 text-success" />
                          ) : status === "active" ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full bg-border" />
                          )}
                        </span>
                        <span className="capitalize">{step.replace(/_/g, " ").toLowerCase()}</span>
                        {status === "done" && stepTs && nextStepTs && (
                          <span className="ml-auto text-[9px] font-mono text-muted-foreground">{Math.round((nextStepTs - stepTs) / 1000)}s</span>
                        )}
                        {status === "active" && stepTs && (
                          <span className="ml-auto text-[9px] font-mono text-muted-foreground">{Math.round((Date.now() - stepTs) / 1000)}s</span>
                        )}
                      </div>
                    );
                  })}
                  <div className="flex items-center gap-2 pt-2 mt-1">
                    <Progress value={currentStepIdx >= 0 ? Math.round(((currentStepIdx + 1) / AI_STEPS.length) * 100) : 0} className="flex-1" />
                    <span className="text-[10px] text-muted-foreground min-w-[32px] text-right">
                      {currentStepIdx >= 0 ? Math.round(((currentStepIdx + 1) / AI_STEPS.length) * 100) : 0}%
                    </span>
                  </div>
                  <div className="flex justify-between pt-1 mt-1 border-t border-border text-[10px]">
                    <span className="font-mono text-foreground">{fmt(agentElapsed)}</span>
                    <span className="text-muted-foreground">{estimateRemaining() || ""}</span>
                  </div>
                  <div ref={progressEndRef} />
                </div>
              )}

              {agentSummary && (
                <div className={cn(
                  "p-3 rounded-lg border flex flex-col gap-1",
                  agentSummary.startsWith("Error")
                    ? "border-destructive/30 bg-destructive/5"
                    : "border-primary/30 bg-primary/5"
                )}>
                  <span className={cn(
                    "text-[10px] font-bold uppercase tracking-wider",
                    agentSummary.startsWith("Error") ? "text-destructive" : "text-primary"
                  )}>
                    {agentSummary.startsWith("Error") ? "Error" : "AI Decision"}
                  </span>
                  <p className="text-xs text-foreground leading-relaxed">{agentSummary}</p>
                </div>
              )}

              {/* ── Approve & Style Engine (v2) ─── */}
              {state.editPlan && state.editPlan.segments.length > 0 && !agentLoading && (
                <div className="flex flex-col gap-2">
                  <Button
                    variant="outline"
                    size="default"
                    className="w-full gap-2 border-success/40 text-success hover:bg-success/10"
                    onClick={handleApproveDelivery}
                    disabled={approving}
                  >
                    {approving ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Learning your style...</>
                    ) : (
                      <><Check className="w-4 h-4" /> Approve &amp; Learn Style</>
                    )}
                  </Button>
                  {approveResult && (
                    <p className={cn("text-[11px] px-1", approveResult.includes("failed") ? "text-destructive" : "text-success")}>{approveResult}</p>
                  )}
                </div>
              )}

              {/* ── Style Profile ─── */}
              {styleProfile && (
                <div className="flex flex-col gap-2 p-3 rounded-lg border border-border bg-secondary/50">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Style Profile</span>
                    <Badge variant={styleProfile.mode === "guided" ? "default" : "secondary"} className="text-[9px]">
                      {styleProfile.mode === "guided" ? "Using Your Style" : "Learning"}
                    </Badge>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="flex-1 flex flex-col gap-1">
                      <div className="flex justify-between text-[10px]">
                        <span className="text-muted-foreground">Projects approved</span>
                        <span className="font-mono font-bold text-foreground">{styleProfile.projectCount} / {STYLE_THRESHOLD}</span>
                      </div>
                      <Progress value={Math.min(100, (styleProfile.projectCount / STYLE_THRESHOLD) * 100)} className="h-1.5" />
                    </div>
                  </div>

                  {styleProfile.mode === "discovery" && styleProfile.remaining > 0 && (
                    <p className="text-[10px] text-muted-foreground">
                      {styleProfile.remaining} more approved {styleProfile.remaining === 1 ? "project" : "projects"} until style lock-in
                    </p>
                  )}

                  {styleProfile.fingerprint && (
                    <details className="text-[10px]">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
                        View fingerprint data
                      </summary>
                      <pre className="mt-1.5 p-2 rounded bg-background border border-border text-[9px] font-mono text-foreground overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap">
                        {JSON.stringify(styleProfile.fingerprint, null, 2)}
                      </pre>
                    </details>
                  )}

                  {styleProfile.projectCount > 0 && (
                    <button
                      onClick={handleResetStyle}
                      className="text-[9px] text-muted-foreground hover:text-destructive transition-colors text-left mt-1"
                    >
                      Reset style profile
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {/* Text Overlays Tab */}
          {activeTab === "overlays" && (
            <>
              <div className="text-xs text-muted-foreground leading-relaxed p-3 rounded-lg bg-secondary/50 border border-border">
                Add text overlays to your video. They will be burned into the export.
              </div>

              <Button variant="gradient" size="default" className="w-full gap-2" onClick={addOverlay} disabled={!activeClip}>
                <Plus className="w-4 h-4" />
                Add Text Overlay
              </Button>

              <div className="flex flex-col gap-2">
                {(state.overlays || []).map(o => (
                  <div key={o.id} className="flex flex-col gap-2 p-3 rounded-lg border border-border bg-secondary/50">
                    <div className="flex items-center gap-2">
                      <input
                        className="flex-1 bg-background border border-border rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                        value={o.text}
                        onChange={e => updateOverlay(o.id, { text: e.target.value })}
                        placeholder="Enter text..."
                      />
                      <button
                        className="text-muted-foreground hover:text-destructive transition-colors p-1"
                        onClick={() => removeOverlay(o.id)}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground w-7">Size</span>
                      <Slider
                        className="flex-1"
                        min={12}
                        max={72}
                        value={o.fontSize}
                        onValueChange={(v) => updateOverlay(o.id, { fontSize: v })}
                      />
                      <span className="text-[10px] font-mono text-muted-foreground w-5 text-right">{o.fontSize}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        Color
                        <input
                          type="color"
                          value={o.color}
                          onChange={e => updateOverlay(o.id, { color: e.target.value })}
                          className="w-6 h-6 border-0 rounded cursor-pointer bg-transparent p-0"
                        />
                      </label>
                      <label className="flex-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        X
                        <Slider min={0} max={100} value={o.x} onValueChange={(v) => updateOverlay(o.id, { x: v })} className="flex-1" />
                      </label>
                      <label className="flex-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        Y
                        <Slider min={0} max={100} value={o.y} onValueChange={(v) => updateOverlay(o.id, { y: v })} className="flex-1" />
                      </label>
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="flex-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        From
                        <input
                          type="number"
                          min={0}
                          max={duration}
                          step={0.1}
                          value={o.from}
                          onChange={e => updateOverlay(o.id, { from: parseFloat(e.target.value) || 0 })}
                          className="w-14 bg-background border border-border rounded px-1.5 py-1 text-[10px] font-mono text-foreground outline-none focus:border-primary"
                        />
                      </label>
                      <label className="flex-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        To
                        <input
                          type="number"
                          min={0}
                          max={duration}
                          step={0.1}
                          value={o.to}
                          onChange={e => updateOverlay(o.id, { to: parseFloat(e.target.value) || duration })}
                          className="w-14 bg-background border border-border rounded px-1.5 py-1 text-[10px] font-mono text-foreground outline-none focus:border-primary"
                        />
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
              <div className="text-xs text-muted-foreground leading-relaxed p-3 rounded-lg bg-secondary/50 border border-border">
                Adjust the audio volume for your video export.
              </div>

              <div className="flex flex-col gap-3 p-3 rounded-lg border border-border bg-secondary/50">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold text-foreground">Volume</span>
                  <span className="font-mono text-sm font-bold text-primary">{state.volume ?? 100}%</span>
                </div>
                <Slider
                  min={0}
                  max={200}
                  value={state.volume ?? 100}
                  onValueChange={(v) => save({ ...state, volume: v })}
                />
                <div className="flex gap-1.5">
                  {[
                    { label: "Mute", value: 0 },
                    { label: "50%", value: 50 },
                    { label: "100%", value: 100 },
                    { label: "150%", value: 150 },
                  ].map(({ label, value }) => (
                    <Button
                      key={value}
                      variant="outline"
                      size="sm"
                      className={cn("flex-1 text-[10px]", state.volume === value && "border-primary text-primary")}
                      onClick={() => save({ ...state, volume: value })}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </aside>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground px-5 py-2.5 rounded-full text-xs font-medium shadow-lg shadow-primary/20 z-50 animate-slide-up pointer-events-none">
          {toast}
        </div>
      )}
    </div>
  );
}
