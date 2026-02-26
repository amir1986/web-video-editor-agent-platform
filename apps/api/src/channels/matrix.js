/**
 * Matrix channel adapter
 *
 * Uses matrix-bot-sdk for the Matrix protocol. Works with any Matrix
 * homeserver (Element, Synapse, Dendrite, Conduit, etc.).
 *
 * Env: MATRIX_HOMESERVER_URL  (required) — e.g. https://matrix.org
 *      MATRIX_ACCESS_TOKEN    (required) — Bot account access token
 *
 * Matrix limits: governed by homeserver config (default ~50-100MB).
 * We default to 50MB upload limit.
 */

const fs = require("fs");
const { BaseChannel, processVideo, cleanup, tmpFile } = require("./base");

const MAX_UPLOAD = 50 * 1024 * 1024;

class MatrixChannel extends BaseChannel {
  constructor() {
    super();
    this.name = "Matrix";
    this.envKeys = ["MATRIX_HOMESERVER_URL", "MATRIX_ACCESS_TOKEN"];
    this.maxUpload = MAX_UPLOAD;
    this.client = null;
  }

  async start() {
    const { MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin } = require("matrix-bot-sdk");

    const homeserver = process.env.MATRIX_HOMESERVER_URL;
    const token = process.env.MATRIX_ACCESS_TOKEN;
    const storage = new SimpleFsStorageProvider(".matrix_bot_store.json");

    this.client = new MatrixClient(homeserver, token, storage);
    AutojoinRoomsMixin.setupOnClient(this.client);

    this.client.on("room.message", async (roomId, event) => {
      if (event.sender === await this.client.getUserId()) return;
      if (!event.content) return;

      const msgtype = event.content.msgtype;
      if (msgtype !== "m.video" && msgtype !== "m.file") return;

      const info = event.content.info || {};
      if (msgtype === "m.file" && !info.mimetype?.startsWith("video/")) return;

      await this._handleVideo(roomId, event);
    });

    await this.client.start();
    console.log("Matrix bot started");
  }

  async stop() {
    if (this.client) { try { this.client.stop(); } catch {} }
  }

  async _handleVideo(roomId, event) {
    const tmpIn = tmpFile("mp4");

    await this.client.sendText(roomId, "Downloading video...");

    try {
      // Download media from Matrix
      const mxcUrl = event.content.url;
      if (!mxcUrl) throw new Error("No media URL in message");

      const buffer = await this.client.downloadContent(mxcUrl);
      fs.writeFileSync(tmpIn, Buffer.from(buffer.data));

      const name = event.content.body?.replace(/\.[^/.]+$/, "") || "video";

      const result = await processVideo(tmpIn, name, this.maxUpload, (text) => {
        this.client.sendText(roomId, text).catch(() => {});
      });

      const compNote = result.compressed ? " (compressed)" : "";
      await this.client.sendText(roomId, `Done! ${result.segCount} highlights found${compNote}. ${result.summary}`);

      // Upload result to Matrix
      const videoData = fs.readFileSync(result.outputPath);
      const mxcResult = await this.client.uploadContent(videoData, "video/mp4", `${name}_edited.mp4`);

      await this.client.sendMessage(roomId, {
        msgtype: "m.video",
        body: `${name}_edited.mp4`,
        url: mxcResult,
        info: {
          mimetype: "video/mp4",
          size: fs.statSync(result.outputPath).size,
          w: result.width || undefined,
          h: result.height || undefined,
          duration: (result.duration || 0) * 1000,
        },
      });

      cleanup(tmpIn, result._tmpOut, result._tmpCompressed);
    } catch (err) {
      console.error("[Matrix] Error:", err);
      await this.client.sendText(roomId, `Error: ${err.message}`).catch(() => {});
      cleanup(tmpIn);
    }
  }
}

module.exports = MatrixChannel;
