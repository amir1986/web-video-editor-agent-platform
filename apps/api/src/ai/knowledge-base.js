/**
 * Video Editing Knowledge Base (RAG)
 *
 * Claude Cookbook pattern: Retrieval Augmented Generation
 * Instead of a vector DB, uses a curated embedded knowledge base with
 * keyword-based retrieval. This keeps the system self-contained and
 * works offline with both Ollama and Claude API.
 *
 * The knowledge base contains professional video editing best practices,
 * transition guidelines, pacing rules, and narrative structure patterns.
 * Agents can search it via the search_knowledge tool.
 */

// ---------------------------------------------------------------------------
// Knowledge entries — curated from professional editing guidelines
// ---------------------------------------------------------------------------

const KNOWLEDGE_BASE = [
  // ---- CUTS ----
  {
    id: "cut-001",
    category: "cuts",
    title: "The 180-Degree Rule",
    content: "Always maintain screen direction by keeping the camera on one side of the action axis. Crossing the 180-degree line between cuts causes spatial disorientation. When you must cross, use a neutral shot or a moving shot to bridge the transition.",
    keywords: ["180 degree", "screen direction", "axis", "disorientation", "crossing line", "spatial"],
  },
  {
    id: "cut-002",
    category: "cuts",
    title: "Cut on Action",
    content: "The most invisible cut is one made during movement. When a subject is in motion (walking, turning, reaching), cut in the middle of the action. The viewer's eye follows the motion and doesn't register the edit. Cut at the peak of movement for the smoothest result.",
    keywords: ["cut on action", "movement", "invisible cut", "motion", "smooth", "peak"],
  },
  {
    id: "cut-003",
    category: "cuts",
    title: "The 30-Degree Rule",
    content: "When cutting between two shots of the same subject, the camera angle should change by at least 30 degrees. Less than 30 degrees creates a jarring jump cut that distracts the viewer. Either change the angle significantly or change the shot size (wide to close-up).",
    keywords: ["30 degree", "jump cut", "camera angle", "shot size", "jarring", "same subject"],
  },
  {
    id: "cut-004",
    category: "cuts",
    title: "J-Cut and L-Cut",
    content: "In a J-cut, the audio from the next scene starts before the visual cut. In an L-cut, the audio from the current scene continues over the next visual. Both techniques create smoother transitions by letting audio bridge the visual change, making edits feel more natural and less abrupt.",
    keywords: ["j-cut", "l-cut", "audio bridge", "split edit", "natural", "smooth transition", "audio overlap"],
  },
  {
    id: "cut-005",
    category: "cuts",
    title: "Avoiding Dead Air",
    content: "Remove segments with dead air (silence, inactivity, repetition) unless they serve a dramatic purpose. Dead air kills momentum. Even 2-3 seconds of nothing happening can lose viewer attention. Common dead air: long pauses, 'um/uh' moments, repeated takes, setting up equipment on camera.",
    keywords: ["dead air", "silence", "pause", "boring", "momentum", "filler", "repetition", "um", "uh"],
  },
  {
    id: "cut-006",
    category: "cuts",
    title: "Match Cut Technique",
    content: "A match cut transitions between two scenes by matching visual elements — similar shapes, colors, movements, or compositions. The matching element draws the viewer's eye across the cut, creating a thematic connection between scenes. Works best for montages and highlight reels.",
    keywords: ["match cut", "visual match", "shapes", "composition", "montage", "thematic", "visual continuity"],
  },

  // ---- TRANSITIONS ----
  {
    id: "trans-001",
    category: "transitions",
    title: "Hard Cut is King",
    content: "Professional editors use hard cuts for 90-95% of all transitions. Hard cuts are invisible when done well — the viewer doesn't notice them. Soft transitions (dissolves, fades, wipes) should be reserved for specific storytelling purposes: passage of time, change of location, or emotional shift. Overusing soft transitions screams amateur.",
    keywords: ["hard cut", "professional", "dissolve", "fade", "wipe", "amateur", "overuse", "invisible"],
  },
  {
    id: "trans-002",
    category: "transitions",
    title: "When to Use Dissolve",
    content: "A dissolve (cross-fade) indicates the passage of time or a gentle shift between related scenes. Use dissolves when: (1) time passes between shots, (2) moving between related but distinct scenes, (3) creating a dreamy or reflective mood. Duration: 0.5-1.0 seconds. Never use dissolves between shots in the same scene — it looks like a mistake.",
    keywords: ["dissolve", "cross-fade", "passage of time", "mood", "reflective", "duration", "same scene"],
  },
  {
    id: "trans-003",
    category: "transitions",
    title: "Fade to Black",
    content: "Fade to black (dip to black) signals a major break: end of a chapter, significant time jump, or emotional reset. Use sparingly — it's the strongest transition signal besides a title card. Duration: 0.5-1.5 seconds. A fade to black in the middle of fast-paced content kills momentum.",
    keywords: ["fade to black", "dip to black", "chapter", "time jump", "emotional reset", "strong signal", "momentum"],
  },
  {
    id: "trans-004",
    category: "transitions",
    title: "Transition Duration Guidelines",
    content: "Transition durations should match the pacing of the edit. Fast-paced content: 0.25-0.5s transitions. Medium-paced: 0.5-1.0s. Slow/cinematic: 1.0-2.0s. The transition should never be longer than the shortest adjacent clip. If a segment is 2 seconds, a 1.5s dissolve eats 75% of it — use a hard cut instead.",
    keywords: ["transition duration", "pacing", "fast", "slow", "cinematic", "clip length", "timing"],
  },

  // ---- PACING ----
  {
    id: "pace-001",
    category: "pacing",
    title: "The Three-Act Structure for Highlights",
    content: "Even short highlight reels benefit from structure. Act 1 (Hook): Start with the most visually striking or emotionally engaging moment — you have 3 seconds to grab attention. Act 2 (Build): Present content in escalating intensity. Act 3 (Payoff): End with the strongest moment or a satisfying conclusion. Don't end with a whimper.",
    keywords: ["three act", "hook", "build", "payoff", "structure", "highlight", "attention", "escalating"],
  },
  {
    id: "pace-002",
    category: "pacing",
    title: "Pacing by Content Type",
    content: "Action/Sports: 8-20 cuts/min, segments 1.5-5s. Vlogs: 3-6 cuts/min, segments 5-15s. Tutorials: 2-4 cuts/min, segments 8-20s. Music videos: 6-12 cuts/min, beat-synced. Narrative: 4-8 cuts/min, emotion-driven. The pacing should feel natural for the content — forcing action-movie pacing on a tutorial makes it unwatchable.",
    keywords: ["pacing", "cuts per minute", "action", "sports", "vlog", "tutorial", "music", "narrative", "content type"],
  },
  {
    id: "pace-003",
    category: "pacing",
    title: "The 60-40 Rule for Highlight Reels",
    content: "A good highlight reel keeps 30-60% of the original content. Less than 30% loses context and feels disjointed. More than 60% isn't really a highlight — it's a slightly shorter version. Sweet spot: 40-50% for most content. Short videos (<30s) can go up to 70%. Long videos (>5min) should aim for 30-40%.",
    keywords: ["highlight reel", "duration", "keep ratio", "30 percent", "60 percent", "context", "sweet spot"],
  },
  {
    id: "pace-004",
    category: "pacing",
    title: "Rhythm and Breathing Room",
    content: "Good editing has rhythm — alternating between tension and release. Don't maintain the same intensity throughout. After a burst of fast cuts, include a longer establishing shot. After an emotional peak, give the viewer a beat to process. This push-pull rhythm keeps viewers engaged longer than constant high-energy cutting.",
    keywords: ["rhythm", "breathing room", "tension", "release", "intensity", "establishing shot", "emotional peak", "engagement"],
  },

  // ---- NARRATIVE ----
  {
    id: "narr-001",
    category: "narrative",
    title: "Opening Hook Strategy",
    content: "The first 3 seconds determine if the viewer keeps watching. Best hooks: (1) The peak moment — show the climax first, then rewind. (2) A question — create curiosity. (3) Movement — motion captures attention. (4) Contrast — something unexpected. NEVER start with a static wide shot, logos, or 'Hey guys, welcome to my channel.'",
    keywords: ["hook", "opening", "first 3 seconds", "attention", "climax", "curiosity", "movement", "contrast"],
  },
  {
    id: "narr-002",
    category: "narrative",
    title: "Segment Ordering for Engagement",
    content: "For highlight reels without a natural chronological narrative: Start strong (hook), then alternate between high and medium energy segments. Place your second-best moment at the end (recency bias). Never put two similar segments back-to-back — vary shot type, angle, or subject. The last impression is almost as important as the first.",
    keywords: ["ordering", "engagement", "strong opening", "recency bias", "vary", "last impression", "similar segments"],
  },
  {
    id: "narr-003",
    category: "narrative",
    title: "Continuity Between Segments",
    content: "When rearranging segments from a longer video, watch for continuity breaks: (1) Lighting changes (indoor → outdoor). (2) Wardrobe changes. (3) Location jumps. (4) Audio environment shifts (quiet → noisy). Flag these as needing soft transitions or bridging shots. A hard cut across a major continuity break is jarring.",
    keywords: ["continuity", "lighting", "wardrobe", "location", "audio", "jarring", "bridge", "soft transition"],
  },

  // ---- TECHNICAL ----
  {
    id: "tech-001",
    category: "technical",
    title: "Resolution and Aspect Ratio Preservation",
    content: "NEVER change the resolution or aspect ratio of source footage unless explicitly required. Stretching, squeezing, or cropping destroys visual quality and looks unprofessional. If mixing sources with different aspect ratios, use letterboxing (black bars) rather than stretching. The output resolution must match the source.",
    keywords: ["resolution", "aspect ratio", "stretching", "cropping", "letterboxing", "quality", "preservation"],
  },
  {
    id: "tech-002",
    category: "technical",
    title: "Stream Copy vs Re-encode",
    content: "When only making cuts (no transitions, effects, or resolution changes), use stream copy (-c copy) to avoid quality loss and speed up processing 10-50x. Only re-encode when necessary: soft transitions, codec incompatibility, or quality constraints. When re-encoding, match the source bitrate — don't guess with CRF alone.",
    keywords: ["stream copy", "re-encode", "quality loss", "codec", "bitrate", "crf", "speed", "processing"],
  },
  {
    id: "tech-003",
    category: "technical",
    title: "Frame-Accurate Cutting",
    content: "For frame-accurate cuts, use -ss before -i (input seeking) for speed, but be aware it seeks to the nearest keyframe. For exact frame precision, use -ss after -i (output seeking) — slower but exact. For stream copy, cuts must be on keyframes. For re-encoded cuts, any position is fine.",
    keywords: ["frame accurate", "keyframe", "seeking", "input seeking", "output seeking", "precision", "exact cut"],
  },
  {
    id: "tech-004",
    category: "technical",
    title: "Audio Considerations in Cuts",
    content: "Abrupt audio cuts are more noticeable than video cuts. Apply a 10-50ms audio fade at each cut point to prevent pops and clicks. For music-based content, cut on beats. For speech, cut at natural pauses — never mid-word. Audio crossfade (0.3-0.5s) at soft transitions prevents jarring audio jumps.",
    keywords: ["audio", "pop", "click", "fade", "crossfade", "beat", "speech", "pause", "mid-word"],
  },
  {
    id: "tech-005",
    category: "technical",
    title: "Codec Compatibility",
    content: "H.264 with yuv420p is the universal safe codec — plays on every device and platform. HEVC (H.265) has better compression but limited browser/device support. VP9 and AV1 are web-focused. When outputting highlights, always encode to H.264 yuv420p for maximum compatibility unless the user specifies otherwise.",
    keywords: ["codec", "h264", "h265", "hevc", "vp9", "av1", "compatibility", "yuv420p", "universal"],
  },
];

