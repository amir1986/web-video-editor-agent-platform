/**
 * Discord channel adapter
 *
 * Listens for video attachments in messages and auto-edits them.
 * Uses discord.js v14+. The bot needs MESSAGE_CONTENT intent enabled
 * in the Discord Developer Portal.
 *
 * Env: DISCORD_BOT_TOKEN (required)
 *
 * Discord limits: 25MB upload for regular servers, 50MB for boosted (level 2),
 * 100MB for boosted (level 3). We default to 25MB and compress if needed.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { BaseChannel, processVideo, cleanup, tmpFile } = require("./base");

const MAX_UPLOAD = 25 * 1024 * 1024; // 25MB default (non-boosted)

class DiscordChannel extends BaseChannel {
  constructor() {
    super();
    this.name = "Discord";
    this.envKeys = ["DISCORD_BOT_TOKEN"];
    this.maxUpload = MAX_UPLOAD;
    this.client = null;
  }

  async start() {
    const { Client, GatewayIntentBits, Events } = require("discord.js");

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;

      const videoAttachments = message.attachments.filter(
        (a) => a.contentType?.startsWith("video/")
      );
      if (videoAttachments.size === 0) return;

      for (const [, attachment] of videoAttachments) {
        await this._handleVideo(message, attachment);
      }
    });

    await this.client.login(process.env.DISCORD_BOT_TOKEN);
    console.log(`Discord bot logged in as ${this.client.user.tag}`);
  }

  async stop() {
    if (this.client) { try { await this.client.destroy(); } catch {} }
  }

  _getUploadLimit(guild) {
    if (!guild) return MAX_UPLOAD;
    const boostLevel = guild.premiumTier;
    if (boostLevel >= 3) return 100 * 1024 * 1024;
    if (boostLevel >= 2) return 50 * 1024 * 1024;
    return MAX_UPLOAD;
  }

  async _handleVideo(message, attachment) {
    const statusMsg = await message.reply("Downloading video...");
    const tmpIn = tmpFile("mp4");
    const uploadLimit = this._getUploadLimit(message.guild);

    try {
      // Download attachment
      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(tmpIn, buffer);

      const name = attachment.name?.replace(/\.[^/.]+$/, "") || "video";

      const result = await processVideo(tmpIn, name, uploadLimit, (text) => {
        statusMsg.edit(text).catch(() => {});
      });

      const caption = result.summary
        ? `AI Edit: ${result.summary}`
        : "Here's your highlight reel!";

      const compNote = result.compressed ? " (compressed)" : "";
      await statusMsg.edit(`Done! ${result.segCount} highlights found${compNote}.`);

      await message.reply({
        content: caption,
        files: [{ attachment: result.outputPath, name: `${name}_edited.mp4` }],
      });

      cleanup(tmpIn, result._tmpOut, result._tmpCompressed);
    } catch (err) {
      console.error("[Discord] Error:", err);
      await statusMsg.edit(`Error: ${err.message}`).catch(() => {});
      cleanup(tmpIn);
    }
  }
}

module.exports = DiscordChannel;
