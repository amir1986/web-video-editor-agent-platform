const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

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
  // If we already know it's large, skip Bot API entirely
  if (fileSize && fileSize > MAX_BOT_API_DOWNLOAD) {
    return downloadViaMTProto(chatId, messageId, destPath, fileSize);
  }

  // Try standard Bot API (fast, works for ≤20MB)
  try {
    const filePath = await bot.downloadFile(fileId, os.tmpdir());
    fs.renameSync(filePath, destPath);
    return;
  } catch (err) {
    // If Bot API says "file is too big", fallback to MTProto
    if (err.message && err.message.includes("file is too big")) {
      console.log("[Bot API] File too big for getFile, falling back to MTProto...");
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

  const statusMsg = await bot.sendMessage(chatId, "Downloading video...");
  const tmpIn = path.join(os.tmpdir(), `tg_${crypto.randomBytes(6).toString("hex")}.mp4`);
  const tmpOut = path.join(os.tmpdir(), `tg_out_${crypto.randomBytes(6).toString("hex")}.mp4`);

  try {
    // Download video from Telegram (auto-selects Bot API or MTProto based on size)
    await downloadTelegramFile(video.file_id, video.file_size, chatId, msg.message_id, tmpIn);

    await bot.editMessageText("Processing with AI... this may take a minute.", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
    });

    // Send to the auto-edit API
    const videoBuffer = fs.readFileSync(tmpIn);
    const name = msg.video.file_name?.replace(/\.[^/.]+$/, "") || "video";

    console.log(`[DEBUG] Sending to API: ${API_URL}/api/auto-edit, video size: ${videoBuffer.length} bytes`);
    const res = await fetch(`${API_URL}/api/auto-edit?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "video/mp4" },
      body: videoBuffer,
    });

    console.log(`[DEBUG] API response status: ${res.status}`);
    if (!res.ok) {
      const err = await res.text();
      console.log(`[DEBUG] API error body: ${err}`);
      throw new Error(`API error ${res.status}: ${err}`);
    }

    // Save result
    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(tmpOut, Buffer.from(arrayBuffer));

    const summary = res.headers.get("x-ai-summary") || "";
    const segCount = res.headers.get("x-segments-count") || "?";

    // Check output file size before sending
    const outSize = fs.statSync(tmpOut).size;

    if (outSize > MAX_UPLOAD_SIZE) {
      const outMB = (outSize / (1024 * 1024)).toFixed(1);
      await bot.editMessageText(
        `Done! ${segCount} highlights found, but the output (${outMB}MB) exceeds Telegram's 50MB limit.\n${summary}`,
        { chat_id: chatId, message_id: statusMsg.message_id }
      );
      return;
    }

    await bot.editMessageText(
      `Done! ${segCount} highlights found.\n${summary}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    );

    // Send edited video back; fall back to document if sendVideo fails
    const caption = summary ? `AI Edit: ${summary}` : "Here's your highlight reel!";
    try {
      await bot.sendVideo(chatId, tmpOut, { caption });
    } catch (sendErr) {
      console.log(`[DEBUG] sendVideo failed (${sendErr.message}), falling back to sendDocument`);
      await bot.sendDocument(chatId, tmpOut, { caption }, { filename: `${name}_edited.mp4`, contentType: "video/mp4" });
    }
  } catch (err) {
    console.error("Bot error:", err);
    await bot.editMessageText(
      `Error: ${err.message}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    ).catch(() => {});
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
});

// Also handle video sent as document (for large files)
bot.on("document", async (msg) => {
  const doc = msg.document;
  if (!doc || !doc.mime_type?.startsWith("video/")) return;

  const chatId = msg.chat.id;

  const statusMsg = await bot.sendMessage(chatId, "Downloading video...");
  const tmpIn = path.join(os.tmpdir(), `tg_${crypto.randomBytes(6).toString("hex")}.mp4`);
  const tmpOut = path.join(os.tmpdir(), `tg_out_${crypto.randomBytes(6).toString("hex")}.mp4`);

  try {
    // Download video from Telegram (auto-selects Bot API or MTProto based on size)
    await downloadTelegramFile(doc.file_id, doc.file_size, chatId, msg.message_id, tmpIn);

    await bot.editMessageText("Processing with AI... this may take a minute.", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
    });

    const videoBuffer = fs.readFileSync(tmpIn);
    const name = doc.file_name?.replace(/\.[^/.]+$/, "") || "video";

    console.log(`[DEBUG] Sending to API: ${API_URL}/api/auto-edit, video size: ${videoBuffer.length} bytes`);
    const res = await fetch(`${API_URL}/api/auto-edit?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "video/mp4" },
      body: videoBuffer,
    });

    console.log(`[DEBUG] API response status: ${res.status}`);
    if (!res.ok) {
      const err = await res.text();
      console.log(`[DEBUG] API error body: ${err}`);
      throw new Error(`API error ${res.status}: ${err}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(tmpOut, Buffer.from(arrayBuffer));

    const summary = res.headers.get("x-ai-summary") || "";
    const segCount = res.headers.get("x-segments-count") || "?";

    // Check output file size before sending
    const outSize = fs.statSync(tmpOut).size;

    if (outSize > MAX_UPLOAD_SIZE) {
      const outMB = (outSize / (1024 * 1024)).toFixed(1);
      await bot.editMessageText(
        `Done! ${segCount} highlights found, but the output (${outMB}MB) exceeds Telegram's 50MB limit.\n${summary}`,
        { chat_id: chatId, message_id: statusMsg.message_id }
      );
      return;
    }

    await bot.editMessageText(
      `Done! ${segCount} highlights found.\n${summary}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    );

    // Send edited video back; fall back to document if sendVideo fails
    const caption = summary ? `AI Edit: ${summary}` : "Here's your highlight reel!";
    try {
      await bot.sendVideo(chatId, tmpOut, { caption });
    } catch (sendErr) {
      console.log(`[DEBUG] sendVideo failed (${sendErr.message}), falling back to sendDocument`);
      await bot.sendDocument(chatId, tmpOut, { caption }, { filename: `${name}_edited.mp4`, contentType: "video/mp4" });
    }
  } catch (err) {
    console.error("Bot error:", err);
    await bot.editMessageText(
      `Error: ${err.message}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    ).catch(() => {});
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
});
