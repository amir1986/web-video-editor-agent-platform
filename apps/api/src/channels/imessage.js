/**
 * iMessage / BlueBubbles channel adapter
 *
 * Uses the BlueBubbles HTTP API to send/receive iMessages.
 * BlueBubbles runs on a Mac and exposes a REST API.
 *
 * Setup:
 *   1. Install BlueBubbles on a Mac: https://bluebubbles.app
 *   2. Set up the server with a Ngrok/Cloudflare tunnel or local network
 *   3. Note the server URL and password
 *
 * Env: BLUEBUBBLES_URL      (required) — e.g. http://192.168.1.100:1234
 *      BLUEBUBBLES_PASSWORD  (required) — Server password
 *
 * iMessage limits: ~100MB per attachment (practical limit).
 */

const fs = require("fs");
const { BaseChannel, processVideo, cleanup, tmpFile, fetchWithTimeout } = require("./base");

const MAX_UPLOAD = 100 * 1024 * 1024;

class iMessageChannel extends BaseChannel {
  constructor() {
    super();
    this.name = "iMessage (BlueBubbles)";
    this.envKeys = ["BLUEBUBBLES_URL", "BLUEBUBBLES_PASSWORD"];
    this.maxUpload = MAX_UPLOAD;
    this.pollInterval = null;
    this.lastMessageDate = Date.now();
  }

  _apiUrl(endpoint) {
    const base = process.env.BLUEBUBBLES_URL.replace(/\/$/, "");
    const pw = encodeURIComponent(process.env.BLUEBUBBLES_PASSWORD);
    return `${base}/api/v1${endpoint}?password=${pw}`;
  }

  async start() {
    // Verify connection
    const res = await fetch(this._apiUrl("/server/info"));
    if (!res.ok) throw new Error(`BlueBubbles connection failed: ${res.status}`);
    const info = await res.json();
    console.log(`iMessage bot connected via BlueBubbles v${info.data?.os_version || "?"}`);

    // Poll for new messages
    this.lastMessageDate = Date.now();
    this.pollInterval = setInterval(() => this._pollMessages(), 3000);
  }

  async stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  async _pollMessages() {
    try {
      const res = await fetch(this._apiUrl("/message"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: 20,
          after: this.lastMessageDate,
          sort: "ASC",
          with: ["attachment"],
        }),
      });
      if (!res.ok) return;

      const data = await res.json();
      const messages = data.data || [];

      for (const msg of messages) {
        this.lastMessageDate = Math.max(this.lastMessageDate, msg.dateCreated + 1);

        // Skip outgoing messages
        if (msg.isFromMe) continue;

        const videoAttachments = (msg.attachments || []).filter(
          a => a.mimeType?.startsWith("video/")
        );
        if (videoAttachments.length === 0) continue;

        const chatGuid = msg.chats?.[0]?.guid;
        if (!chatGuid) continue;

        for (const att of videoAttachments) {
          this._handleVideo(chatGuid, att, msg).catch(err =>
            console.error("[iMessage] Error:", err)
          );
        }
      }
    } catch (err) {
      // Silently retry on poll errors
    }
  }

  async _sendMessage(chatGuid, text) {
    await fetch(this._apiUrl("/message/text"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatGuid, message: text }),
    });
  }

  async _sendAttachment(chatGuid, filePath, name) {
    const fileData = fs.readFileSync(filePath).toString("base64");
    await fetch(this._apiUrl("/message/attachment"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatGuid,
        attachment: fileData,
        attachmentName: name,
        attachmentType: "video/mp4",
      }),
    });
  }

  async _handleVideo(chatGuid, attachment, msg) {
    const tmpIn = tmpFile("mp4");

    await this._sendMessage(chatGuid, "Processing your video with AI...");

    try {
      // Download attachment from BlueBubbles
      const dlUrl = this._apiUrl(`/attachment/${attachment.guid}/download`);
      const dlRes = await fetchWithTimeout(dlUrl);
      if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      fs.writeFileSync(tmpIn, buffer);

      const name = attachment.transferName?.replace(/\.[^/.]+$/, "") || "video";

      const result = await processVideo(tmpIn, name, this.maxUpload, (text) => {
        this._sendMessage(chatGuid, text).catch(() => {});
      });

      const caption = result.summary
        ? `AI Edit: ${result.summary}`
        : "Here's your highlight reel!";

      await this._sendMessage(chatGuid, `Done! ${result.segCount} highlights found. ${caption}`);
      await this._sendAttachment(chatGuid, result.outputPath, `${name}_edited.mp4`);

      cleanup(tmpIn, result._tmpOut, result._tmpCompressed);
    } catch (err) {
      console.error("[iMessage] Error:", err);
      await this._sendMessage(chatGuid, `Error: ${err.message}`).catch(() => {});
      cleanup(tmpIn);
    }
  }
}

module.exports = iMessageChannel;