// ---------------------------------------------------------------------------
// Search function (RAG retrieval)
// ---------------------------------------------------------------------------

/**
 * Search the knowledge base using keyword matching.
 * Returns relevant entries ranked by match score.
 *
 * @param {string} query - Search query
 * @param {string} category - Category filter (or "all")
 * @returns {object} Search results with entries and context
 */
function searchKnowledge(query, category = "all") {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (!queryTerms.length) return { results: [], context: "" };

  let entries = KNOWLEDGE_BASE;
  if (category !== "all") {
    entries = entries.filter(e => e.category === category);
  }

  const scored = entries.map(entry => {
    let score = 0;
    const searchText = `${entry.title} ${entry.content} ${entry.keywords.join(" ")}`.toLowerCase();

    for (const term of queryTerms) {
      // Exact keyword match (highest weight)
      if (entry.keywords.some(k => k.includes(term))) score += 3;
      // Title match
      if (entry.title.toLowerCase().includes(term)) score += 2;
      // Content match
      if (entry.content.toLowerCase().includes(term)) score += 1;
    }

    return { ...entry, score };
  });

  const results = scored
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Build RAG context string for injection into prompts
  const context = results.map(r => `[${r.title}]: ${r.content}`).join("\n\n");

  return {
    results: results.map(r => ({
      id: r.id,
      title: r.title,
      content: r.content,
      category: r.category,
      relevance: r.score,
    })),
    context,
    query,
    total_entries: entries.length,
  };
}

/**
 * Get RAG context for a specific editing task.
 * Combines multiple queries to build comprehensive context.
 *
 * @param {string} task - The editing task description
 * @param {object} videoMeta - Video metadata
 * @returns {string} Context string to inject into agent prompts
 */
function getEditingContext(task, videoMeta = {}) {
  const queries = [task];

  // Add contextual queries based on video characteristics
  if (videoMeta.duration) {
    if (videoMeta.duration < 15) queries.push("short video editing pacing");
    else if (videoMeta.duration > 120) queries.push("long video highlight reel pacing");
    queries.push("highlight reel duration ratio");
  }

  const allResults = [];
  const seen = new Set();
  for (const q of queries) {
    const { results } = searchKnowledge(q);
    for (const r of results) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        allResults.push(r);
      }
    }
  }

  if (!allResults.length) return "";

  return "\n\n--- VIDEO EDITING KNOWLEDGE BASE ---\n" +
    allResults.slice(0, 6).map(r => `[${r.title}]: ${r.content}`).join("\n\n") +
    "\n--- END KNOWLEDGE BASE ---\n";
}

module.exports = { searchKnowledge, getEditingContext, KNOWLEDGE_BASE };
