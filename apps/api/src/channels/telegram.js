/**
 * Telegram channel adapter
 *
 * Supports both Bot API (≤20MB) and MTProto (unlimited) downloads.
 * Handles video messages and video documents.
 *
 * Env: TELEGRAM_BOT_TOKEN (required)
 *      TELEGRAM_API_ID, TELEGRAM_API_HASH (optional — needed for >20MB files)
 */

const { Bot, InputFile } = require("grammy");
const fs = require("fs");
const { BaseChannel, processVideo, cleanup, tmpFile } = require("./base");

const MAX_BOT_API_DOWNLOAD = 20 * 1024 * 1024;
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

class TelegramChannel extends BaseChannel {
  constructor() {
    super();
    this.name = "Telegram";
    this.envKeys = ["TELEGRAM_BOT_TOKEN"];
    this.maxUpload = MAX_UPLOAD_SIZE;
    this.bot = null;
    this.mtClient = null;
    this._token = null;
  }

  async start() {
    const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const apiId = parseInt(process.env.TELEGRAM_API_ID) || 0;
    const apiHash = process.env.TELEGRAM_API_HASH || "";

    this._token = TOKEN;
    this.bot = new Bot(TOKEN);

    this.bot.command("start", (ctx) => {
      ctx.reply("Send me a video and I'll auto-edit the highlights for you!");
    });

    this.bot.on("message:video", (ctx) => this._handleVideo(ctx.message, ctx.message.video));
    this.bot.on("message:document", (ctx) => {
      const doc = ctx.message.document;
      if (!doc || !doc.mime_type?.startsWith("video/")) return;
      this._handleVideo(ctx.message, doc);
    });

    // Start polling in background (does not block)
    this.bot.start().catch((err) => console.error("[Telegram] Bot error:", err));

    console.log("Telegram bot started, waiting for videos...");
    if (apiId && apiHash) {
      console.log("  MTProto enabled – large file downloads supported (>20MB)");
    } else {
      console.log("  MTProto disabled – max download 20MB. Set TELEGRAM_API_ID + TELEGRAM_API_HASH for large files");
    }
  }

  async stop() {
    if (this.bot) { try { await this.bot.stop(); } catch {} }
    if (this.mtClient) { try { await this.mtClient.disconnect(); } catch {} }
  }

  async _getMTClient() {
    if (this.mtClient) return this.mtClient;
    const apiId = parseInt(process.env.TELEGRAM_API_ID) || 0;
    const apiHash = process.env.TELEGRAM_API_HASH || "";
    if (!apiId || !apiHash) return null;

    const { TelegramClient } = require("telegram");
    const { StringSession } = require("telegram/sessions");
    this.mtClient = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
    await this.mtClient.start({ botAuthToken: process.env.TELEGRAM_BOT_TOKEN });
    console.log("[MTProto] Client connected for large file downloads");
    return this.mtClient;
  }

  async _downloadFile(fileId, fileSize, chatId, messageId, destPath) {
    if (fileSize && fileSize > MAX_BOT_API_DOWNLOAD) {
      return this._downloadViaMTProto(chatId, messageId, destPath, fileSize);
    }
    try {
      const file = await this.bot.api.getFile(fileId);
      const url = `https://api.telegram.org/file/bot${this._token}/${file.file_path}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      fs.writeFileSync(destPath, Buffer.from(await resp.arrayBuffer()));
    } catch (err) {
      if (err.message?.includes("file is too big")) {
        return this._downloadViaMTProto(chatId, messageId, destPath, fileSize);
      }
      throw err;
    }
  }

  async _downloadViaMTProto(chatId, messageId, destPath, fileSize) {
    const client = await this._getMTClient();
    if (!client) {
      throw new Error("File is >20MB. Set TELEGRAM_API_ID and TELEGRAM_API_HASH for large file support.");
    }
    const sizeMB = fileSize ? `${(fileSize / (1024 * 1024)).toFixed(1)}MB` : "unknown";
    console.log(`[MTProto] Downloading large file (${sizeMB})...`);
    const messages = await client.getMessages(chatId, { ids: [messageId] });
    if (!messages?.[0]) throw new Error("Could not retrieve message via MTProto");
    const buffer = await client.downloadMedia(messages[0]);
    fs.writeFileSync(destPath, buffer);
  }

  async _handleVideo(msg, media) {
    const chatId = msg.chat.id;
    const statusMsg = await this.bot.api.sendMessage(chatId, "Downloading video...");
    const tmpIn = tmpFile("mp4");

    try {
      await this._downloadFile(media.file_id, media.file_size, chatId, msg.message_id, tmpIn);
      const name = media.file_name?.replace(/\.[^/.]+$/, "") || "video";

      const result = await processVideo(tmpIn, name, this.maxUpload, (text) => {
        this.bot.api.editMessageText(chatId, statusMsg.message_id, text).catch(() => {});
      });

      const compNote = result.compressed ? " (compressed for Telegram)" : "";
      await this.bot.api.editMessageText(
        chatId,
        statusMsg.message_id,
        `Done! ${result.segCount} highlights found${compNote}.\n${result.summary}`
      );

      const caption = result.summary ? `AI Edit: ${result.summary}` : "Here's your highlight reel!";
      try {
        await this.bot.api.sendVideo(chatId, new InputFile(result.outputPath), {
          caption,
          width: result.width || undefined,
          height: result.height || undefined,
          duration: result.duration || undefined,
          supports_streaming: true,
        });
      } catch {
        await this.bot.api.sendDocument(chatId, new InputFile(result.outputPath), {
          caption,
          filename: `${name}_edited.mp4`,
        });
      }

      cleanup(tmpIn, result._tmpOut, result._tmpCompressed);
    } catch (err) {
      console.error("[Telegram] Error:", err);
      await this.bot.api.editMessageText(chatId, statusMsg.message_id, `Error: ${err.message}`).catch(() => {});
      cleanup(tmpIn);
    }
  }
}

module.exports = TelegramChannel;
