/**
 * Telegram channel adapter
 *
 * Supports both Bot API (≤20MB) and MTProto (unlimited) downloads.
 * Handles video messages and video documents.
 *
 * Env: TELEGRAM_BOT_TOKEN (required)
 *      TELEGRAM_API_ID, TELEGRAM_API_HASH (optional — needed for >20MB files)
 */

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
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
  }

  async start() {
    const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const apiId = parseInt(process.env.TELEGRAM_API_ID) || 0;
    const apiHash = process.env.TELEGRAM_API_HASH || "";

    this.bot = new TelegramBot(TOKEN, { polling: true });

    this.bot.onText(/\/start/, (msg) => {
      this.bot.sendMessage(msg.chat.id, "Send me a video and I'll auto-edit the highlights for you!");
    });

    this.bot.on("video", (msg) => this._handleVideo(msg, msg.video));
    this.bot.on("document", (msg) => {
      const doc = msg.document;
      if (!doc || !doc.mime_type?.startsWith("video/")) return;
      this._handleVideo(msg, doc);
    });

    console.log("Telegram bot started, waiting for videos...");
    if (apiId && apiHash) {
      console.log("  MTProto enabled – large file downloads supported (>20MB)");
    } else {
      console.log("  MTProto disabled – max download 20MB. Set TELEGRAM_API_ID + TELEGRAM_API_HASH for large files");
    }
  }

  async stop() {
    if (this.bot) { try { await this.bot.stopPolling(); } catch {} }
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
      const filePath = await this.bot.downloadFile(fileId, os.tmpdir());
      fs.renameSync(filePath, destPath);
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
    const statusMsg = await this.bot.sendMessage(chatId, "Downloading video...");
    const tmpIn = tmpFile("mp4");

    try {
      await this._downloadFile(media.file_id, media.file_size, chatId, msg.message_id, tmpIn);
      const name = media.file_name?.replace(/\.[^/.]+$/, "") || "video";

      const result = await processVideo(tmpIn, name, this.maxUpload, (text) => {
        this.bot.editMessageText(text, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
      });

      const compNote = result.compressed ? " (compressed for Telegram)" : "";
      await this.bot.editMessageText(
        `Done! ${result.segCount} highlights found${compNote}.\n${result.summary}`,
        { chat_id: chatId, message_id: statusMsg.message_id }
      );

      const caption = result.summary ? `AI Edit: ${result.summary}` : "Here's your highlight reel!";
      try {
        await this.bot.sendVideo(chatId, result.outputPath, {
          caption, width: result.width || undefined, height: result.height || undefined,
          duration: result.duration || undefined, supports_streaming: true,
        });
      } catch {
        await this.bot.sendDocument(chatId, result.outputPath, { caption }, { filename: `${name}_edited.mp4`, contentType: "video/mp4" });
      }

      cleanup(tmpIn, result._tmpOut, result._tmpCompressed);
    } catch (err) {
      console.error("[Telegram] Error:", err);
      await this.bot.editMessageText(`Error: ${err.message}`, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
      cleanup(tmpIn);
    }
  }
}

module.exports = TelegramChannel;
