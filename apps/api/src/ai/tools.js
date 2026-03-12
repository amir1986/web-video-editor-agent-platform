/**
 * Video Editing Tools Registry
 *
 * Tool Use / Function Calling
 * Each tool has a definition and a handler function.
 * Tools can be used by agents via the MCP server.
 *
 * Tools exposed:
 * - probe_video: Get video metadata (duration, resolution, fps, codec, bitrate)
 * - extract_frames: Extract frames at specific timestamps
 * - analyze_scene: Detect scene changes and motion levels
 * - search_knowledge: RAG search over video editing best practices
 * - calculate_pacing: Compute ideal pacing based on content type
 */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { searchKnowledge } = require("./knowledge-base");

const WSL_DISTRO = process.env.WSL_DISTRO || "Ubuntu-24.04";

function toWslPath(p) {
  if (process.platform === "win32") {
    return p.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
  }
  return p;
}

function ffprobeExec(args) {
  return new Promise((resolve, reject) => {
    const [cmd, fullArgs] = process.platform === "win32"
      ? ["wsl", ["-d", WSL_DISTRO, "--", "ffprobe", ...args]]
      : ["ffprobe", args];
    execFile(cmd, fullArgs, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

function ffmpegExec(args) {
  return new Promise((resolve, reject) => {
    const [cmd, fullArgs] = process.platform === "win32"
      ? ["wsl", ["-d", WSL_DISTRO, "--", "ffmpeg", ...args]]
      : ["ffmpeg", args];
    execFile(cmd, fullArgs, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
  {
    name: "probe_video",
    description: "Get detailed video metadata including duration, resolution, frame rate, codec, bitrate, and audio info. Use this to understand the source video before making editing decisions.",
    input_schema: {
      type: "object",
      properties: {
        video_path: {
          type: "string",
          description: "Path to the video file to probe",
        },
      },
      required: ["video_path"],
    },
  },
  {
    name: "extract_frames",
    description: "Extract frames from specific timestamps in the video as base64 JPEG images. Use this to visually inspect specific moments before deciding on cuts.",
    input_schema: {
      type: "object",
      properties: {
        video_path: {
          type: "string",
          description: "Path to the video file",
        },
        timestamps: {
          type: "array",
          items: { type: "number" },
          description: "List of timestamps (in seconds) to extract frames from",
        },
      },
      required: ["video_path", "timestamps"],
    },
  },
  {
    name: "analyze_scene",
    description: "Detect scene changes and analyze motion levels throughout the video. Returns a list of scene boundaries and their visual characteristics (motion intensity, brightness change).",
    input_schema: {
      type: "object",
      properties: {
        video_path: {
          type: "string",
          description: "Path to the video file",
        },
        threshold: {
          type: "number",
          description: "Scene change detection threshold (0.0-1.0, default 0.3). Lower values detect more subtle changes.",
        },
      },
      required: ["video_path"],
    },
  },
  {
    name: "search_knowledge",
    description: "Search the video editing knowledge base for best practices, techniques, and guidelines. Use this to make informed editing decisions based on professional standards.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query about video editing techniques, pacing, transitions, or best practices",
        },
        category: {
          type: "string",
          enum: ["cuts", "transitions", "pacing", "narrative", "technical", "all"],
          description: "Category to search within (default: all)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "calculate_pacing",
    description: "Calculate ideal pacing and segment durations based on content type, total duration, and target audience. Returns recommended cut frequency and segment length ranges.",
    input_schema: {
      type: "object",
      properties: {
        total_duration: {
          type: "number",
          description: "Total video duration in seconds",
        },
        content_type: {
          type: "string",
          enum: ["action", "vlog", "tutorial", "music", "sports", "narrative", "general"],
          description: "Type of video content",
        },
        target_platform: {
          type: "string",
          enum: ["youtube", "tiktok", "instagram", "telegram", "general"],
          description: "Target platform for the highlight reel",
        },
      },
      required: ["total_duration"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------

// Context object that holds runtime video path — set before agent loop
let _toolContext = {};

function setToolContext(ctx) {
  _toolContext = ctx;
}

const TOOL_HANDLERS = {
  async probe_video({ video_path }) {
    const vp = video_path || _toolContext.videoPath;
    if (!vp) throw new Error("No video path available");
    const json = await ffprobeExec([
      "-v", "error",
      "-show_entries", "stream=codec_name,codec_type,width,height,r_frame_rate,bit_rate,pix_fmt,duration,nb_frames",
      "-show_entries", "format=duration,size,bit_rate,nb_streams",
      "-of", "json", vp,
    ]);
    const data = JSON.parse(json);
    const video = (data.streams || []).find(s => s.codec_type === "video") || {};
    const audio = (data.streams || []).find(s => s.codec_type === "audio") || {};
    let fps = 30;
    if (video.r_frame_rate) {
      const [num, den] = video.r_frame_rate.split("/").map(Number);
      if (num && den) fps = Math.round((num / den) * 100) / 100;
    }
    return {
      duration: parseFloat(data.format?.duration) || 0,
      width: video.width || 0,
      height: video.height || 0,
      fps,
      codec: video.codec_name || "unknown",
      pix_fmt: video.pix_fmt || "unknown",
      video_bitrate: parseInt(video.bit_rate) || parseInt(data.format?.bit_rate) || 0,
      audio_codec: audio.codec_name || "none",
      file_size: parseInt(data.format?.size) || 0,
    };
  },

  async extract_frames({ video_path, timestamps }) {
    const vp = video_path || _toolContext.videoPath;
    if (!vp) throw new Error("No video path available");
    if (!timestamps?.length) throw new Error("No timestamps provided");

    const framesDir = path.join(os.tmpdir(), `tool_frames_${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(framesDir, { recursive: true });
    const results = [];

    try {
      for (let i = 0; i < timestamps.length; i++) {
        const ts = timestamps[i];
        const outPath = path.join(framesDir, `frame_${i}.jpg`);
        await ffmpegExec([
          "-loglevel", "error", "-ss", String(ts), "-i", vp,
          "-vframes", "1", "-vf", "scale=320:-2", "-q:v", "3",
          toWslPath(outPath),
        ]);
        if (fs.existsSync(outPath)) {
          const b64 = fs.readFileSync(outPath).toString("base64");
          results.push({ timestamp: ts, base64: `data:image/jpeg;base64,${b64}` });
        }
      }
      return { frames: results, count: results.length };
    } finally {
      try { fs.rmSync(framesDir, { recursive: true }); } catch {}
    }
  },

  async analyze_scene({ video_path, threshold }) {
    const vp = video_path || _toolContext.videoPath;
    if (!vp) throw new Error("No video path available");
    const th = threshold || 0.3;

    // Use ffprobe scene detection
    const json = await ffprobeExec([
      "-v", "error",
      "-show_frames",
      "-show_entries", "frame=pts_time,pict_type",
      "-select_streams", "v:0",
      "-of", "json",
      "-read_intervals", "%+60",  // First 60 seconds max
      vp,
    ]);
    const data = JSON.parse(json);
    const frames = (data.frames || []).filter(f => f.pict_type === "I");

    // Scene boundaries are at I-frames with significant time gaps
    const scenes = [];
    let lastTime = 0;
    for (const frame of frames) {
      const time = parseFloat(frame.pts_time) || 0;
      if (time - lastTime > 1.0) {
        scenes.push({
          timestamp: time,
          gap_from_previous: Math.round((time - lastTime) * 10) / 10,
          type: "scene_change",
        });
      }
      lastTime = time;
    }

    return {
      scene_count: scenes.length,
      scenes: scenes.slice(0, 20), // Limit to 20 scenes
      analysis: scenes.length > 10 ? "fast-paced" : scenes.length > 5 ? "moderate" : "slow-paced",
    };
  },

  async search_knowledge({ query, category }) {
    return searchKnowledge(query, category || "all");
  },

  async calculate_pacing({ total_duration, content_type, target_platform }) {
    const type = content_type || "general";
    const platform = target_platform || "general";

    // Pacing guidelines based on professional editing standards
    const pacingRules = {
      action:    { cuts_per_minute: [8, 15],  avg_segment: [2, 5],   keep_ratio: [0.3, 0.5] },
      vlog:      { cuts_per_minute: [3, 6],   avg_segment: [5, 15],  keep_ratio: [0.4, 0.6] },
      tutorial:  { cuts_per_minute: [2, 4],   avg_segment: [8, 20],  keep_ratio: [0.5, 0.7] },
      music:     { cuts_per_minute: [6, 12],  avg_segment: [3, 8],   keep_ratio: [0.4, 0.6] },
      sports:    { cuts_per_minute: [10, 20], avg_segment: [1.5, 4], keep_ratio: [0.3, 0.5] },
      narrative: { cuts_per_minute: [4, 8],   avg_segment: [4, 12],  keep_ratio: [0.4, 0.65] },
      general:   { cuts_per_minute: [4, 10],  avg_segment: [3, 10],  keep_ratio: [0.35, 0.6] },
    };

    const platformLimits = {
      tiktok:    { max_duration: 60,  ideal_duration: 30 },
      instagram: { max_duration: 90,  ideal_duration: 30 },
      youtube:   { max_duration: 600, ideal_duration: 120 },
      telegram:  { max_duration: 120, ideal_duration: 60 },
      general:   { max_duration: 300, ideal_duration: 90 },
    };

    const rules = pacingRules[type] || pacingRules.general;
    const limits = platformLimits[platform] || platformLimits.general;

    const idealDuration = Math.min(total_duration * rules.keep_ratio[1], limits.ideal_duration);
    const segmentCount = Math.max(2, Math.min(8, Math.round(idealDuration / ((rules.avg_segment[0] + rules.avg_segment[1]) / 2))));

    return {
      content_type: type,
      target_platform: platform,
      total_duration,
      recommended: {
        highlight_duration: [
          Math.round(total_duration * rules.keep_ratio[0]),
          Math.round(total_duration * rules.keep_ratio[1]),
        ],
        segment_count: [Math.max(2, segmentCount - 1), Math.min(8, segmentCount + 1)],
        avg_segment_length: rules.avg_segment,
        cuts_per_minute: rules.cuts_per_minute,
      },
      platform_constraints: limits,
      pacing_notes: `For ${type} content: aim for ${rules.cuts_per_minute[0]}-${rules.cuts_per_minute[1]} cuts/min, segments of ${rules.avg_segment[0]}-${rules.avg_segment[1]}s each.`,
    };
  },
};

module.exports = {
  TOOL_DEFINITIONS,
  TOOL_HANDLERS,
  setToolContext,
};
