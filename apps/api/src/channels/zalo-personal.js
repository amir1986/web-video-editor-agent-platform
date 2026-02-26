/**
 * Zalo Personal channel adapter
 *
 * Uses Zalo's personal messaging API for individual accounts.
 * This is separate from the Zalo OA (Official Account) channel.
 *
 * Note: Zalo's personal API is more restrictive and may require
 * additional verification. This adapter uses webhook-based event
 * delivery similar to the OA API.
 *
 * Setup:
 *   1. Register a Zalo Mini App or third-party app
 *   2. Get user authorization via OAuth 2.0
 *   3. Store the access/refresh token pair
 *   4. Configure webhook for message events
 *
 * Env: ZALO_PERSONAL_ACCESS_TOKEN  (required) — User access token
 *      ZALO_PERSONAL_REFRESH_TOKEN (optional) — For auto-refresh
 *      ZALO_PERSONAL_APP_ID        (optional) — App ID for token refresh
 *      ZALO_PERSONAL_SECRET        (optional) — App secret for token refresh
 *      ZALO_PERSONAL_PORT          (optional) — Webhook port (default 3982)
 *
 * Zalo Personal limits: ~25MB per attachment.
 */

const fs = require("fs");
const express = require("express");
const { BaseChannel, processVideo, cleanup, tmpFile } = require("./base");

const MAX_UPLOAD = 25 * 1024 * 1024;
const ZALO_GRAPH = "https://graph.zalo.me/v2.0";

class ZaloPersonalChannel extends BaseChannel {
  constructor() {
    super();
    this.name = "Zalo Personal";
    this.envKeys = ["ZALO_PERSONAL_ACCESS_TOKEN"];
    this.maxUpload = MAX_UPLOAD;
    this.server = null;
    this.accessToken = null;
  }

  _headers() {
    return { access_token: this.accessToken || process.env.ZALO_PERSONAL_ACCESS_TOKEN };
  }

  async start() {
    this.accessToken = process.env.ZALO_PERSONAL_ACCESS_TOKEN;

    const app = express();
    const port = parseInt(process.env.ZALO_PERSONAL_PORT || "3982");
    app.use(express.json());

    app.get("/", (req, res) => res.status(200).send(req.query.challenge || "ok"));

    app.post("/", async (req, res) => {
      res.json({ error: 0, message: "ok" });

      const event = req.body;
      if (!event.message) return;

      const senderId = event.sender?.id || event.from_id;
      if (!senderId) return;

      const attachments = event.message?.attachments || [];
      for (const att of attachments) {
        if (att.type !== "video" && !(att.type === "file" && att.payload?.name?.match(/\.(mp4|mov|avi|mkv|webm)$/i))) continue;
        this._handleVideo(senderId, att).catch(err =>
          console.error("[Zalo Personal] Error:", err)
        );
      }
    });

    this.server = app.listen(port, () => {
      console.log(`Zalo Personal bot listening on port ${port}`);
    });

    // Auto-refresh token if configured
    if (process.env.ZALO_PERSONAL_REFRESH_TOKEN && process.env.ZALO_PERSONAL_APP_ID) {
      this._startTokenRefresh();
    }
  }

  async stop() {
    if (this.server) { try { this.server.close(); } catch {} }
    if (this._refreshTimer) clearInterval(this._refreshTimer);
  }

  _startTokenRefresh() {
    // Refresh every 30 minutes (Zalo tokens expire in ~1 hour)
    this._refreshTimer = setInterval(async () => {
      try {
        const res = await fetch("https://oauth.zaloapp.com/v4/access_token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", secret_key: process.env.ZALO_PERSONAL_SECRET },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            app_id: process.env.ZALO_PERSONAL_APP_ID,
            refresh_token: process.env.ZALO_PERSONAL_REFRESH_TOKEN,
          }),
        });
        const data = await res.json();
        if (data.access_token) {
          this.accessToken = data.access_token;
          console.log("[Zalo Personal] Token refreshed");
        }
      } catch (err) {
        console.error("[Zalo Personal] Token refresh failed:", err.message);
      }
    }, 30 * 60 * 1000);
  }

  async _sendMessage(userId, text) {
    await fetch(`${ZALO_GRAPH}/me/message`, {
      method: "POST",
      headers: { ...this._headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ to: userId, message: { text } }),
    });
  }

  async _sendFile(userId, filePath, name) {
    const formData = new FormData();
    const fileBlob = new Blob([fs.readFileSync(filePath)], { type: "video/mp4" });
    formData.append("file", fileBlob, name);
    formData.append("to", userId);
    formData.append("message", JSON.stringify({ text: "" }));

    await fetch(`${ZALO_GRAPH}/me/message/attachment`, {
      method: "POST",
      headers: { ...this._headers() },
      body: formData,
    });
  }

  async _handleVideo(userId, attachment) {
    const tmpIn = tmpFile("mp4");

    await this._sendMessage(userId, "Processing your video with AI...");

    try {
      const url = attachment.payload?.url;
      if (!url) throw new Error("No download URL in attachment");

      const dlRes = await fetch(url, { headers: this._headers() });
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
      console.error("[Zalo Personal] Error:", err);
      await this._sendMessage(userId, `Error: ${err.message}`).catch(() => {});
      cleanup(tmpIn);
    }
  }
}

module.exports = ZaloPersonalChannel;
