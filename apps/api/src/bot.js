/**
 * Multi-channel bot entry point.
 *
 * Auto-discovers and starts all messaging channels that have their
 * required environment variables configured. Channels that are missing
 * env vars or npm packages are skipped with a helpful message.
 *
 * Supported channels:
 *   Telegram, Discord, Slack, WhatsApp, Microsoft Teams,
 *   Google Chat, Signal, Matrix, iMessage (BlueBubbles),
 *   WebChat (WebSocket), Zalo OA, Zalo Personal
 *
 * See apps/api/src/channels/ for individual adapter implementations.
 */

const ChannelManager = require("./channels");

const manager = new ChannelManager();

async function main() {
  console.log("Starting multi-channel bot...");
  console.log("");

  const results = await manager.startAll();

  // Print startup summary
  const started = results.filter(r => r.status === "started");
  const skipped = results.filter(r => r.status === "not_configured");
  const errors = results.filter(r => r.status !== "started" && r.status !== "not_configured");

  if (started.length > 0) {
    console.log("");
    console.log(`Active channels (${started.length}):`);
    for (const r of started) {
      console.log(`  + ${r.label}`);
    }
  }

  if (errors.length > 0) {
    console.log("");
    console.log(`Channel errors (${errors.length}):`);
    for (const r of errors) {
      if (r.status === "missing_package") {
        console.log(`  ! ${r.label} — missing package: ${r.install}`);
      } else {
        console.log(`  ! ${r.label} — ${r.error || r.status}`);
      }
    }
  }

  if (skipped.length > 0) {
    console.log("");
    console.log(`Skipped (not configured):`);
    for (const r of skipped) {
      console.log(`  - ${r.label} (needs: ${r.missing.join(", ")})`);
    }
  }

  if (started.length === 0) {
    console.log("");
    console.log("No channels started. Set environment variables to enable channels:");
    console.log("  Telegram:      TELEGRAM_BOT_TOKEN");
    console.log("  Discord:       DISCORD_BOT_TOKEN");
    console.log("  Slack:         SLACK_BOT_TOKEN + SLACK_APP_TOKEN");
    console.log("  WhatsApp:      WHATSAPP_ENABLED=true");
    console.log("  Teams:         TEAMS_APP_ID + TEAMS_APP_PASSWORD");
    console.log("  Matrix:        MATRIX_HOMESERVER_URL + MATRIX_ACCESS_TOKEN");
    console.log("  Signal:        SIGNAL_PHONE");
    console.log("  Google Chat:   GOOGLE_CHAT_CREDENTIALS");
    console.log("  iMessage:      BLUEBUBBLES_URL + BLUEBUBBLES_PASSWORD");
    console.log("  WebChat:       WEBCHAT_ENABLED=true");
    console.log("  Zalo OA:       ZALO_OA_ACCESS_TOKEN");
    console.log("  Zalo Personal: ZALO_PERSONAL_ACCESS_TOKEN");
    process.exit(1);
  }

  console.log("");
}

// Graceful shutdown
async function shutdown() {
  console.log("\nShutting down channels...");
  await manager.stopAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
