/**
 * Microsoft Teams channel adapter
 *
 * Uses Bot Framework SDK (botbuilder) to receive and reply to messages.
 * Requires an Azure Bot registration and a public HTTPS endpoint (or ngrok).
 *
 * Env: TEAMS_APP_ID       (required) — Azure Bot App ID
 *      TEAMS_APP_PASSWORD  (required) — Azure Bot App Password
 *      TEAMS_PORT          (optional) — HTTP port for bot endpoint (default 3978)
 *
 * Teams limits: ~250MB attachment uploads via bot.
 */

const fs = require("fs");
const { BaseChannel, processVideo, cleanup, tmpFile, API_URL, fetchWithTimeout } = require("./base");

const MAX_UPLOAD = 250 * 1024 * 1024;

class TeamsChannel extends BaseChannel {
  constructor() {
    super();
    this.name = "Microsoft Teams";
    this.envKeys = ["TEAMS_APP_ID", "TEAMS_APP_PASSWORD"];
    this.maxUpload = MAX_UPLOAD;
    this.server = null;
  }

  async start() {
    const { BotFrameworkAdapter, ActivityTypes, MessageFactory } = require("botbuilder");
    const express = require("express");

    const adapter = new BotFrameworkAdapter({
      appId: process.env.TEAMS_APP_ID,
      appPassword: process.env.TEAMS_APP_PASSWORD,
    });

    adapter.onTurnError = async (context, error) => {
      console.error("[Teams] Turn error:", error);
      await context.sendActivity("Sorry, something went wrong processing your video.");
    };

    const app = express();
    const port = parseInt(process.env.TEAMS_PORT || "3978");

    app.post("/api/messages", async (req, res) => {
      await adapter.process(req, res, async (context) => {
        if (context.activity.type !== ActivityTypes.Message) return;

        const attachments = context.activity.attachments || [];
        const videos = attachments.filter(a =>
          a.contentType?.startsWith("video/")
        );

        if (videos.length === 0) {
          // Check for file consent card responses
          if (context.activity.text?.toLowerCase() === "help") {
            await context.sendActivity("Send me a video and I'll auto-edit the highlights!");
          }
          return;
        }

        for (const attachment of videos) {
          await this._handleVideo(context, attachment, MessageFactory);
        }
      });
    });

    this.server = app.listen(port, () => {
      console.log(`Teams bot listening on port ${port}`);
    });
  }

  async stop() {
    if (this.server) { try { this.server.close(); } catch {} }
  }

  async _handleVideo(context, attachment, MessageFactory) {
    const tmpIn = tmpFile("mp4");

    await context.sendActivity("Downloading video...");

    try {
      // Download attachment from Teams
      const url = attachment.contentUrl;
      const headers = {};

      // If it's a Teams-hosted file, use the bot's token
      if (url.includes("microsoft.com") || url.includes("teams")) {
        const token = await context.adapter.credentials?.getToken?.("https://api.botframework.com/.default");
        if (token) headers.Authorization = `Bearer ${token}`;
      }

      const dlRes = await fetchWithTimeout(url, { headers });
      if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      fs.writeFileSync(tmpIn, buffer);

      const name = attachment.name?.replace(/\.[^/.]+$/, "") || "video";

      const result = await processVideo(tmpIn, name, this.maxUpload, async (text) => {
        await context.sendActivity(text);
      });

      const caption = result.summary
        ? `AI Edit: ${result.summary}`
        : "Here's your highlight reel!";

      await context.sendActivity(`Done! ${result.segCount} highlights found.`);

      // Send result as attachment
      const videoData = fs.readFileSync(result.outputPath);
      const b64 = videoData.toString("base64");
      const reply = MessageFactory.contentUrl(
        `data:video/mp4;base64,${b64}`,
        "video/mp4",
        `${name}_edited.mp4`
      );
      reply.text = caption;
      await context.sendActivity(reply);

      cleanup(tmpIn, result._tmpOut, result._tmpCompressed);
    } catch (err) {
      console.error("[Teams] Error:", err);
      await context.sendActivity(`Error: ${err.message}`);
      cleanup(tmpIn);
    }
  }
}

module.exports = TeamsChannel;
