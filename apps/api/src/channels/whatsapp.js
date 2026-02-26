/**
 * WhatsApp channel adapter
 *
 * Uses whatsapp-web.js which runs a real WhatsApp Web session via Puppeteer.
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
    this.client = null;
  }

  async start() {
    const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
    this._MessageMedia = MessageMedia;

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: ".wwebjs_auth" }),
      puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
    });

    this.client.on("qr", (qr) => {
      console.log("[WhatsApp] Scan QR code to authenticate:");
      // Print QR in terminal using qrcode-terminal if available
      try {
        require("qrcode-terminal").generate(qr, { small: true });
      } catch {
        console.log(`[WhatsApp] QR: ${qr}`);
      }
    });

    this.client.on("ready", () => {
      console.log("WhatsApp client ready");
    });

    this.client.on("message", async (msg) => {
      if (!msg.hasMedia) return;
      // Only process video messages
      if (msg.type !== "video" && msg.type !== "document") return;

      const media = await msg.downloadMedia();
      if (!media || !media.mimetype?.startsWith("video/")) return;

      await this._handleVideo(msg, media);
    });

    await this.client.initialize();
  }

  async stop() {
    if (this.client) { try { await this.client.destroy(); } catch {} }
  }

  async _handleVideo(msg, media) {
    const chat = await msg.getChat();
    const tmpIn = tmpFile("mp4");

    await chat.sendMessage("Downloading video...");

    try {
      // Write media buffer to file
      const buffer = Buffer.from(media.data, "base64");
      fs.writeFileSync(tmpIn, buffer);

      const name = media.filename?.replace(/\.[^/.]+$/, "") || "video";

      const result = await processVideo(tmpIn, name, this.maxUpload, (text) => {
        chat.sendMessage(text).catch(() => {});
      });

      const caption = result.summary
        ? `AI Edit: ${result.summary}`
        : "Here's your highlight reel!";

      const resultMedia = this._MessageMedia.fromFilePath(result.outputPath);
      await chat.sendMessage(resultMedia, { caption, sendMediaAsDocument: result.compressed });

      cleanup(tmpIn, result._tmpOut, result._tmpCompressed);
    } catch (err) {
      console.error("[WhatsApp] Error:", err);
      await chat.sendMessage(`Error: ${err.message}`).catch(() => {});
      cleanup(tmpIn);
    }
  }
}

module.exports = WhatsAppChannel;
