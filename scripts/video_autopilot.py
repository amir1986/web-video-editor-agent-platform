#!/usr/bin/env python3
"""
Video Autopilot — AI-powered highlight reel generator.

Optimized for NVIDIA RTX 4070 (12GB VRAM). Handles videos from 5 seconds to 10 hours
by sequentially loading/unloading GPU models and processing frames in batches.

Pipeline:
  Phase 0: PROBE    — ffprobe metadata (duration, resolution, codec, fps, bitrate)
  Phase 1: AUDIO    — faster-whisper (GPU) → speech timestamps → free VRAM
  Phase 2: VISION   — Ollama qwen2.5-vl → frame highlight classification (batched)
  Phase 3: MERGE    — consensus filter → segment list → EditPlan JSON
  Phase 4: ASSEMBLE — ffmpeg -c copy (concat) or filter_complex (soft transitions)

Usage:
  python scripts/video_autopilot.py input.mp4
  python scripts/video_autopilot.py input.mp4 -o highlights.mp4 --keep-ratio 0.4
  python scripts/video_autopilot.py input.mp4 --plan-only > edit_plan.json
  python scripts/video_autopilot.py input.mp4 --resume /tmp/video_autopilot/metadata.json
"""

import argparse
import base64
import hashlib
import json
import logging
import math
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

log = logging.getLogger("autopilot")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BATCH_SIZE = 50            # frames per Ollama batch
FRAME_SCALE_WIDTH = 320    # downscale frames for vision (px)
MIN_SEGMENT_SEC = 2.0      # minimum segment duration
MERGE_GAP_SEC = 1.0        # merge segments closer than this
SPEECH_PAD_SEC = 0.5       # pad speech segments to avoid mid-word cuts
CUT_PAD_SEC = 3.0          # buffer around approved segments
SCENE_THRESHOLD = 0.3      # ffmpeg scene change threshold
RMS_THRESHOLD = 0.01       # audio RMS intensity threshold
VISION_CONFIDENCE = 0.7    # Qwen highlight confidence threshold
CHECKPOINT_VERSION = 2
MAX_HTTP_RETRIES = 3
HTTP_BASE_DELAY = 2.0

# ---------------------------------------------------------------------------
# Utility: subprocess runners
# ---------------------------------------------------------------------------


def run_cmd(args, capture_stdout=True, capture_stderr=True, timeout=600):
    """Run a subprocess, return stdout string. Raises on non-zero exit."""
    log.debug("[CMD] %s", " ".join(str(a) for a in args))
    result = subprocess.run(
        [str(a) for a in args],
        stdout=subprocess.PIPE if capture_stdout else None,
        stderr=subprocess.PIPE if capture_stderr else None,
        timeout=timeout,
    )
    if result.returncode != 0:
        stderr = (result.stderr or b"").decode(errors="replace")
        raise RuntimeError(f"Command failed ({result.returncode}): {stderr[:500]}")
    return (result.stdout or b"").decode(errors="replace")


def ffprobe_json(video_path, *extra_args):
    """Run ffprobe and return parsed JSON."""
    args = [
        "ffprobe", "-v", "error", *extra_args,
        "-of", "json", str(video_path),
    ]
    out = run_cmd(args, timeout=120)
    return json.loads(out)


def ffmpeg_run(args, timeout=3600):
    """Run ffmpeg with the given arguments."""
    run_cmd(["ffmpeg", *[str(a) for a in args]], timeout=timeout)


# ---------------------------------------------------------------------------
# Utility: HTTP with retry (matches existing project pattern)
# ---------------------------------------------------------------------------


def http_post_json(url, payload, retries=MAX_HTTP_RETRIES, timeout=120):
    """POST JSON to url with retry + exponential backoff. Returns parsed JSON."""
    data = json.dumps(payload).encode()
    last_err = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                url,
                data=data,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            last_err = e
            if attempt < retries:
                delay = HTTP_BASE_DELAY * (2 ** attempt)
                log.warning("[HTTP] Attempt %d failed: %s. Retry in %.0fs...", attempt + 1, e, delay)
                time.sleep(delay)
    raise RuntimeError(f"HTTP request failed after {retries + 1} attempts: {last_err}")


# ---------------------------------------------------------------------------
# Utility: file hashing for checkpoint integrity
# ---------------------------------------------------------------------------


