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
    // Set explicit timeouts: 500s for large file uploads, 30s for regular calls.
    // Without this grammy uses node-fetch with no timeout, causing sendVideo
    // to hang indefinitely when the Telegram connection goes stale mid-upload.
    this.bot = new Bot(TOKEN, { client: { timeoutSeconds: 500 } });

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

    const { TelegramClient, Api } = require("telegram");
    const { StringSession } = require("telegram/sessions");
    this.mtClient = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
    // GramJS calls _updateLoop via a direct module reference inside connect(),
    // so instance-level patches are bypassed. It checks `this._loopStarted`
    // before spawning the loop — setting it to true skips the loop entirely.
    // This client is only used for file downloads; grammy handles updates.
    this.mtClient._loopStarted = true;
    this.mtClient._updateLoop = async () => {}; // belt-and-suspenders
    await this.mtClient.connect();
    await this.mtClient.invoke(new Api.auth.ImportBotAuthorization({
      flags: 0,
      apiId,
      apiHash,
      botAuthToken: process.env.TELEGRAM_BOT_TOKEN,
    }));

    // After connect(), GramJS has all DC configs in the session (populated by
    // help.GetConfig). Force port 80 for every DC so that _borrowExportedSender
    // (used for cross-DC file downloads) never tries port 443, which is blocked
    // by some ISPs and firewalls.
    for (let dcId = 1; dcId <= 5; dcId++) {
      try {
        const dc = this.mtClient.session.getDC(dcId);
        if (dc && dc.port !== 80) {
          this.mtClient.session.setDC(dcId, dc.serverAddress || dc.ipAddress, 80);
          console.log(`[MTProto] DC${dcId}: forced port ${dc.port} → 80`);
        }
      } catch {}
    }

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
    const sizeMB = fileSize ? `${(fileSize / (1024 * 1024)).toFixed(1)}MB` : "unknown";

    for (let attempt = 1; attempt <= 2; attempt++) {
      const client = await this._getMTClient();
      if (!client) {
        throw new Error("File is >20MB. Set TELEGRAM_API_ID and TELEGRAM_API_HASH for large file support.");
      }
      console.log(`[MTProto] Downloading large file (${sizeMB})... attempt ${attempt}`);
      const messages = await client.getMessages(chatId, { ids: [messageId] });
      if (!messages?.[0]) throw new Error("Could not retrieve message via MTProto");

      try {
        // GramJS _borrowExportedSender recurses forever when the file DC is
        // unreachable. Race against a 5-minute hard timeout to break the loop.
        const buffer = await Promise.race([
          client.downloadMedia(messages[0]),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("MTProto download timed out after 5 min")), 5 * 60 * 1000)
          ),
        ]);
        fs.writeFileSync(destPath, buffer);
        return;
      } catch (err) {
        console.error(`[MTProto] Download attempt ${attempt} failed: ${err.message}`);
        // Discard the broken client so next attempt starts fresh
        if (this.mtClient) { try { await this.mtClient.disconnect(); } catch {} }
        this.mtClient = null;
        if (attempt === 2) throw err;
      }
    }
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
      ).catch(() => {});

      const caption = result.summary ? `AI Edit: ${result.summary}` : "Here's your highlight reel!";
      const uploadCtrl = new AbortController();
      const uploadTimeout = setTimeout(() => uploadCtrl.abort(), 10 * 60 * 1000);
      try {
        await this.bot.api.sendVideo(chatId, new InputFile(result.outputPath), {
          caption,
          width: result.width || undefined,
          height: result.height || undefined,
          duration: result.duration || undefined,
          supports_streaming: true,
        }, { signal: uploadCtrl.signal });
      } catch {
        await this.bot.api.sendDocument(chatId, new InputFile(result.outputPath), {
          caption,
          filename: `${name}_edited.mp4`,
        }, { signal: uploadCtrl.signal });
      } finally {
        clearTimeout(uploadTimeout);
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
