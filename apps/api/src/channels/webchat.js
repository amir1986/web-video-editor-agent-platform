/**
 * WebChat channel adapter
 *
 * Exposes a WebSocket endpoint on the API server for browser-based chat.
 * Users can drag-and-drop videos into the web interface and get AI-edited
 * results back, with real-time progress updates via WebSocket.
 *
 * Env: WEBCHAT_ENABLED  (required) — Set to "true" to enable
 *      WEBCHAT_PORT     (optional) — WebSocket port (default: uses main API port)
 *
 * No upload limit (local network / same-server).
 */

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const { BaseChannel, processVideo, cleanup, tmpFile } = require("./base");

class WebChatChannel extends BaseChannel {
  constructor() {
    super();
    this.name = "WebChat";
    this.envKeys = ["WEBCHAT_ENABLED"];
    this.maxUpload = 0; // No limit for local WebSocket
    this.wss = null;
    this.pendingFiles = new Map(); // sessionId -> { chunks, name }
  }

  async start() {
    const { WebSocketServer } = require("ws");
    const port = parseInt(process.env.WEBCHAT_PORT || "3980");

    this.wss = new WebSocketServer({ port });

    this.wss.on("connection", (ws) => {
      const sessionId = crypto.randomBytes(8).toString("hex");

      ws.on("message", async (data, isBinary) => {
        if (isBinary) {
          // Binary frame = video data
          await this._handleVideoData(ws, sessionId, data);
          return;
        }

        // Text frame = JSON command
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "upload_start") {
            this.pendingFiles.set(sessionId, { name: msg.name || "video", size: msg.size || 0 });
            ws.send(JSON.stringify({ type: "ready" }));
          } else if (msg.type === "help") {
            ws.send(JSON.stringify({ type: "message", text: "Send me a video and I'll auto-edit the highlights!" }));
          }
        } catch {}
      });

      ws.on("close", () => {
        this.pendingFiles.delete(sessionId);
      });

      ws.send(JSON.stringify({ type: "connected", sessionId }));
    });

    console.log(`WebChat bot listening on ws://localhost:${port}`);
  }

  async stop() {
    if (this.wss) { try { this.wss.close(); } catch {} }
  }

  async _handleVideoData(ws, sessionId, data) {
    const meta = this.pendingFiles.get(sessionId) || { name: "video" };
    this.pendingFiles.delete(sessionId);

    const tmpIn = tmpFile("mp4");

    const send = (obj) => {
      try { ws.send(JSON.stringify(obj)); } catch {}
    };

    send({ type: "progress", text: "Video received, processing..." });

    try {
      fs.writeFileSync(tmpIn, data);

      // Style Engine: use WebChat session ID as videographer identity
      const wcUserId = `wc_${sessionId}`;
      const result = await processVideo(tmpIn, meta.name, this.maxUpload, (text) => {
        send({ type: "progress", text });
      }, { userId: wcUserId });

      send({
        type: "complete",
        summary: result.summary,
        segCount: result.segCount,
        compressed: result.compressed,
        width: result.width,
        height: result.height,
        duration: result.duration,
        styleMode: result.styleMode,
        projectCount: result.projectCount,
      });

      // Send the video binary back
      const videoData = fs.readFileSync(result.outputPath);
      ws.send(videoData);

      cleanup(tmpIn, result._tmpOut, result._tmpCompressed);
    } catch (err) {
      console.error("[WebChat] Error:", err);
      send({ type: "error", text: err.message });
      cleanup(tmpIn);
    }
  }
}

module.exports = WebChatChannel;
