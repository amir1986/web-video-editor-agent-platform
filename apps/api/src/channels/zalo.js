/**
 * Zalo Official Account (OA) channel adapter
 *
 * Uses the Zalo OA API for business accounts. Receives webhook events
 * when users send video messages to the OA.
 *
 * Setup:
 *   1. Create a Zalo Official Account at https://oa.zalo.me
 *   2. Create an app at https://developers.zalo.me
 *   3. Get OA Access Token via OAuth flow
 *   4. Configure webhook URL in the app settings
 *
 * Env: ZALO_OA_ACCESS_TOKEN  (required) — OA long-lived access token
 *      ZALO_OA_SECRET        (optional) — Webhook verification secret
 *      ZALO_PORT             (optional) — HTTP port for webhook (default 3981)
 *
 * Zalo OA limits: ~25MB per attachment.
 */

const fs = require("fs");
const express = require("express");
const { BaseChannel, processVideo, cleanup, tmpFile, fetchWithTimeout } = require("./base");

const MAX_UPLOAD = 25 * 1024 * 1024;
const ZALO_API = "https://openapi.zalo.me/v3.0/oa";

class ZaloChannel extends BaseChannel {
  constructor() {
    super();
    this.name = "Zalo OA";
    this.envKeys = ["ZALO_OA_ACCESS_TOKEN"];
    this.maxUpload = MAX_UPLOAD;
    this.server = null;
  }

  _headers() {
    return { access_token: process.env.ZALO_OA_ACCESS_TOKEN };
  }

  async start() {
    const app = express();
    const port = parseInt(process.env.ZALO_PORT || "3981");
    app.use(express.json());

    // Webhook verification
    app.get("/", (req, res) => {
      res.status(200).send(req.query.challenge || "ok");
    });

    // Webhook events
    app.post("/", async (req, res) => {
      res.json({ error: 0, message: "ok" });

      const event = req.body;
      if (event.event_name !== "user_send_file" && event.event_name !== "user_send_video") return;

      const userId = event.sender?.id;
      const msgId = event.message?.msg_id;
      const attachments = event.message?.attachments || [];

      for (const att of attachments) {
        if (att.type !== "video" && att.type !== "file") continue;
        if (att.type === "file" && !att.payload?.name?.match(/\.(mp4|mov|avi|mkv|webm)$/i)) continue;

        this._handleVideo(userId, att).catch(err =>
          console.error("[Zalo] Error:", err)
        );
      }
    });

    this.server = app.listen(port, () => {
      console.log(`Zalo OA bot listening on port ${port}`);
    });
  }

  async stop() {
    if (this.server) { try { this.server.close(); } catch {} }
  }

  async _sendMessage(userId, text) {
    await fetch(`${ZALO_API}/message/cs`, {
      method: "POST",
      headers: { ...this._headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { user_id: userId },
        message: { text },
      }),
    });
  }

  async _sendFile(userId, filePath, name) {
    // Upload file first
    const formData = new FormData();
    const fileBlob = new Blob([fs.readFileSync(filePath)], { type: "video/mp4" });
    formData.append("file", fileBlob, name);

    const uploadRes = await fetch(`${ZALO_API}/upload/file`, {
      method: "POST",
      headers: { ...this._headers() },
      body: formData,
    });
    const uploadData = await uploadRes.json();
    if (uploadData.error) throw new Error(`Zalo upload failed: ${uploadData.message}`);

    const token = uploadData.data?.token;
    if (!token) throw new Error("No upload token received from Zalo");

    // Send file message
    await fetch(`${ZALO_API}/message/cs`, {
      method: "POST",
      headers: { ...this._headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { user_id: userId },
        message: {
          attachment: { type: "file", payload: { token } },
        },
      }),
    });
  }

  async _handleVideo(userId, attachment) {
    const tmpIn = tmpFile("mp4");

    await this._sendMessage(userId, "Processing your video with AI...");

    try {
      // Download from Zalo
      const url = attachment.payload?.url || attachment.payload?.thumbnail;
      if (!url) throw new Error("No download URL in attachment");

      const dlRes = await fetchWithTimeout(url, { headers: this._headers() });
      if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      fs.writeFileSync(tmpIn, buffer);

      const name = attachment.payload?.name?.replace(/\.[^/.]+$/, "") || "video";

      const result = await processVideo(tmpIn, name, this.maxUpload, (text) => {
        this._sendMessage(userId, text).catch(() => {});
      });

      await this._sendMessage(userId,
        `Done! ${result.segCount} highlights found. ${result.summary || ""}`
      );

      await this._sendFile(userId, result.outputPath, `${name}_edited.mp4`);

      cleanup(tmpIn, result._tmpOut, result._tmpCompressed);
    } catch (err) {
      console.error("[Zalo] Error:", err);
      await this._sendMessage(userId, `Error: ${err.message}`).catch(() => {});
      cleanup(tmpIn);
    }
  }
}

module.exports = ZaloChannel;
