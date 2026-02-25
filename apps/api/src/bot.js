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

const bot = new TelegramBot(TOKEN, { polling: true });

console.log("Telegram bot started, waiting for videos...");

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

    const res = await fetch(`${API_URL}/api/auto-edit?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "video/mp4" },
      body: videoBuffer,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API error ${res.status}: ${err}`);
    }

    // Save result
    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(tmpOut, Buffer.from(arrayBuffer));

    const summary = res.headers.get("x-ai-summary") || "";
    const segCount = res.headers.get("x-segments-count") || "?";

    await bot.editMessageText(
      `Done! ${segCount} highlights found.\n${summary}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    );

    // Send edited video back
    await bot.sendVideo(chatId, tmpOut, {
      caption: summary ? `AI Edit: ${summary}` : "Here's your highlight reel!",
    });
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
    const filePath = await bot.downloadFile(doc.file_id, os.tmpdir());
    fs.renameSync(filePath, tmpIn);

    await bot.editMessageText("Processing with AI... this may take a minute.", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
    });

    const videoBuffer = fs.readFileSync(tmpIn);
    const name = doc.file_name?.replace(/\.[^/.]+$/, "") || "video";

    const res = await fetch(`${API_URL}/api/auto-edit?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "video/mp4" },
      body: videoBuffer,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API error ${res.status}: ${err}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(tmpOut, Buffer.from(arrayBuffer));

    const summary = res.headers.get("x-ai-summary") || "";
    const segCount = res.headers.get("x-segments-count") || "?";

    await bot.editMessageText(
      `Done! ${segCount} highlights found.\n${summary}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    );

    await bot.sendVideo(chatId, tmpOut, {
      caption: summary ? `AI Edit: ${summary}` : "Here's your highlight reel!",
    });
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
