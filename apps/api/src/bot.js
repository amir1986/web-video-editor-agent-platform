const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const WSL_DISTRO = process.env.WSL_DISTRO || "Ubuntu-24.04";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN environment variable");
  process.exit(1);
}

const API_URL = process.env.API_URL || "http://localhost:3001";
const TG_API_ID = parseInt(process.env.TELEGRAM_API_ID) || 0;
const TG_API_HASH = process.env.TELEGRAM_API_HASH || "";

// Telegram Bot API limits
const MAX_BOT_API_DOWNLOAD = 20 * 1024 * 1024; // 20MB - getFile limit
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;       // 50MB - sendVideo/sendDocument limit

const bot = new TelegramBot(TOKEN, { polling: true });

// --- ffmpeg helpers (for compressing output to fit Telegram's 50MB upload limit) ---
function toWslPath(p) {
  if (process.platform === "win32") {
    return p.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
  }
  return p;
}

function ffmpegExec(args) {
  return new Promise((resolve, reject) => {
    const [cmd, fullArgs] = process.platform === "win32"
      ? ["wsl", ["-d", WSL_DISTRO, "--", "ffmpeg", ...args]]
      : ["ffmpeg", args];
    execFile(cmd, fullArgs, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
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

/**
 * Compress video to fit within maxBytes using ffmpeg.
 * Only used for Telegram's 50MB upload limit - other platforms are not limited.
 * Preserves: original resolution, aspect ratio, rotation, frame rate.
 */
async function compressForTelegram(inputPath, outputPath, maxBytes) {
  const wslIn = toWslPath(inputPath);
  const wslOut = toWslPath(outputPath);

  const durationStr = await ffprobeExec(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wslIn]);
  const duration = parseFloat(durationStr);
  if (!duration || duration <= 0) {
    throw new Error("Could not determine video duration for compression");
  }

  // Target with 5% safety margin
  const targetBytes = maxBytes * 0.95;
  const audioBitrate = 128 * 1024; // 128kbps
  const totalBitrate = (targetBytes * 8) / duration;
  const videoBitrate = Math.floor(totalBitrate - audioBitrate);

  if (videoBitrate < 100 * 1024) {
    throw new Error("Video too long to compress under 50MB with acceptable quality");
  }

  const vbr = Math.floor(videoBitrate / 1000) + "k";
  const bufsize = Math.floor((videoBitrate * 2) / 1000) + "k";
  console.log(`[COMPRESS] duration=${duration.toFixed(1)}s, target=${(targetBytes / 1024 / 1024).toFixed(1)}MB, vbr=${vbr}`);

  // -map_metadata 0: preserve all metadata (rotation, etc.)
  // -movflags +faststart: optimize for streaming
  // No scale filter: preserves original resolution and aspect ratio exactly
  await ffmpegExec(["-y", "-i", wslIn, "-c:v", "libx264", "-b:v", vbr, "-maxrate", vbr, "-bufsize", bufsize, "-c:a", "aac", "-b:a", "128k", "-preset", "medium", "-map_metadata", "0", "-movflags", "+faststart", wslOut]);

  // Check if output fits; if still too large, retry with proportionally lower bitrate
  const outSize = fs.statSync(outputPath).size;
  console.log(`[COMPRESS] First pass output: ${(outSize / 1024 / 1024).toFixed(1)}MB`);

  if (outSize > maxBytes) {
    const ratio = targetBytes / outSize;
    const adjustedVbr = Math.floor((videoBitrate * ratio) / 1000) + "k";
    const adjustedBuf = Math.floor((videoBitrate * ratio * 2) / 1000) + "k";
    console.log(`[COMPRESS] Still too large, retrying with vbr=${adjustedVbr}`);
    await ffmpegExec(["-y", "-i", wslIn, "-c:v", "libx264", "-b:v", adjustedVbr, "-maxrate", adjustedVbr, "-bufsize", adjustedBuf, "-c:a", "aac", "-b:a", "128k", "-preset", "medium", "-map_metadata", "0", "-movflags", "+faststart", wslOut]);
    const finalSize = fs.statSync(outputPath).size;
    console.log(`[COMPRESS] Second pass output: ${(finalSize / 1024 / 1024).toFixed(1)}MB`);
  }
}

// --- MTProto client for large file downloads (bypasses 20MB limit) ---
let mtClient = null;

async function getMTClient() {
  if (mtClient) return mtClient;
  if (!TG_API_ID || !TG_API_HASH) return null;

  mtClient = new TelegramClient(new StringSession(""), TG_API_ID, TG_API_HASH, {
    connectionRetries: 5,
  });
  await mtClient.start({ botAuthToken: TOKEN });
  console.log("[MTProto] Client connected for large file downloads");
  return mtClient;
}

/**
 * Download via MTProto (gramjs) – no file size limit.
 */
async function downloadViaMTProto(chatId, messageId, destPath, fileSize) {
  const client = await getMTClient();
  if (!client) {
    throw new Error(
      "הקובץ גדול מ-20MB. כדי לאפשר הורדת קבצים גדולים הגדר TELEGRAM_API_ID ו-TELEGRAM_API_HASH.\n" +
      "ניתן לקבל אותם מ: https://my.telegram.org"
    );
  }

  const sizeMB = fileSize ? `${(fileSize / (1024 * 1024)).toFixed(1)}MB` : "unknown size";
  console.log(`[MTProto] Downloading large file (${sizeMB})...`);
  const messages = await client.getMessages(chatId, { ids: [messageId] });
  if (!messages || !messages[0]) {
    throw new Error("Could not retrieve message via MTProto");
  }
  const buffer = await client.downloadMedia(messages[0]);
  fs.writeFileSync(destPath, buffer);
  console.log(`[MTProto] Download complete: ${destPath}`);
}

/**
 * Download a file from Telegram.
 * - If file_size is known and > 20MB → go straight to MTProto.
 * - Otherwise try Bot API first; if it fails with "file is too big" → fallback to MTProto.
 */
async function downloadTelegramFile(fileId, fileSize, chatId, messageId, destPath) {
  const sizeMB = fileSize ? (fileSize / (1024 * 1024)).toFixed(1) : "unknown";
  console.log(`[DOWNLOAD] fileId=${fileId}, fileSize=${fileSize} (${sizeMB}MB), chatId=${chatId}, msgId=${messageId}`);
  console.log(`[DOWNLOAD] MAX_BOT_API_DOWNLOAD=${MAX_BOT_API_DOWNLOAD}, isLarge=${fileSize && fileSize > MAX_BOT_API_DOWNLOAD}`);

  // If we already know it's large, skip Bot API entirely
  if (fileSize && fileSize > MAX_BOT_API_DOWNLOAD) {
    console.log("[DOWNLOAD] File size known & > 20MB → using MTProto directly");
    return downloadViaMTProto(chatId, messageId, destPath, fileSize);
  }

  // Try standard Bot API (fast, works for ≤20MB)
  console.log("[DOWNLOAD] Trying Bot API download...");
  try {
    const filePath = await bot.downloadFile(fileId, os.tmpdir());
    console.log(`[DOWNLOAD] Bot API success: ${filePath}`);
    fs.renameSync(filePath, destPath);
    return;
  } catch (err) {
    console.log(`[DOWNLOAD] Bot API failed: ${err.message}`);
    // If Bot API says "file is too big", fallback to MTProto
    if (err.message && err.message.includes("file is too big")) {
      console.log("[DOWNLOAD] Falling back to MTProto...");
      return downloadViaMTProto(chatId, messageId, destPath, fileSize);
    }
    throw err;
  }
}

console.log("Telegram bot started, waiting for videos...");
if (TG_API_ID && TG_API_HASH) {
  console.log("  MTProto enabled – large file downloads supported (>20MB)");
} else {
  console.log("  MTProto disabled – max download 20MB. Set TELEGRAM_API_ID + TELEGRAM_API_HASH for large files");
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Send me a video and I'll auto-edit the highlights for you!");
});

bot.on("video", async (msg) => {
  const chatId = msg.chat.id;
  const video = msg.video;

  if (!video) return;

  console.log(`[VIDEO] Received video: file_id=${video.file_id}, file_size=${video.file_size}, file_unique_id=${video.file_unique_id}`);
  console.log(`[VIDEO] file_size type: ${typeof video.file_size}, value: ${JSON.stringify(video.file_size)}`);

  const statusMsg = await bot.sendMessage(chatId, "Downloading video...");
  const tmpIn = path.join(os.tmpdir(), `tg_${crypto.randomBytes(6).toString("hex")}.mp4`);
  const tmpOut = path.join(os.tmpdir(), `tg_out_${crypto.randomBytes(6).toString("hex")}.mp4`);
  const tmpCompressed = path.join(os.tmpdir(), `tg_comp_${crypto.randomBytes(6).toString("hex")}.mp4`);

  try {
    // Download video from Telegram (auto-selects Bot API or MTProto based on size)
    await downloadTelegramFile(video.file_id, video.file_size, chatId, msg.message_id, tmpIn);
    const inputSize = fs.statSync(tmpIn).size;
    console.log(`[VIDEO] Downloaded: ${(inputSize / 1024 / 1024).toFixed(1)}MB → ${tmpIn}`);

    await bot.editMessageText("Processing with AI... this may take a minute.", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
    });

    // Send to the auto-edit API
    const videoBuffer = fs.readFileSync(tmpIn);
    const name = msg.video.file_name?.replace(/\.[^/.]+$/, "") || "video";

    console.log(`[VIDEO] Sending to API: ${API_URL}/api/auto-edit, size=${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB`);
    const apiStart = Date.now();
    const fetchCtrl = new AbortController();
    const fetchTimeout = setTimeout(() => fetchCtrl.abort(), 10 * 60 * 1000); // 10 min
    const res = await fetch(`${API_URL}/api/auto-edit?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "video/mp4" },
      body: videoBuffer,
      signal: fetchCtrl.signal,
    });
    clearTimeout(fetchTimeout);

    const apiElapsed = ((Date.now() - apiStart) / 1000).toFixed(1);
    console.log(`[VIDEO] API response: status=${res.status} in ${apiElapsed}s`);
    if (!res.ok) {
      const err = await res.text();
      console.log(`[VIDEO] API error body: ${err}`);
      throw new Error(`API error ${res.status}: ${err}`);
    }

    // Save result
    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(tmpOut, Buffer.from(arrayBuffer));

    const summary = res.headers.get("x-ai-summary") || "";
    const segCount = res.headers.get("x-segments-count") || "?";
    const videoWidth = parseInt(res.headers.get("x-video-width")) || undefined;
    const videoHeight = parseInt(res.headers.get("x-video-height")) || undefined;
    const videoDuration = parseInt(res.headers.get("x-video-duration")) || undefined;

    // Compress if needed (Telegram-only 50MB limit) and send
    let fileToSend = tmpOut;
    let compressed = false;
    const outSize = fs.statSync(tmpOut).size;
    console.log(`[VIDEO] API output: ${(outSize / 1024 / 1024).toFixed(1)}MB, segments=${segCount}, input was ${(inputSize / 1024 / 1024).toFixed(1)}MB`);

    if (outSize > MAX_UPLOAD_SIZE) {
      const outMB = (outSize / (1024 * 1024)).toFixed(1);
      console.log(`[VIDEO] Output ${outMB}MB > 50MB limit, compressing for Telegram...`);
      await bot.editMessageText(
        `Compressing video (${outMB}MB) to fit Telegram's 50MB limit...`,
        { chat_id: chatId, message_id: statusMsg.message_id }
      );
      await compressForTelegram(tmpOut, tmpCompressed, MAX_UPLOAD_SIZE);
      const compSize = fs.statSync(tmpCompressed).size;
      console.log(`[VIDEO] Compressed: ${(compSize / 1024 / 1024).toFixed(1)}MB (from ${outMB}MB)`);
      fileToSend = tmpCompressed;
      compressed = true;
    }

    const sendSize = fs.statSync(fileToSend).size;
    console.log(`[VIDEO] Sending to Telegram: ${(sendSize / 1024 / 1024).toFixed(1)}MB, compressed=${compressed}`);
    const compNote = compressed ? " (compressed for Telegram)" : "";
    await bot.editMessageText(
      `Done! ${segCount} highlights found${compNote}.\n${summary}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    );

    const caption = summary ? `AI Edit: ${summary}` : "Here's your highlight reel!";
    try {
      await bot.sendVideo(chatId, fileToSend, { caption, width: videoWidth, height: videoHeight, duration: videoDuration, supports_streaming: true });
      console.log(`[VIDEO] sendVideo OK`);
    } catch (sendErr) {
      console.log(`[VIDEO] sendVideo failed (${sendErr.message}), falling back to sendDocument`);
      await bot.sendDocument(chatId, fileToSend, { caption }, { filename: `${name}_edited.mp4`, contentType: "video/mp4" });
      console.log(`[VIDEO] sendDocument OK`);
    }
  } catch (err) {
    console.error("[VIDEO] Bot error:", err);
    await bot.editMessageText(
      `Error: ${err.message}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    ).catch(() => {});
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
    try { fs.unlinkSync(tmpCompressed); } catch {}
  }
});