def file_hash(path, chunk_size=1024 * 1024):
    """SHA-256 of first 1MB for fast checkpoint validation."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read(chunk_size))
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Phase 0: Probe video metadata
# ---------------------------------------------------------------------------


def probe_video(video_path):
    """Probe video with ffprobe. Returns metadata dict."""
    log.info("[PROBE] Analyzing %s", video_path)

    data = ffprobe_json(
        video_path,
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,codec_name,pix_fmt,profile,bit_rate",
        "-show_entries", "format=duration,bit_rate",
    )

    v = {}
    for s in data.get("streams", []):
        if s.get("codec_type", "") == "video" or "width" in s:
            v = s
            break
    if not v and data.get("streams"):
        v = data["streams"][0]

    fmt = data.get("format", {})

    # Parse frame rate
    fps = 30
    rfr = v.get("r_frame_rate", "30/1")
    if "/" in str(rfr):
        parts = rfr.split("/")
        num, den = int(parts[0]), int(parts[1] or 1)
        if den > 0:
            fps = round(num / den)
    elif rfr:
        fps = int(float(rfr))

    duration = float(fmt.get("duration", 0))
    if duration <= 0:
        # Try video stream duration
        duration = float(v.get("duration", 0))

    video_bitrate = int(v.get("bit_rate") or 0)
    if not video_bitrate and fmt.get("bit_rate"):
        video_bitrate = max(0, int(fmt["bit_rate"]) - 192000)

    # Probe audio stream separately
    audio_bitrate = 0
    audio_sample_rate = 44100
    audio_channels = 2
    has_audio = False
    try:
        adata = ffprobe_json(
            video_path,
            "-select_streams", "a:0",
            "-show_entries", "stream=bit_rate,sample_rate,channels,codec_name",
        )
        for s in adata.get("streams", []):
            has_audio = True
            audio_bitrate = int(s.get("bit_rate") or 0)
            audio_sample_rate = int(s.get("sample_rate") or 44100)
            audio_channels = int(s.get("channels") or 2)
            break
    except Exception:
        pass

    meta = {
        "duration": duration,
        "width": int(v.get("width") or 0),
        "height": int(v.get("height") or 0),
        "fps": fps,
        "codec": v.get("codec_name", ""),
        "pix_fmt": v.get("pix_fmt", "yuv420p"),
        "profile": v.get("profile", ""),
        "video_bitrate": video_bitrate,
        "audio_bitrate": audio_bitrate,
        "audio_sample_rate": audio_sample_rate,
        "audio_channels": audio_channels,
        "has_audio": has_audio,
    }

    log.info(
        "[PROBE] %dx%d %dfps %.1fs, codec=%s/%s, v_bitrate=%d, a_bitrate=%d, audio=%s",
        meta["width"], meta["height"], meta["fps"], meta["duration"],
        meta["codec"], meta["pix_fmt"], meta["video_bitrate"], meta["audio_bitrate"],
        meta["has_audio"],
    )
    return meta


# ---------------------------------------------------------------------------
# Phase 1: Audio analysis (faster-whisper on GPU)
# ---------------------------------------------------------------------------


def analyze_audio(video_path, whisper_model="small"):
    """
    Transcribe audio with faster-whisper on GPU.
    Returns list of {"start", "end", "text"} speech segments.
    Frees VRAM after completion (the "4070 switch").
    """
    log.info("[AUDIO] Loading faster-whisper model=%s on GPU...", whisper_model)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        log.warning("[AUDIO] faster-whisper not installed. Skipping audio analysis.")
        return []

    # Try GPU first, fall back to CPU on OOM
    model = None
    device_used = "cuda"
    try:
        model = WhisperModel(whisper_model, device="cuda", compute_type="float16")
        log.info("[AUDIO] Model loaded on CUDA (float16)")
    except Exception as e:
        log.warning("[AUDIO] CUDA failed (%s), falling back to CPU", e)
        device_used = "cpu"
        try:
            model = WhisperModel(whisper_model, device="cpu", compute_type="int8")
            log.info("[AUDIO] Model loaded on CPU (int8)")
        except Exception as e2:
            log.error("[AUDIO] Cannot load whisper model: %s", e2)
            return []

    try:
        log.info("[AUDIO] Transcribing...")
        t0 = time.time()
        segments_iter, info = model.transcribe(
            str(video_path),
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
        )

        speech = []
        for seg in segments_iter:
            speech.append({
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": seg.text.strip(),
            })

        elapsed = time.time() - t0
        log.info("[AUDIO] Transcription complete: %d segments in %.1fs (device=%s)", len(speech), elapsed, device_used)
        return speech

    finally:
        # FREE VRAM — critical for RTX 4070 12GB
        del model
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
                log.info("[AUDIO] VRAM freed (torch.cuda.empty_cache)")
        except ImportError:
            pass


def compute_audio_rms(video_path, start, end):
    """Compute RMS audio intensity for a time range using ffmpeg."""
    try:
        duration = end - start
        if duration <= 0:
            return 0.0
        args = [
            "ffmpeg", "-v", "error",
            "-ss", str(start), "-t", str(duration),
            "-i", str(video_path),
            "-af", "volumedetect",
            "-f", "null", "-",
        ]
        result = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
        stderr = result.stderr.decode(errors="replace")
        match = re.search(r"mean_volume:\s*([-\d.]+)\s*dB", stderr)
        if match:
            db = float(match.group(1))
            # Convert dB to linear RMS (0 dB = 1.0)
            rms = 10 ** (db / 20)
            return rms
        return 0.0
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# Phase 2: Vision analysis (Ollama qwen2.5-vl)
# ---------------------------------------------------------------------------


def get_sample_interval(duration):
    """Dynamic frame sampling interval based on video duration."""
    if duration < 60:
        return 1.0
    if duration < 600:
        return 5.0
    if duration < 3600:
        return 10.0
    return 20.0


def extract_frame_base64(video_path, timestamp):
    """Extract a single frame at timestamp as base64 JPEG using ffmpeg."""
    args = [
        "ffmpeg", "-v", "error",
        "-ss", str(timestamp),
        "-i", str(video_path),
        "-vframes", "1",
        "-vf", f"scale={FRAME_SCALE_WIDTH}:-2",
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-",
    ]
    result = subprocess.run(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    if result.returncode != 0 or not result.stdout:
        return None
    return base64.b64encode(result.stdout).decode("ascii")


def detect_scene_changes(video_path, threshold=SCENE_THRESHOLD):
    """Detect scene changes using ffmpeg. Returns list of timestamps."""
    log.info("[SCENE] Detecting scene changes (threshold=%.2f)...", threshold)
    try:
        args = [
            "ffprobe", "-v", "error",
            "-select_streams", "v",
            "-show_entries", "frame=pts_time",
            "-of", "csv=p=0",
            "-f", "lavfi",
            f"movie={video_path},select='gt(scene\\,{threshold})'",
        ]
        out = run_cmd(args, timeout=600)
        timestamps = []
        for line in out.strip().split("\n"):
            line = line.strip()
            if line:
                try:
                    timestamps.append(float(line))
                except ValueError:
                    pass
        log.info("[SCENE] Found %d scene changes", len(timestamps))
        return timestamps
    except Exception as e:
        log.warning("[SCENE] Scene detection failed: %s", e)
        return []


def classify_frame_ollama(frame_b64, timestamp, ollama_url, model):
    """Send a single frame to Ollama for highlight classification."""
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "You are a professional video editor. Look at this frame from a video "
                        f"(timestamp {timestamp:.1f}s). "
                        "Is this frame part of a highlight moment? "
                        "(action, emotion, key point, humor, strong visual, important content)\n"
                        "Answer ONLY with a JSON object:\n"
                        '{"is_highlight": true/false, "confidence": 0.0-1.0, "reason": "brief reason"}'
                    ),
                },
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{frame_b64}"},
                },
            ],
        }],
        "stream": False,
        "temperature": 0,
    }

    resp = http_post_json(f"{ollama_url}/v1/chat/completions", payload, timeout=120)
    text = resp.get("choices", [{}])[0].get("message", {}).get("content", "")

    # Parse JSON from response
    match = re.search(r"\{[\s\S]*?\}", text)
    if match:
        try:
            data = json.loads(match.group())
            return {
                "timestamp": timestamp,
                "is_highlight": bool(data.get("is_highlight", False)),
                "confidence": float(data.get("confidence", 0.5)),
                "reason": str(data.get("reason", "")),
            }
        except (json.JSONDecodeError, ValueError):
            pass

    # Fallback: check for yes/no keywords
    text_lower = text.lower()
    is_hl = "true" in text_lower or "yes" in text_lower
    return {
        "timestamp": timestamp,
        "is_highlight": is_hl,
        "confidence": 0.5,
        "reason": text[:100],
    }


def analyze_vision(video_path, duration, ollama_url, model,
                   checkpoint=None, checkpoint_path=None, video_meta=None):
    """
    Sample frames dynamically and classify with Ollama.
    Processes in batches of BATCH_SIZE frames for connection stability.
    Supports resume from checkpoint.
    """
    interval = get_sample_interval(duration)
    total_frames = max(1, int(duration / interval))
    timestamps = [i * interval for i in range(total_frames) if i * interval < duration]
    total_frames = len(timestamps)

    log.info(
        "[VISION] Sampling %d frames (interval=%.1fs) from %.1fs video",
        total_frames, interval, duration,
    )

    # Resume from checkpoint
    results = []
    start_idx = 0
    if checkpoint and checkpoint.get("vision_results"):
        results = checkpoint["vision_results"]
        start_idx = checkpoint.get("last_frame_index", 0) + 1
        if start_idx > 0:
            log.info("[VISION] Resuming from frame %d/%d", start_idx, total_frames)

    # Check Ollama connectivity
    ollama_available = True
    try:
        urllib.request.urlopen(f"{ollama_url}/v1/models", timeout=5)
    except Exception:
        log.warning("[VISION] Ollama not reachable at %s. Using scene-detection fallback.", ollama_url)
        ollama_available = False

    if not ollama_available:
        return _scene_detect_to_vision_results(video_path, duration)

    # Process frames in batches
    progress_interval = max(1, total_frames // 100)  # log every 1%
    t0 = time.time()

    for batch_start in range(start_idx, total_frames, BATCH_SIZE):
        batch_end = min(batch_start + BATCH_SIZE, total_frames)

        for i in range(batch_start, batch_end):
            ts = timestamps[i]
            frame_b64 = extract_frame_base64(video_path, ts)
            if not frame_b64:
                log.debug("[VISION] Failed to extract frame at %.1fs, skipping", ts)
                continue

            try:
                result = classify_frame_ollama(frame_b64, ts, ollama_url, model)
                results.append(result)
            except Exception as e:
                log.warning("[VISION] Frame %.1fs failed: %s", ts, e)
                results.append({
                    "timestamp": ts,
                    "is_highlight": False,
                    "confidence": 0.0,
                    "reason": f"error: {e}",
                })

            # Progress logging
            if (i + 1) % progress_interval == 0 or i == total_frames - 1:
                pct = ((i + 1) / total_frames) * 100
                elapsed = time.time() - t0
                eta = (elapsed / (i - start_idx + 1)) * (total_frames - i - 1) if i > start_idx else 0
                log.info(
                    "[VISION] Progress: %d/%d frames (%.1f%%) elapsed=%.0fs ETA=%.0fs",
                    i + 1, total_frames, pct, elapsed, eta,
                )

        # Checkpoint after each batch
        if checkpoint_path:
            save_checkpoint(checkpoint_path, "vision", {
                "vision_results": results,
                "last_frame_index": batch_end - 1,
                "video_meta": video_meta,
            })

    elapsed = time.time() - t0
    highlight_count = sum(1 for r in results if r.get("is_highlight"))
    log.info(
        "[VISION] Complete: %d/%d frames are highlights (%.1f%%) in %.1fs",
        highlight_count, len(results), (highlight_count / max(1, len(results))) * 100, elapsed,
    )
    return results


def _scene_detect_to_vision_results(video_path, duration):
    """Fallback: use scene detection when Ollama is unavailable."""
    scene_times = detect_scene_changes(video_path)
    if not scene_times:
        # Ultimate fallback: evenly spaced highlights
        interval = get_sample_interval(duration)
        scene_times = [i * interval for i in range(int(duration / interval))]

    results = []
    for ts in scene_times:
        results.append({
            "timestamp": ts,
            "is_highlight": True,
            "confidence": 0.6,
            "reason": "scene change detected",
        })
    return results


# ---------------------------------------------------------------------------
# Phase 3: Merge + Consensus filter + EditPlan
# ---------------------------------------------------------------------------


def merge_and_build_plan(speech_segments, vision_results, video_meta,
                         keep_ratio=0.45, video_path=None):
    """
    Consensus-based filtering:
    - Audio: RMS intensity > threshold
    - Transcription: speech detected
    - Vision: Qwen confidence > threshold
    Approve segment only if criteria are met, add buffer padding.
    Returns EditPlan dict.
    """
    duration = video_meta["duration"]
    if duration <= 0:
        raise ValueError("Video duration is 0")

    # Grid resolution: 0.5s for short videos, 1.0s for long
    grid_res = 0.5 if duration < 600 else 1.0
    grid_size = int(math.ceil(duration / grid_res))
    scores = [0.0] * grid_size

    # Score from speech segments (pad ±0.5s for word boundaries)
    speech_intervals = []
    for seg in speech_segments:
        start = max(0, seg["start"] - SPEECH_PAD_SEC)
        end = min(duration, seg["end"] + SPEECH_PAD_SEC)
        speech_intervals.append((start, end))
        for i in range(int(start / grid_res), min(grid_size, int(end / grid_res) + 1)):
            scores[i] += 2.0

    # Score from vision highlights
    for vr in vision_results:
        if vr.get("is_highlight") and vr.get("confidence", 0) >= VISION_CONFIDENCE:
            ts = vr["timestamp"]
            # Spread score ±2 grid cells around the highlight frame
            center = int(ts / grid_res)
            for offset in range(-2, 3):
                idx = center + offset
                if 0 <= idx < grid_size:
                    weight = 3.0 if offset == 0 else 1.5
                    scores[idx] += weight * vr.get("confidence", 0.7)

    # Scene change bonus (snap cut points to scene boundaries)
    scene_times = []
    try:
        scene_times = detect_scene_changes(str(video_path)) if video_path else []
    except Exception:
        pass
    for st in scene_times:
        idx = int(st / grid_res)
        for offset in range(-2, 3):
            i = idx + offset
            if 0 <= i < grid_size:
                scores[i] += 1.0

    # --- Consensus filtering ---
    # Find score threshold that yields ~keep_ratio of total duration
    target_cells = int(grid_size * keep_ratio)
    sorted_scores = sorted(scores, reverse=True)
    if target_cells > 0 and target_cells <= len(sorted_scores):
        threshold = sorted_scores[min(target_cells, len(sorted_scores) - 1)]
    else:
        threshold = 0.1

    # Minimum threshold to avoid selecting silence/empty
    threshold = max(threshold, 0.5)

    # Select cells above threshold
    selected = [scores[i] >= threshold for i in range(grid_size)]

    # Audio RMS consensus: verify selected regions have audible content
    # (only for videos with audio, and only spot-check to avoid slowness)
    if video_path and video_meta.get("has_audio") and duration < 3600:
        # Sample RMS at segment boundaries to verify audio activity
        _apply_rms_filter(selected, grid_res, video_path, duration)

    # Convert selected cells to continuous segments
    raw_segments = _cells_to_segments(selected, grid_res, duration)

    # Apply constraints
    segments = _apply_segment_constraints(raw_segments, duration, keep_ratio, speech_intervals)

    if not segments:
        # Emergency fallback: keep first and last 10% of video
        log.warning("[MERGE] No segments selected, using fallback (first+last 10%%)")
        ten_pct = max(MIN_SEGMENT_SEC, duration * 0.1)
        segments = [
            {"src_in": 0, "src_out": ten_pct, "reason": "fallback: opening"},
            {"src_in": max(0, duration - ten_pct), "src_out": duration, "reason": "fallback: ending"},
        ]

    # Add CUT_PAD_SEC buffer around each approved segment
    for seg in segments:
        seg["src_in"] = max(0, seg["src_in"] - CUT_PAD_SEC)
        seg["src_out"] = min(duration, seg["src_out"] + CUT_PAD_SEC)

    # Re-merge after padding (padding may cause overlaps)
    segments = _merge_close_segments(segments, gap_threshold=0)

    # Enforce keep_ratio bounds (±15% tolerance)
    total_kept = sum(s["src_out"] - s["src_in"] for s in segments)
    target_dur = duration * keep_ratio
    if total_kept > target_dur * 1.15:
        segments = _trim_to_target(segments, target_dur)
    elif total_kept < target_dur * 0.5 and len(segments) < 2:
        # Too little content selected — expand segments
        pass

    # Assign IDs
    for i, seg in enumerate(segments):
        seg["id"] = f"s{i + 1}"
        if "reason" not in seg:
            seg["reason"] = "auto-selected highlight"

    # Assign transitions
    transitions = _assign_transitions(segments)

    # Build render constraints from video metadata
    render_constraints = {
        "keep_resolution": True,
        "keep_aspect_ratio": True,
        "no_stretch": True,
        "target_width": video_meta.get("width", 1920),
        "target_height": video_meta.get("height", 1080),
        "codec": "libx264",
        "crf": 18,
        "source_video_bitrate": video_meta.get("video_bitrate", 0),
        "source_audio_bitrate": video_meta.get("audio_bitrate", 0),
        "preset": "fast",
        "pixel_format": "yuv420p",
        "fps": video_meta.get("fps", 30),
        "fps_mode": "cfr",
    }

    plan = {
        "segments": segments,
        "transitions": transitions,
        "render_constraints": render_constraints,
    }

    # Validate
    plan = validate_edit_plan(plan, duration)

    total_kept = sum(s["src_out"] - s["src_in"] for s in plan["segments"])
    log.info(
        "[MERGE] EditPlan: %d segments, %.1fs kept (%.0f%% of %.1fs)",
        len(plan["segments"]), total_kept, (total_kept / duration) * 100, duration,
    )
    return plan


def _apply_rms_filter(selected, grid_res, video_path, duration):
    """Spot-check RMS audio on selected regions. Deselect silent regions."""
    # Sample every 10th selected cell to keep it fast
    checked = 0
    deselected = 0
    for i in range(0, len(selected), 10):
        if not selected[i]:
            continue
        start = i * grid_res
        end = min(duration, start + grid_res * 5)
        rms = compute_audio_rms(video_path, start, end)
        checked += 1
        if rms < RMS_THRESHOLD:
            # Deselect this chunk — it's silent
            for j in range(i, min(len(selected), i + 5)):
                selected[j] = False
            deselected += 1
    if checked > 0:
        log.debug("[RMS] Checked %d regions, deselected %d silent ones", checked, deselected)


def _cells_to_segments(selected, grid_res, duration):
    """Convert boolean grid to list of {"src_in", "src_out"} segments."""
    segments = []
    in_segment = False
    seg_start = 0

    for i in range(len(selected)):
        if selected[i] and not in_segment:
            seg_start = i * grid_res
            in_segment = True
        elif not selected[i] and in_segment:
            seg_end = i * grid_res
            segments.append({"src_in": seg_start, "src_out": min(seg_end, duration)})
            in_segment = False

    if in_segment:
        segments.append({"src_in": seg_start, "src_out": duration})

    return segments


def _apply_segment_constraints(segments, duration, keep_ratio, speech_intervals):
    """Enforce minimum duration, merge gaps, limit count."""
    # Remove segments shorter than MIN_SEGMENT_SEC
    segments = [s for s in segments if (s["src_out"] - s["src_in"]) >= MIN_SEGMENT_SEC]

    # Merge segments that are close together
    segments = _merge_close_segments(segments, MERGE_GAP_SEC)

    # Snap segment boundaries to speech boundaries (avoid mid-word cuts)
    for seg in segments:
        for sp_start, sp_end in speech_intervals:
            # If segment starts inside a speech chunk, extend back
            if sp_start < seg["src_in"] < sp_end:
                seg["src_in"] = sp_start
            # If segment ends inside a speech chunk, extend forward
            if sp_start < seg["src_out"] < sp_end:
                seg["src_out"] = sp_end

    # Re-merge after speech snapping
    segments = _merge_close_segments(segments, MERGE_GAP_SEC)

    # Limit segment count (too many = choppy)
    max_segments = max(2, min(20, int(duration / 60)))
    if len(segments) > max_segments:
        # Keep highest-scoring segments (by duration as proxy for confidence)
        segments.sort(key=lambda s: s["src_out"] - s["src_in"], reverse=True)
        segments = segments[:max_segments]
        segments.sort(key=lambda s: s["src_in"])

    # Ensure sorted by src_in
    segments.sort(key=lambda s: s["src_in"])

    return segments


def _merge_close_segments(segments, gap_threshold):
    """Merge segments that are less than gap_threshold apart."""
    if not segments:
        return []
    segments = sorted(segments, key=lambda s: s["src_in"])
    merged = [dict(segments[0])]
    for seg in segments[1:]:
        last = merged[-1]
        # Overlapping or close enough to merge
        if seg["src_in"] <= last["src_out"] + gap_threshold:
            last["src_out"] = max(last["src_out"], seg["src_out"])
            # Combine reasons if both have them
            if "reason" in seg and "reason" in last:
                if seg["reason"] not in last["reason"]:
                    last["reason"] = last.get("reason", "") + "; " + seg.get("reason", "")
        else:
            merged.append(dict(seg))
    return merged


def _trim_to_target(segments, target_dur):
    """Trim segments to hit target duration by shortening the longest ones."""
    total = sum(s["src_out"] - s["src_in"] for s in segments)
    excess = total - target_dur
    if excess <= 0:
        return segments

    # Remove shortest segments first until close to target
    segments_by_dur = sorted(segments, key=lambda s: s["src_out"] - s["src_in"])
    while excess > 0 and len(segments_by_dur) > 1:
        shortest = segments_by_dur[0]
        shortest_dur = shortest["src_out"] - shortest["src_in"]
        if shortest_dur <= excess:
            segments_by_dur.pop(0)
            excess -= shortest_dur
        else:
            break

    return sorted(segments_by_dur, key=lambda s: s["src_in"])


def _assign_transitions(segments):
    """Assign transition types between segments."""
    transitions = []
    for i in range(len(segments) - 1):
        gap = segments[i + 1]["src_in"] - segments[i]["src_out"]
        if gap > 30:
            ttype = "dip_to_black"
        elif gap > 15:
            ttype = "fade"
        else:
            ttype = "hard_cut"
        transitions.append({
            "from": segments[i]["id"],
            "to": segments[i + 1]["id"],
            "type": ttype,
        })
    return transitions


def validate_edit_plan(plan, duration):
    """Validate and fix EditPlan: sorted, no overlaps, within bounds, re-ID."""
    segments = plan.get("segments", [])

    # Sort by src_in
    segments.sort(key=lambda s: s["src_in"])

    # Clamp to duration
    for seg in segments:
        seg["src_in"] = max(0, min(seg["src_in"], duration))
        seg["src_out"] = max(seg["src_in"] + 0.1, min(seg["src_out"], duration))

    # Remove overlaps
    cleaned = []
    for seg in segments:
        if cleaned and seg["src_in"] < cleaned[-1]["src_out"]:
            seg["src_in"] = cleaned[-1]["src_out"]
        if seg["src_out"] > seg["src_in"] + 0.1:
            cleaned.append(seg)
    segments = cleaned

    # Re-assign IDs
    for i, seg in enumerate(segments):
        seg["id"] = f"s{i + 1}"

    plan["segments"] = segments

    # Rebuild transitions
    plan["transitions"] = _assign_transitions(segments)

    return plan


# ---------------------------------------------------------------------------
# Phase 4: Assembly (ffmpeg)
# ---------------------------------------------------------------------------


def can_stream_copy(video_meta):
    """Check if source codec allows lossless stream copy."""
    codec = video_meta.get("codec", "").lower()
    pix_fmt = video_meta.get("pix_fmt", "")
    profile = video_meta.get("profile", "").lower()

    if codec != "h264":
        return False
    if pix_fmt not in ("yuv420p", "yuvj420p"):
        return False
    if "4:4:4" in profile or "high 4:4:4" in profile:
        return False
    return True


def build_encoding_args(meta):
    """Build ffmpeg args matching source quality."""
    v_args = []
    a_args = []

    v_args.extend(["-c:v", "libx264"])
    if meta.get("video_bitrate", 0) > 0:
        vbr = str(meta["video_bitrate"])
        v_args.extend(["-crf", "18", "-maxrate", vbr, "-bufsize", str(meta["video_bitrate"] * 2)])
    else:
        v_args.extend(["-crf", "18"])
    v_args.extend(["-preset", "fast"])
    v_args.extend(["-pix_fmt", "yuv420p"])

    if meta.get("width", 0) > 0 and meta.get("height", 0) > 0:
        v_args.extend(["-s", f"{meta['width']}x{meta['height']}"])
    if meta.get("fps", 0) > 0:
        v_args.extend(["-r", str(meta["fps"])])

    v_args.extend(["-movflags", "+faststart"])

    if meta.get("audio_bitrate", 0) > 0:
        a_args.extend(["-c:a", "aac", "-b:a", str(meta["audio_bitrate"])])
    else:
        a_args.extend(["-c:a", "aac", "-b:a", "192k"])
    if meta.get("audio_sample_rate"):
        a_args.extend(["-ar", str(meta["audio_sample_rate"])])
    if meta.get("audio_channels"):
        a_args.extend(["-ac", str(meta["audio_channels"])])

    return v_args, a_args


def assemble_video(video_path, edit_plan, output_path, video_meta):
    """Render EditPlan to output video using ffmpeg."""
    segments = edit_plan.get("segments", [])
    if not segments:
        raise ValueError("EditPlan has no segments")

    transitions = edit_plan.get("transitions", [])
    needs_reencode = any(t.get("type") != "hard_cut" for t in transitions)
    copy_ok = can_stream_copy(video_meta)

    strategy = "re-encode"
    if not needs_reencode and copy_ok:
        strategy = "stream copy"
    elif not needs_reencode:
        strategy = "re-encode (codec incompatible for copy)"

    log.info(
        "[ASSEMBLE] Strategy: %s, segments=%d, transitions=%d",
        strategy, len(segments), len(transitions),
    )

    tmp_dir = tempfile.mkdtemp(prefix="video_autopilot_")
    try:
        _do_assemble(video_path, segments, transitions, output_path, video_meta,
                     needs_reencode, copy_ok, tmp_dir)
    finally:
        # Cleanup temp files
        import shutil
        try:
            shutil.rmtree(tmp_dir)
        except Exception:
            pass


def _do_assemble(video_path, segments, transitions, output_path, meta,
                 needs_reencode, copy_ok, tmp_dir):
    """Internal assembly logic."""
    vpath = str(video_path)
    opath = str(output_path)

    copy_args = ["-c", "copy"] if copy_ok else []
    if not copy_ok:
        v_args, a_args = build_encoding_args(meta)
        copy_args = v_args + a_args

    # Single segment
    if len(segments) == 1:
        seg = segments[0]
        dur = seg["src_out"] - seg["src_in"]
        log.info("[ASSEMBLE] Single segment: %.1fs → %.1fs (%.1fs)", seg["src_in"], seg["src_out"], dur)
        codec_args = ["-c", "copy"] if (copy_ok and not needs_reencode) else copy_args
        ffmpeg_run([
            "-y", "-loglevel", "error",
            "-ss", str(seg["src_in"]), "-i", vpath,
            "-t", str(dur),
            *codec_args,
            "-avoid_negative_ts", "make_zero",
            opath,
        ])
        return

    # Extract individual segments
    seg_files = []
    for i, seg in enumerate(segments):
        seg_path = os.path.join(tmp_dir, f"seg_{i}.mp4")
        dur = seg["src_out"] - seg["src_in"]
        log.info("[ASSEMBLE] Extracting segment %s: %.1fs → %.1fs", seg["id"], seg["src_in"], seg["src_out"])

        # Always stream copy for extraction (fast), re-encode during final assembly
        extract_args = ["-c", "copy"] if copy_ok else copy_args
        ffmpeg_run([
            "-y", "-loglevel", "error",
            "-ss", str(seg["src_in"]), "-i", vpath,
            "-t", str(dur),
            *extract_args,
            "-avoid_negative_ts", "make_zero",
            seg_path,
        ])
        seg_files.append(seg_path)

    # All hard cuts — simple concat
    if not needs_reencode:
        log.info("[ASSEMBLE] Concat %d segments (all hard cuts)", len(seg_files))
        concat_file = os.path.join(tmp_dir, "concat.txt")
        with open(concat_file, "w") as f:
            for sf in seg_files:
                f.write(f"file '{sf}'\n")

        ffmpeg_run([
            "-y", "-loglevel", "error",
            "-f", "concat", "-safe", "0",
            "-i", concat_file,
            "-c", "copy",
            "-movflags", "+faststart",
            opath,
        ])
        return

    # Has soft transitions — build xfade filter complex
    log.info("[ASSEMBLE] Building filter_complex for %d transitions", len(transitions))
    _assemble_with_transitions(seg_files, segments, transitions, meta, opath, tmp_dir)


def _assemble_with_transitions(seg_files, segments, transitions, meta, output_path, tmp_dir):
    """Build xfade filter_complex for soft transitions."""
    FADE_DURATION = 0.5

    trans_map = {}
    for t in transitions:
        trans_map[t["from"]] = t

    # Check if audio exists
    has_audio = meta.get("has_audio", False)

    # Map transition types to xfade names
    xfade_map = {
        "dissolve": "dissolve",
        "fade": "fade",
        "dip_to_black": "fadeblack",
        "wipe": "wipeleft",
        "hard_cut": "fade",
    }

    seg_durations = [s["src_out"] - s["src_in"] for s in segments]

    filter_parts = []
    audio_parts = []
    last_v = "[0:v]"
    last_a = "[0:a]"
    cumulative = seg_durations[0]

    for i in range(len(segments) - 1):
        trans = trans_map.get(segments[i]["id"])
        ttype = trans["type"] if trans else "hard_cut"

        fade_dur = 0.001 if ttype == "hard_cut" else FADE_DURATION
        offset = max(0, cumulative - fade_dur)
        v_out = f"[v{i + 1}]"
        a_out = f"[a{i + 1}]"

        xfade_name = xfade_map.get(ttype, "fade")
        filter_parts.append(
            f"{last_v}[{i + 1}:v]xfade=transition={xfade_name}:duration={fade_dur}:offset={offset:.3f}{v_out}"
        )
        if has_audio:
            audio_parts.append(f"{last_a}[{i + 1}:a]acrossfade=d={fade_dur}{a_out}")
            last_a = a_out
        last_v = v_out
        cumulative = offset + seg_durations[i + 1]

    if not filter_parts:
        # Fallback to concat
        concat_file = os.path.join(tmp_dir, "concat.txt")
        with open(concat_file, "w") as f:
            for sf in seg_files:
                f.write(f"file '{sf}'\n")
        v_args, a_args = build_encoding_args(meta)
        ffmpeg_run([
            "-y", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", concat_file,
            *v_args, *a_args,
            output_path,
        ])
        return

    all_filters = filter_parts + audio_parts if has_audio else filter_parts
    filter_complex = ";".join(all_filters)

    # Write filter to file (avoids shell escaping issues)
    filter_script = os.path.join(tmp_dir, "filter.txt")
    with open(filter_script, "w") as f:
        f.write(filter_complex)

    input_args = []
    for sf in seg_files:
        input_args.extend(["-i", sf])

    map_args = ["-map", last_v]
    if has_audio:
        map_args.extend(["-map", last_a])

    v_args, a_args = build_encoding_args(meta)
    # Remove -s, -r, -movflags from v_args (xfade handles these)
    skip = {"-s", "-r", "-movflags"}
    clean_v = []
    skip_next = False
    for arg in v_args:
        if skip_next:
            skip_next = False
            continue
        if arg in skip:
            skip_next = True
            continue
        clean_v.append(arg)

    audio_args = a_args if has_audio else ["-an"]

    log.info("[ASSEMBLE] Running xfade filter (%d video, %d audio filters)", len(filter_parts), len(audio_parts))

    try:
        ffmpeg_run([
            "-y", "-loglevel", "error",
            *input_args,
            "-filter_complex_script", filter_script,
            *map_args,
            *clean_v,
            "-fps_mode", "cfr",
            *audio_args,
            "-movflags", "+faststart",
            output_path,
        ], timeout=7200)
    except RuntimeError as e:
        log.warning("[ASSEMBLE] Filter complex failed (%s), falling back to concat re-encode", e)
        concat_file = os.path.join(tmp_dir, "concat.txt")
        with open(concat_file, "w") as f:
            for sf in seg_files:
                f.write(f"file '{sf}'\n")
        ffmpeg_run([
            "-y", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", concat_file,
            *v_args, *a_args,
            output_path,
        ], timeout=7200)


# ---------------------------------------------------------------------------
# Checkpointing
# ---------------------------------------------------------------------------


def get_checkpoint_path(video_path):
    """Default checkpoint path next to the video file."""
    vp = Path(video_path)
    return str(vp.parent / f".{vp.stem}_autopilot_checkpoint.json")


def save_checkpoint(path, phase, data):
    """Save processing checkpoint to JSON file."""
    checkpoint = {
        "version": CHECKPOINT_VERSION,
        "phase": phase,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    checkpoint.update(data)
    tmp_path = path + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(checkpoint, f, indent=2)
    os.replace(tmp_path, path)
    log.debug("[CHECKPOINT] Saved phase=%s to %s", phase, path)


def load_checkpoint(path, video_path):
    """Load checkpoint if valid for this video file."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r") as f:
            data = json.load(f)
        if data.get("version") != CHECKPOINT_VERSION:
            log.warning("[CHECKPOINT] Version mismatch, ignoring checkpoint")
            return None
        # Verify video hash if available
        if data.get("video_hash"):
            current_hash = file_hash(video_path)
            if data["video_hash"] != current_hash:
                log.warning("[CHECKPOINT] Video file changed, ignoring checkpoint")
                return None
        log.info("[CHECKPOINT] Resuming from phase=%s (%s)", data.get("phase"), data.get("timestamp"))
        return data
    except Exception as e:
        log.warning("[CHECKPOINT] Failed to load: %s", e)
        return None


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


