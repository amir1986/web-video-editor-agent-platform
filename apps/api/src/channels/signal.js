/**
 * Signal channel adapter
 *
 * Uses signal-cli in JSON-RPC mode as a bridge. signal-cli must be installed
 * and registered with a phone number separately.
 *
 * Setup:
 *   1. Install signal-cli: https://github.com/AsamK/signal-cli
 *   2. Register: signal-cli -u +1234567890 register
 *   3. Verify:  signal-cli -u +1234567890 verify CODE
 *   4. Start daemon: signal-cli -u +1234567890 daemon --socket /tmp/signal-cli.sock
 *
 * Env: SIGNAL_CLI_SOCKET  (required) — Unix socket path (default /tmp/signal-cli.sock)
 *      SIGNAL_PHONE       (required) — Bot's phone number (+1234567890)
 *
 * Signal limits: ~100MB per attachment.
 */

const fs = require("fs");
const net = require("net");
const path = require("path");
const { BaseChannel, processVideo, cleanup, tmpFile } = require("./base");

const MAX_UPLOAD = 100 * 1024 * 1024;

class SignalChannel extends BaseChannel {
  constructor() {
    super();
    this.name = "Signal";
    this.envKeys = ["SIGNAL_PHONE"];
    this.maxUpload = MAX_UPLOAD;
    this.socket = null;
    this.rpcId = 0;
    this.pendingCalls = new Map();
  }

  async start() {
    const socketPath = process.env.SIGNAL_CLI_SOCKET || "/tmp/signal-cli.sock";

    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(socketPath, () => {
        console.log("Signal bot connected via signal-cli daemon");
        this._subscribe();
        resolve();
      });

      this.socket.on("error", (err) => {
        console.error("[Signal] Socket error:", err.message);
        reject(err);
      });

      let buffer = "";
      this.socket.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this._handleMessage(msg);
          } catch {}
        }
      });
    });
  }

  async stop() {
    if (this.socket) { try { this.socket.destroy(); } catch {} }
  }

  _rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.rpcId;
      const timeout = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new Error("RPC timeout"));
      }, 30000);
      this.pendingCalls.set(id, { resolve, reject, timeout });
      this.socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  _handleMessage(msg) {
    // RPC response
    if (msg.id && this.pendingCalls.has(msg.id)) {
      const { resolve, reject, timeout } = this.pendingCalls.get(msg.id);
      clearTimeout(timeout);
      this.pendingCalls.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }

    // Incoming message notification
    if (msg.method === "receive") {
      const envelope = msg.params?.envelope;
      if (!envelope?.dataMessage) return;

      const dataMsg = envelope.dataMessage;
      const attachments = dataMsg.attachments || [];
      const videos = attachments.filter(a => a.contentType?.startsWith("video/"));

      if (videos.length > 0) {
        const sender = envelope.source;
        for (const att of videos) {
          this._handleVideo(sender, att).catch(err =>
            console.error("[Signal] Error:", err)
          );
        }
      }
    }
  }

  _subscribe() {
    this.socket.write(JSON.stringify({
      jsonrpc: "2.0", id: ++this.rpcId,
      method: "subscribeReceive", params: {},
    }) + "\n");
  }

  async _handleVideo(sender, attachment) {
    const tmpIn = tmpFile("mp4");

    await this._sendMessage(sender, "Downloading video...");

    try {
      // signal-cli saves attachments to a local path
      if (attachment.storedFilePath) {
        fs.copyFileSync(attachment.storedFilePath, tmpIn);
      } else if (attachment.id) {
        // Fetch via signal-cli RPC
        const result = await this._rpc("getAttachment", { id: attachment.id });
        fs.writeFileSync(tmpIn, Buffer.from(result.data, "base64"));
      } else {
        throw new Error("No attachment data available");
      }

      const name = attachment.filename?.replace(/\.[^/.]+$/, "") || "video";

      const result = await processVideo(tmpIn, name, this.maxUpload, (text) => {
        this._sendMessage(sender, text).catch(() => {});
      });

      const caption = result.summary
        ? `AI Edit: ${result.summary}`
        : "Here's your highlight reel!";

      await this._sendMessage(sender, `Done! ${result.segCount} highlights found.`);
      await this._sendAttachment(sender, result.outputPath, caption);

      cleanup(tmpIn, result._tmpOut, result._tmpCompressed);
    } catch (err) {
      console.error("[Signal] Error:", err);
      await this._sendMessage(sender, `Error: ${err.message}`).catch(() => {});
      cleanup(tmpIn);
    }
  }

  async _sendMessage(recipient, text) {
    return this._rpc("send", {
      account: process.env.SIGNAL_PHONE,
      recipient: [recipient],
      message: text,
    });
  }

  async _sendAttachment(recipient, filePath, message) {
    return this._rpc("send", {
      account: process.env.SIGNAL_PHONE,
      recipient: [recipient],
      message: message || "",
      attachments: [filePath],
    });
  }
}

module.exports = SignalChannel;