// Graceful shutdown — disconnect MTProto client
async function shutdown() {
  if (mtClient) { try { await mtClient.disconnect(); } catch {} }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Also handle video sent as document (for large files)
bot.on("document", async (msg) => {
  const doc = msg.document;
  if (!doc || !doc.mime_type?.startsWith("video/")) return;

  console.log(`[DOC] Received document: file_id=${doc.file_id}, file_size=${doc.file_size}, mime=${doc.mime_type}`);
  console.log(`[DOC] file_size type: ${typeof doc.file_size}, value: ${JSON.stringify(doc.file_size)}`);

  const chatId = msg.chat.id;

  const statusMsg = await bot.sendMessage(chatId, "Downloading video...");
  const tmpIn = path.join(os.tmpdir(), `tg_${crypto.randomBytes(6).toString("hex")}.mp4`);
  const tmpOut = path.join(os.tmpdir(), `tg_out_${crypto.randomBytes(6).toString("hex")}.mp4`);
  const tmpCompressed = path.join(os.tmpdir(), `tg_comp_${crypto.randomBytes(6).toString("hex")}.mp4`);

  try {
    await downloadTelegramFile(doc.file_id, doc.file_size, chatId, msg.message_id, tmpIn);
    const inputSize = fs.statSync(tmpIn).size;
    console.log(`[DOC] Downloaded: ${(inputSize / 1024 / 1024).toFixed(1)}MB → ${tmpIn}`);

    await bot.editMessageText("Processing with AI... this may take a minute.", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
    });

    const videoBuffer = fs.readFileSync(tmpIn);
    const name = doc.file_name?.replace(/\.[^/.]+$/, "") || "video";

    console.log(`[DOC] Sending to API: ${API_URL}/api/auto-edit, size=${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB`);
    const apiStart = Date.now();
    const fetchCtrl2 = new AbortController();
    const fetchTimeout2 = setTimeout(() => fetchCtrl2.abort(), 10 * 60 * 1000); // 10 min
    const res = await fetch(`${API_URL}/api/auto-edit?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "video/mp4" },
      body: videoBuffer,
      signal: fetchCtrl2.signal,
    });
    clearTimeout(fetchTimeout2);

    const apiElapsed = ((Date.now() - apiStart) / 1000).toFixed(1);
    console.log(`[DOC] API response: status=${res.status} in ${apiElapsed}s`);
    if (!res.ok) {
      const err = await res.text();
      console.log(`[DOC] API error body: ${err}`);
      throw new Error(`API error ${res.status}: ${err}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(tmpOut, Buffer.from(arrayBuffer));

    const summary = res.headers.get("x-ai-summary") || "";
    const segCount = res.headers.get("x-segments-count") || "?";
    const videoWidth = parseInt(res.headers.get("x-video-width")) || undefined;
    const videoHeight = parseInt(res.headers.get("x-video-height")) || undefined;
    const videoDuration = parseInt(res.headers.get("x-video-duration")) || undefined;

    // Compress if needed (Telegram-only 50MB limit) and send
    let fileToSend = tmpOut;
    let compressed = false;
    const outSize = fs.statSync(tmpOut).size;
    console.log(`[DOC] API output: ${(outSize / 1024 / 1024).toFixed(1)}MB, segments=${segCount}, input was ${(inputSize / 1024 / 1024).toFixed(1)}MB`);

    if (outSize > MAX_UPLOAD_SIZE) {
      const outMB = (outSize / (1024 * 1024)).toFixed(1);
      console.log(`[DOC] Output ${outMB}MB > 50MB limit, compressing for Telegram...`);
      await bot.editMessageText(
        `Compressing video (${outMB}MB) to fit Telegram's 50MB limit...`,
        { chat_id: chatId, message_id: statusMsg.message_id }
      );
      await compressForTelegram(tmpOut, tmpCompressed, MAX_UPLOAD_SIZE);
      const compSize = fs.statSync(tmpCompressed).size;
      console.log(`[DOC] Compressed: ${(compSize / 1024 / 1024).toFixed(1)}MB (from ${outMB}MB)`);
      fileToSend = tmpCompressed;
      compressed = true;
    }

    const sendSize = fs.statSync(fileToSend).size;
    console.log(`[DOC] Sending to Telegram: ${(sendSize / 1024 / 1024).toFixed(1)}MB, compressed=${compressed}`);
    const compNote = compressed ? " (compressed for Telegram)" : "";
    await bot.editMessageText(
      `Done! ${segCount} highlights found${compNote}.\n${summary}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    );

    const caption = summary ? `AI Edit: ${summary}` : "Here's your highlight reel!";
    try {
      await bot.sendVideo(chatId, fileToSend, { caption, width: videoWidth, height: videoHeight, duration: videoDuration, supports_streaming: true });
      console.log(`[DOC] sendVideo OK`);
    } catch (sendErr) {
      console.log(`[DOC] sendVideo failed (${sendErr.message}), falling back to sendDocument`);
      await bot.sendDocument(chatId, fileToSend, { caption }, { filename: `${name}_edited.mp4`, contentType: "video/mp4" });
      console.log(`[DOC] sendDocument OK`);
    }
  } catch (err) {
    console.error("[DOC] Bot error:", err);
    await bot.editMessageText(
      `Error: ${err.message}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    ).catch(() => {});
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
    try { fs.unlinkSync(tmpCompressed); } catch {}
  }
});
