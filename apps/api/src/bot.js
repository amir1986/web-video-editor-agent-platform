const TelegramBot = require("node-telegram-bot-api");
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

// Telegram Bot API limits
const MAX_DOWNLOAD_SIZE = 20 * 1024 * 1024; // 20MB - getFile limit
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;   // 50MB - sendVideo/sendDocument limit

const bot = new TelegramBot(TOKEN, { polling: true });

console.log("Telegram bot started, waiting for videos...");

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Send me a video and I'll auto-edit the highlights for you!");
});

bot.on("video", async (msg) => {
  const chatId = msg.chat.id;
  const video = msg.video;

  if (!video) return;

  // Check file size before downloading (Telegram getFile limit is 20MB)
  if (video.file_size && video.file_size > MAX_DOWNLOAD_SIZE) {
    const sizeMB = (video.file_size / (1024 * 1024)).toFixed(1);
    await bot.sendMessage(chatId,
      `The video is too large (${sizeMB}MB). Telegram limits bot downloads to 20MB.\nPlease send a shorter or lower-resolution video.`
    );
    return;
  }

  const statusMsg = await bot.sendMessage(chatId, "Downloading video...");
  const tmpIn = path.join(os.tmpdir(), `tg_${crypto.randomBytes(6).toString("hex")}.mp4`);
  const tmpOut = path.join(os.tmpdir(), `tg_out_${crypto.randomBytes(6).toString("hex")}.mp4`);

  try {
    // Download video from Telegram
    const filePath = await bot.downloadFile(video.file_id, os.tmpdir());
    fs.renameSync(filePath, tmpIn);

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

  // Check file size before downloading (Telegram getFile limit is 20MB)
  if (doc.file_size && doc.file_size > MAX_DOWNLOAD_SIZE) {
    const sizeMB = (doc.file_size / (1024 * 1024)).toFixed(1);
    await bot.sendMessage(chatId,
      `The video is too large (${sizeMB}MB). Telegram limits bot downloads to 20MB.\nPlease send a shorter or lower-resolution video.`
    );
    return;
  }

  const statusMsg = await bot.sendMessage(chatId, "Downloading video...");
  const tmpIn = path.join(os.tmpdir(), `tg_${crypto.randomBytes(6).toString("hex")}.mp4`);
  const tmpOut = path.join(os.tmpdir(), `tg_out_${crypto.randomBytes(6).toString("hex")}.mp4`);

  try {
    const filePath = await bot.downloadFile(doc.file_id, os.tmpdir());
    fs.renameSync(filePath, tmpIn);

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
