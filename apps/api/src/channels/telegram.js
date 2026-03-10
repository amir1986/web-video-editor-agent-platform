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

    // Catch errors from middleware so a single handler failure doesn't stop polling.
    this.bot.catch((err) => {
      console.error("[Telegram] Handler error:", err.error ?? err);
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
    // connectionRetries: 0 — let _borrowExportedSender fail fast on DC drops
    // instead of the built-in 30-second "sender already has hanging states" loop.
    // Our outer retry loop in _downloadViaMTProto handles retries with a fresh client.
    const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 0 });
    // GramJS calls _updateLoop via a direct module reference inside connect(),
    // so instance-level patches are bypassed. It checks `this._loopStarted`
    // before spawning the loop — setting it to true skips the loop entirely.
    // This client is only used for file downloads; grammy handles updates.
    client._loopStarted = true;
    client._updateLoop = async () => {}; // belt-and-suspenders
    // GramJS's getDC() hardcodes port 443 in its return value regardless of
    // session settings. Override the method on this instance to force port 80
    // so that _borrowExportedSender (cross-DC file downloads) never tries 443.
    const _origGetDC = client.getDC.bind(client);
    client.getDC = async (...args) => {
      const dc = await _origGetDC(...args);
      return { ...dc, port: 80 };
    };
    console.log("[MTProto] getDC patched: all DC connections will use port 80");

    // Only cache the client after connect() succeeds — don't let a broken
    // client get cached and reused on subsequent calls.
    await client.connect();
    await client.invoke(new Api.auth.ImportBotAuthorization({
      flags: 0,
      apiId,
      apiHash,
      botAuthToken: process.env.TELEGRAM_BOT_TOKEN,
    }));

    this.mtClient = client;
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
    // How long with zero progress before we declare a stall.
    // DC2 can be slow but as long as bytes are flowing we keep going.
    const STALL_MS = 2 * 60 * 1000; // 2 min no progress → stall

    for (let attempt = 1; attempt <= 3; attempt++) {
      let stallTimer;
      try {
        const client = await this._getMTClient();
        if (!client) {
          throw new Error("File is >20MB. Set TELEGRAM_API_ID and TELEGRAM_API_HASH for large file support.");
        }
        console.log(`[MTProto] Downloading large file (${sizeMB})... attempt ${attempt}`);
        const messages = await client.getMessages(chatId, { ids: [messageId] });
        if (!messages?.[0]) throw new Error("Could not retrieve message via MTProto");

        let lastProgressAt = Date.now();
        const stallPromise = new Promise((_, reject) => {
          const check = () => {
            if (Date.now() - lastProgressAt > STALL_MS) {
              reject(new Error(`MTProto download stalled (no progress for ${STALL_MS / 60000} min)`));
            } else {
              stallTimer = setTimeout(check, 10_000);
            }
          };
          stallTimer = setTimeout(check, 10_000);
        });

        const buffer = await Promise.race([
          client.downloadMedia(messages[0], {
            progressCallback: (received, total) => {
              lastProgressAt = Date.now();
              if (total > 0) {
                const pct = ((received / total) * 100).toFixed(0);
                process.stdout.write(`\r[MTProto] Progress: ${pct}% (${(received / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)} MB)`);
              }
            },
          }),
          stallPromise,
        ]);
        clearTimeout(stallTimer);
        process.stdout.write("\n");
        fs.writeFileSync(destPath, buffer);
        return;
      } catch (err) {
        clearTimeout(stallTimer);
        process.stdout.write("\n");
        console.error(`[MTProto] Download attempt ${attempt} failed: ${err.message}`);
        // Fully disconnect before nulling so old borrowed senders stop before
        // the next attempt creates new connections (avoids parallel DC floods).
        if (this.mtClient) { try { await this.mtClient.disconnect(); } catch {} }
        this.mtClient = null;
        if (attempt === 3) throw err;
        // Brief cooldown so GramJS internals can finish tearing down sockets
        await new Promise((r) => setTimeout(r, 5000));
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
        }, uploadCtrl.signal);
      } catch {
        await this.bot.api.sendDocument(chatId, new InputFile(result.outputPath), {
          caption,
          filename: `${name}_edited.mp4`,
        }, uploadCtrl.signal);
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
