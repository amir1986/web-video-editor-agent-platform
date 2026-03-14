/**
 * Matrix channel adapter
 *
 * Uses the Matrix Client-Server REST API directly (native fetch, Node 18+).
 * Works with any Matrix homeserver (Element, Synapse, Dendrite, Conduit, etc.).
 *
 * Env: MATRIX_HOMESERVER_URL  (required) — e.g. https://matrix.org
 *      MATRIX_ACCESS_TOKEN    (required) — Bot account access token
 *
 * Matrix limits: governed by homeserver config (default ~50-100MB).
 * We default to 50MB upload limit.
 */

const fs = require("fs");
const { BaseChannel, processVideo, cleanup, tmpFile, fetchWithTimeout } = require("./base");

const MAX_UPLOAD = 50 * 1024 * 1024;

class MatrixChannel extends BaseChannel {
  constructor() {
    super();
    this.name = "Matrix";
    this.envKeys = ["MATRIX_HOMESERVER_URL", "MATRIX_ACCESS_TOKEN"];
    this.maxUpload = MAX_UPLOAD;
    this._homeserver = null;
    this._token = null;
    this._botUserId = null;
    this._syncToken = null;
    this._polling = false;
    this._txnCounter = 0;
  }

  async start() {
    this._homeserver = process.env.MATRIX_HOMESERVER_URL.replace(/\/$/, "");
    this._token = process.env.MATRIX_ACCESS_TOKEN;

    const whoami = await this._request("GET", "/_matrix/client/v3/whoami");
    this._botUserId = whoami.user_id;

    this._polling = true;
    this._syncLoop().catch((err) => console.error("[Matrix] Sync error:", err));
    console.log("Matrix bot started");
  }

  async stop() {
    this._polling = false;
  }

  async _request(method, path, body) {
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${this._token}`,
        "Content-Type": "application/json",
      },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const resp = await fetch(`${this._homeserver}${path}`, opts);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Matrix ${method} ${path} → ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async _syncLoop() {
    while (this._polling) {
      try {
        const params = new URLSearchParams({ timeout: "30000" });
        if (this._syncToken) params.set("since", this._syncToken);

        const resp = await fetch(
          `${this._homeserver}/_matrix/client/v3/sync?${params}`,
          {
            headers: { Authorization: `Bearer ${this._token}` },
            signal: AbortSignal.timeout(35000),
          }
        );

        if (!resp.ok) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        const data = await resp.json();
        this._syncToken = data.next_batch;
        await this._processSync(data);
      } catch {
        if (this._polling) await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async _processSync(data) {
    const rooms = data.rooms || {};

    // Auto-join invited rooms
    for (const roomId of Object.keys(rooms.invite || {})) {
      await this._request("POST", `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`).catch(() => {});
    }

    // Handle messages in joined rooms
    for (const [roomId, room] of Object.entries(rooms.join || {})) {
      const events = room.timeline?.events || [];
      for (const event of events) {
        if (event.sender === this._botUserId) continue;
        if (event.type !== "m.room.message") continue;
        const content = event.content || {};
        if (content.msgtype !== "m.video" && content.msgtype !== "m.file") continue;
        if (content.msgtype === "m.file" && !content.info?.mimetype?.startsWith("video/")) continue;
        this._handleVideo(roomId, event).catch(() => {});
      }
    }
  }

  async _downloadContent(mxcUrl) {
    const match = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/);
    if (!match) throw new Error(`Invalid MXC URL: ${mxcUrl}`);
    const [, serverName, mediaId] = match;
    const resp = await fetchWithTimeout(
      `${this._homeserver}/_matrix/media/v3/download/${serverName}/${mediaId}`,
      { headers: { Authorization: `Bearer ${this._token}` } }
    );
    if (!resp.ok) throw new Error(`Media download failed: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  async _uploadContent(data, mimeType, filename) {
    const resp = await fetch(
      `${this._homeserver}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._token}`,
          "Content-Type": mimeType,
        },
        body: data,
      }
    );
    if (!resp.ok) throw new Error(`Media upload failed: ${resp.status}`);
    const json = await resp.json();
    return json.content_uri;
  }

  async _sendText(roomId, text) {
    const txnId = `${Date.now()}_${++this._txnCounter}`;
    await this._request(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      { msgtype: "m.text", body: text }
    );
  }

  async _sendMessage(roomId, content) {
    const txnId = `${Date.now()}_${++this._txnCounter}`;
    await this._request(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      content
    );
  }

  async _handleVideo(roomId, event) {
    const tmpIn = tmpFile("mp4");

    await this._sendText(roomId, "Downloading video...");

    try {
      const mxcUrl = event.content.url;
      if (!mxcUrl) throw new Error("No media URL in message");

      const buffer = await this._downloadContent(mxcUrl);
      fs.writeFileSync(tmpIn, buffer);

      const name = event.content.body?.replace(/\.[^/.]+$/, "") || "video";

      const result = await processVideo(tmpIn, name, this.maxUpload, (text) => {
        this._sendText(roomId, text).catch(() => {});
      });

      const compNote = result.compressed ? " (compressed)" : "";
      await this._sendText(roomId, `Done! ${result.segCount} highlights found${compNote}. ${result.summary}`);

      const videoData = fs.readFileSync(result.outputPath);
      const mxcResult = await this._uploadContent(videoData, "video/mp4", `${name}_edited.mp4`);

      await this._sendMessage(roomId, {
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
      await this._sendText(roomId, `Error: ${err.message}`).catch(() => {});
      cleanup(tmpIn);
    }
  }
}

module.exports = MatrixChannel;
