/**
 * Slack channel adapter
 *
 * Uses @slack/bolt for event-based handling. Listens for file_shared events
 * containing video files and auto-edits them.
 *
 * Env: SLACK_BOT_TOKEN      (required) — xoxb-...
 *      SLACK_APP_TOKEN       (required) — xapp-... (for Socket Mode)
 *      SLACK_SIGNING_SECRET  (optional — needed for HTTP mode)
 *
 * Uses Socket Mode by default (no public URL needed).
 *
 * Slack limits: files up to 1GB can be uploaded via API.
 * No practical upload limit for bot responses.
 */

const fs = require("fs");
const { BaseChannel, processVideo, cleanup, tmpFile } = require("./base");

class SlackChannel extends BaseChannel {
  constructor() {
    super();
    this.name = "Slack";
    this.envKeys = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
    this.maxUpload = 0; // Slack has no practical limit for bot uploads
    this.app = null;
  }

  async start() {
    const { App } = require("@slack/bolt");

    this.app = new App({
      token: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      socketMode: true,
    });

    // Listen for messages with video files
    this.app.event("message", async ({ event, client }) => {
      if (!event.files || event.subtype === "bot_message") return;

      const videos = event.files.filter((f) =>
        f.mimetype?.startsWith("video/")
      );
      if (videos.length === 0) return;

      for (const file of videos) {
        await this._handleVideo(event, file, client);
      }
    });

    await this.app.start();
    console.log("Slack bot started (Socket Mode)");
  }

  async stop() {
    if (this.app) { try { await this.app.stop(); } catch {} }
  }

  async _handleVideo(event, file, client) {
    const channel = event.channel;
    const threadTs = event.ts;
    const tmpIn = tmpFile("mp4");

    // Post status in thread
    const statusMsg = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "Downloading video...",
    });

    try {
      // Download file from Slack
      const dlRes = await fetch(file.url_private_download || file.url_private, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });
      if (!dlRes.ok) throw new Error(`Slack download failed: ${dlRes.status}`);
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      fs.writeFileSync(tmpIn, buffer);

      const name = file.name?.replace(/\.[^/.]+$/, "") || "video";

      const result = await processVideo(tmpIn, name, this.maxUpload, (text) => {
        client.chat.update({ channel, ts: statusMsg.ts, text }).catch(() => {});
      });

      // Update status
      const compNote = result.compressed ? " (compressed)" : "";
      await client.chat.update({
        channel,
        ts: statusMsg.ts,
        text: `Done! ${result.segCount} highlights found${compNote}. ${result.summary}`,
      });

      // Upload result
      await client.filesUploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file: fs.createReadStream(result.outputPath),
        filename: `${name}_edited.mp4`,
        title: result.summary || "AI-edited highlight reel",
      });

      cleanup(tmpIn, result._tmpOut, result._tmpCompressed);
    } catch (err) {
      console.error("[Slack] Error:", err);
      await client.chat.update({ channel, ts: statusMsg.ts, text: `Error: ${err.message}` }).catch(() => {});
      cleanup(tmpIn);
    }
  }
}

module.exports = SlackChannel;
