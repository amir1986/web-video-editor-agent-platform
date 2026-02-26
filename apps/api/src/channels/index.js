/**
 * Channel Manager — auto-discovers and starts all configured channels.
 *
 * Each channel adapter is loaded lazily: only channels with all required
 * env vars set will be started. Missing SDK packages are caught gracefully
 * with an install hint.
 */

const CHANNEL_REGISTRY = [
  { id: "telegram",       module: "./telegram",       label: "Telegram" },
  { id: "discord",        module: "./discord",        label: "Discord" },
  { id: "slack",          module: "./slack",          label: "Slack" },
  { id: "whatsapp",       module: "./whatsapp",       label: "WhatsApp" },
  { id: "teams",          module: "./teams",          label: "Microsoft Teams" },
  { id: "matrix",         module: "./matrix",         label: "Matrix" },
  { id: "signal",         module: "./signal",         label: "Signal" },
  { id: "google-chat",    module: "./google-chat",    label: "Google Chat" },
  { id: "imessage",       module: "./imessage",       label: "iMessage (BlueBubbles)" },
  { id: "webchat",        module: "./webchat",        label: "WebChat" },
  { id: "zalo",           module: "./zalo",           label: "Zalo OA" },
  { id: "zalo-personal",  module: "./zalo-personal",  label: "Zalo Personal" },
];

// Maps channel id → npm packages needed
const PACKAGE_HINTS = {
  telegram:      ["node-telegram-bot-api"],
  discord:       ["discord.js"],
  slack:         ["@slack/bolt"],
  whatsapp:      ["whatsapp-web.js"],
  teams:         ["botbuilder"],
  matrix:        ["matrix-bot-sdk"],
  signal:        [],       // Uses built-in net module + signal-cli daemon
  "google-chat": ["googleapis"],
  imessage:      [],       // Uses BlueBubbles HTTP API (fetch)
  webchat:       ["ws"],
  zalo:          [],       // Uses Zalo REST API (fetch)
  "zalo-personal": [],     // Uses Zalo REST API (fetch)
};

class ChannelManager {
  constructor() {
    this.channels = [];
  }

  /**
   * Load and start all channels that have their env vars configured.
   * Returns an array of { id, label, status } for each channel.
   */
  async startAll() {
    const results = [];

    for (const entry of CHANNEL_REGISTRY) {
      // Load the adapter class
      let ChannelClass;
      try {
        ChannelClass = require(entry.module);
      } catch (err) {
        // Module syntax/require error (not a missing npm package)
        console.error(`[Channels] Failed to load ${entry.label}: ${err.message}`);
        results.push({ id: entry.id, label: entry.label, status: "load_error", error: err.message });
        continue;
      }

      const channel = new ChannelClass();

      // Check if configured
      if (!channel.isConfigured()) {
        const missing = channel.missingEnv();
        results.push({ id: entry.id, label: entry.label, status: "not_configured", missing });
        continue;
      }

      // Try to start
      try {
        await channel.start();
        this.channels.push(channel);
        results.push({ id: entry.id, label: entry.label, status: "started" });
      } catch (err) {
        const msg = err.message || "";

        // Check if it's a missing npm package
        const pkgMatch = msg.match(/Cannot find module '([^']+)'/);
        if (pkgMatch) {
          const pkg = pkgMatch[1];
          const hints = PACKAGE_HINTS[entry.id] || [];
          const installCmd = hints.length > 0
            ? `npm install ${hints.join(" ")}`
            : `npm install ${pkg}`;
          console.log(`[Channels] ${entry.label} needs: ${installCmd}`);
          results.push({ id: entry.id, label: entry.label, status: "missing_package", package: pkg, install: installCmd });
        } else {
          console.error(`[Channels] ${entry.label} failed to start: ${msg}`);
          results.push({ id: entry.id, label: entry.label, status: "start_error", error: msg });
        }
      }
    }

    return results;
  }

  /** Stop all running channels gracefully */
  async stopAll() {
    for (const channel of this.channels) {
      try { await channel.stop(); } catch {}
    }
    this.channels = [];
  }

  /** List all registered channel IDs */
  static listAll() {
    return CHANNEL_REGISTRY.map(e => ({ id: e.id, label: e.label }));
  }
}

module.exports = ChannelManager;
