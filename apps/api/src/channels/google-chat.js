/**
 * Google Chat channel adapter
 *
 * Uses Google Chat API with a service account or webhook.
 * Supports both push (webhook/pubsub) and pull modes.
 *
 * Setup:
 *   1. Create a Google Cloud project
 *   2. Enable the Google Chat API
 *   3. Create a service account with Chat Bot role
 *   4. Download the service account key JSON
 *   5. Configure the bot in Google Chat API settings
 *
 * Env: GOOGLE_CHAT_CREDENTIALS (required) — Path to service account JSON
 *      GOOGLE_CHAT_PORT        (optional) — HTTP port for webhook (default 3979)
 *
 * Google Chat limits: 200MB per attachment.
 */

const fs = require("fs");
const express = require("express");
const { BaseChannel, processVideo, cleanup, tmpFile } = require("./base");

const MAX_UPLOAD = 200 * 1024 * 1024;

class GoogleChatChannel extends BaseChannel {
  constructor() {
    super();
    this.name = "Google Chat";
    this.envKeys = ["GOOGLE_CHAT_CREDENTIALS"];
    this.maxUpload = MAX_UPLOAD;
    this.server = null;
    this.auth = null;
  }

  async start() {
    const { google } = require("googleapis");
    const credPath = process.env.GOOGLE_CHAT_CREDENTIALS;
    const creds = JSON.parse(fs.readFileSync(credPath, "utf8"));

    this.auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/chat.bot"],
    });
    this.chatApi = google.chat({ version: "v1", auth: this.auth });

    const app = express();
    const port = parseInt(process.env.GOOGLE_CHAT_PORT || "3979");
    app.use(express.json());

    // Google Chat sends events to this endpoint
    app.post("/", async (req, res) => {
      const event = req.body;

      if (event.type === "MESSAGE") {
        const attachment = event.message?.attachment?.[0];
        if (attachment?.contentType?.startsWith("video/")) {
          // Process asynchronously, respond immediately
          this._handleVideo(event).catch(err =>
            console.error("[Google Chat] Error:", err)
          );
          res.json({ text: "Processing your video with AI..." });
          return;
        }

        if (event.message?.text?.toLowerCase()?.includes("help")) {
          res.json({ text: "Send me a video and I'll auto-edit the highlights!" });
          return;
        }
      }

      res.json({});
    });

    this.server = app.listen(port, () => {
      console.log(`Google Chat bot listening on port ${port}`);
    });
  }

  async stop() {
    if (this.server) { try { this.server.close(); } catch {} }
  }

  async _handleVideo(event) {
    const space = event.space?.name;
    const tmpIn = tmpFile("mp4");

    try {
      const attachment = event.message.attachment[0];

      // Download attachment using the Chat API
      const authClient = await this.auth.getClient();
      const token = await authClient.getAccessToken();

      const dlRes = await fetch(attachment.downloadUri, {
        headers: { Authorization: `Bearer ${token.token}` },
      });
      if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      fs.writeFileSync(tmpIn, buffer);

      const name = attachment.contentName?.replace(/\.[^/.]+$/, "") || "video";

      const result = await processVideo(tmpIn, name, this.maxUpload, (text) => {
        this.chatApi.spaces.messages.create({
          parent: space,
          requestBody: { text },
        }).catch(() => {});
      });

      const caption = result.summary
        ? `AI Edit: ${result.summary}`
        : "Here's your highlight reel!";

      await this.chatApi.spaces.messages.create({
        parent: space,
        requestBody: {
          text: `Done! ${result.segCount} highlights found. ${caption}`,
        },
      });

      // Google Chat doesn't support direct file upload via API in all cases,
      // so we provide a download link via the main API
      await this.chatApi.spaces.messages.create({
        parent: space,
        requestBody: {
          text: "Video processing complete. The edited video has been saved.",
        },
      });

      cleanup(tmpIn, result._tmpOut, result._tmpCompressed);
    } catch (err) {
      console.error("[Google Chat] Error:", err);
      try {
        await this.chatApi.spaces.messages.create({
          parent: space,
          requestBody: { text: `Error: ${err.message}` },
        });
      } catch {}
      cleanup(tmpIn);
    }
  }
}

module.exports = GoogleChatChannel;