def run_pipeline(args):
    """Run the full 5-phase pipeline."""
    video_path = os.path.abspath(args.input)
    if not os.path.isfile(video_path):
        log.error("Input file not found: %s", video_path)
        sys.exit(1)

    output_path = args.output
    if not output_path:
        vp = Path(video_path)
        output_path = str(vp.parent / f"{vp.stem}_highlights{vp.suffix}")

    checkpoint_path = args.resume or get_checkpoint_path(video_path)
    checkpoint = None
    if args.resume:
        checkpoint = load_checkpoint(args.resume, video_path)

    pipeline_start = time.time()
    log.info("=" * 60)
    log.info("Video Autopilot — Starting pipeline")
    log.info("  Input:  %s", video_path)
    log.info("  Output: %s", output_path)
    log.info("  Keep ratio: %.0f%%", args.keep_ratio * 100)
    log.info("=" * 60)

    # Phase 0: Probe
    if checkpoint and checkpoint.get("video_meta"):
        video_meta = checkpoint["video_meta"]
        log.info("[PROBE] Using cached metadata from checkpoint")
    else:
        video_meta = probe_video(video_path)

    if video_meta["duration"] <= 0:
        log.error("Could not determine video duration")
        sys.exit(1)

    v_hash = file_hash(video_path)

    # Phase 1: Audio
    speech_segments = []
    if checkpoint and checkpoint.get("phase") in ("vision", "plan", "done"):
        speech_segments = checkpoint.get("speech_segments", [])
        log.info("[AUDIO] Using %d cached speech segments from checkpoint", len(speech_segments))
    elif not args.no_audio:
        t0 = time.time()
        speech_segments = analyze_audio(video_path, args.whisper_model)
        log.info("[PIPELINE] Phase 1 (AUDIO) complete: %d speech segments in %.1fs",
                 len(speech_segments), time.time() - t0)

        save_checkpoint(checkpoint_path, "audio", {
            "video_hash": v_hash,
            "video_meta": video_meta,
            "speech_segments": speech_segments,
        })
    else:
        log.info("[AUDIO] Skipped (--no-audio)")

    # Phase 2: Vision
    vision_results = []
    if checkpoint and checkpoint.get("phase") in ("plan", "done"):
        vision_results = checkpoint.get("vision_results", [])
        log.info("[VISION] Using %d cached vision results from checkpoint", len(vision_results))
    elif not args.no_vision:
        t0 = time.time()
        vision_checkpoint = checkpoint if checkpoint and checkpoint.get("phase") == "vision" else None
        vision_results = analyze_vision(
            video_path, video_meta["duration"],
            args.ollama_url, args.vision_model,
            checkpoint=vision_checkpoint,
            checkpoint_path=checkpoint_path,
            video_meta=video_meta,
        )
        log.info("[PIPELINE] Phase 2 (VISION) complete: %d results in %.1fs",
                 len(vision_results), time.time() - t0)

        save_checkpoint(checkpoint_path, "vision_done", {
            "video_hash": v_hash,
            "video_meta": video_meta,
            "speech_segments": speech_segments,
            "vision_results": vision_results,
        })
    else:
        log.info("[VISION] Skipped (--no-vision)")
        # Use scene detection as fallback
        vision_results = _scene_detect_to_vision_results(video_path, video_meta["duration"])

    # Phase 3: Merge → EditPlan
    t0 = time.time()
    edit_plan = merge_and_build_plan(
        speech_segments, vision_results, video_meta,
        keep_ratio=args.keep_ratio,
        video_path=video_path,
    )
    log.info("[PIPELINE] Phase 3 (MERGE) complete in %.1fs", time.time() - t0)

    save_checkpoint(checkpoint_path, "plan", {
        "video_hash": v_hash,
        "video_meta": video_meta,
        "speech_segments": speech_segments,
        "vision_results": vision_results,
        "edit_plan": edit_plan,
    })

    # Output EditPlan
    if args.plan_only:
        print(json.dumps(edit_plan, indent=2))
        log.info("[PIPELINE] Plan-only mode — skipping assembly")
        return

    # Phase 4: Assembly
    t0 = time.time()
    assemble_video(video_path, edit_plan, output_path, video_meta)
    log.info("[PIPELINE] Phase 4 (ASSEMBLE) complete in %.1fs", time.time() - t0)

    # Save final checkpoint
    save_checkpoint(checkpoint_path, "done", {
        "video_hash": v_hash,
        "video_meta": video_meta,
        "edit_plan": edit_plan,
        "output_path": output_path,
    })

    # Write EditPlan JSON alongside output
    plan_path = str(Path(output_path).with_suffix(".json"))
    with open(plan_path, "w") as f:
        json.dump(edit_plan, f, indent=2)

    total_time = time.time() - pipeline_start
    total_kept = sum(s["src_out"] - s["src_in"] for s in edit_plan["segments"])
    log.info("=" * 60)
    log.info("Pipeline complete!")
    log.info("  Output:    %s", output_path)
    log.info("  EditPlan:  %s", plan_path)
    log.info("  Duration:  %.1fs → %.1fs (%.0f%% kept)",
             video_meta["duration"], total_kept,
             (total_kept / video_meta["duration"]) * 100)
    log.info("  Segments:  %d", len(edit_plan["segments"]))
    log.info("  Total time: %.1fs (%.1f min)", total_time, total_time / 60)
    log.info("=" * 60)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Video Autopilot — AI-powered highlight reel generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s input.mp4
  %(prog)s input.mp4 -o highlights.mp4 --keep-ratio 0.4
  %(prog)s input.mp4 --plan-only > edit_plan.json
  %(prog)s input.mp4 --no-vision          # scene-detect only, no Ollama
  %(prog)s input.mp4 --resume checkpoint.json
        """,
    )
    parser.add_argument("input", help="Path to input video file")
    parser.add_argument("-o", "--output", help="Output video path (default: <input>_highlights.mp4)")
    parser.add_argument(
        "--keep-ratio", type=float, default=0.45,
        help="Target ratio of video to keep (0.1–0.9, default: 0.45)",
    )
    parser.add_argument("--ollama-url", default="http://localhost:11434", help="Ollama server URL")
    parser.add_argument("--vision-model", default="qwen2.5vl:7b", help="Ollama vision model name")
    parser.add_argument("--whisper-model", default="small", help="Whisper model size (tiny/small/medium/large)")
    parser.add_argument("--no-audio", action="store_true", help="Skip speech analysis")
    parser.add_argument("--no-vision", action="store_true", help="Skip AI vision (use scene detection only)")
    parser.add_argument("--resume", help="Path to checkpoint JSON to resume from")
    parser.add_argument("--plan-only", action="store_true", help="Output EditPlan JSON without rendering")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable debug logging")

    args = parser.parse_args()

    # Validate keep_ratio
    args.keep_ratio = max(0.1, min(0.9, args.keep_ratio))

    # Setup logging
    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="[%(levelname)s] %(message)s",
        handlers=[logging.StreamHandler(sys.stderr)],
    )

    run_pipeline(args)


if __name__ == "__main__":
    main()
