/**
 * WhatsApp channel adapter
 *
 * Uses @whiskeysockets/baileys — native WebSocket implementation of WhatsApp
 * Multi-Device protocol. No Chromium/Puppeteer required.
 * Requires a one-time QR code scan to authenticate.
 *
 * Env: WHATSAPP_ENABLED=true (required — opt-in because it needs QR auth)
 *
 * WhatsApp limits: ~64MB for video messages, 2GB for documents.
 * We use 64MB as the upload limit (sends as video, not document).
 */

const fs = require("fs");
const { BaseChannel, processVideo, cleanup, tmpFile } = require("./base");

const MAX_UPLOAD = 64 * 1024 * 1024;

class WhatsAppChannel extends BaseChannel {
  constructor() {
    super();
    this.name = "WhatsApp";
    this.envKeys = ["WHATSAPP_ENABLED"];
    this.maxUpload = MAX_UPLOAD;
    this.sock = null;
  }

  async start() {
    const {
      default: makeWASocket,
      DisconnectReason,
      useMultiFileAuthState,
      downloadMediaMessage,
    } = require("@whiskeysockets/baileys");

    this._downloadMediaMessage = downloadMediaMessage;

    const { state, saveCreds } = await useMultiFileAuthState(".wwebjs_auth/baileys");

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
      if (connection === "open") {
        console.log("WhatsApp client ready");
      } else if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log("[WhatsApp] Connection closed, reconnect:", shouldReconnect);
        if (shouldReconnect) this.start().catch(console.error);
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const msgType = Object.keys(msg.message)[0];
        if (msgType === "videoMessage" || msgType === "documentMessage") {
          await this._handleVideo(msg).catch((err) =>
            console.error("[WhatsApp] Unhandled error:", err)
          );
        }
      }
    });
  }

  async stop() {
    if (this.sock) {
      try { this.sock.end(); } catch {}
    }
  }

  async _handleVideo(msg) {
    const jid = msg.key.remoteJid;
    const tmpIn = tmpFile("mp4");

    await this.sock.sendMessage(jid, { text: "Downloading video..." });

    try {
      const buffer = await this._downloadMediaMessage(msg, "buffer", {});
      fs.writeFileSync(tmpIn, buffer);

      const videoMsg = msg.message.videoMessage || msg.message.documentMessage;
      const name = (videoMsg?.fileName || "video").replace(/\.[^/.]+$/, "");

      const result = await processVideo(tmpIn, name, this.maxUpload, (text) => {
        this.sock.sendMessage(jid, { text }).catch(() => {});
      });

      const caption = result.summary
        ? `AI Edit: ${result.summary}`
        : "Here's your highlight reel!";

      await this.sock.sendMessage(jid, {
        video: fs.readFileSync(result.outputPath),
        caption,
        mimetype: "video/mp4",
      });

      cleanup(tmpIn, result._tmpOut, result._tmpCompressed);
    } catch (err) {
      console.error("[WhatsApp] Error:", err);
      await this.sock.sendMessage(jid, { text: `Error: ${err.message}` }).catch(() => {});
      cleanup(tmpIn);
    }
  }
}

module.exports = WhatsAppChannel;
