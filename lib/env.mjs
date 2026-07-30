// lib/env.mjs — minimal zero-dep .env loader. Existing process.env always wins.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadEnv(p = join(ROOT, ".env")) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim();
  }
}

// Throws on a missing token so the bot fails loudly at startup, not mid-call.
export function creds() {
  loadEnv();
  const token = process.env.DISCORD_BOT_TOKEN;
  const appId = process.env.DISCORD_APP_ID;
  if (!token) throw new Error("Missing DISCORD_BOT_TOKEN in .env");
  if (!appId) throw new Error("Missing DISCORD_APP_ID in .env");
  return {
    token,
    appId,
    logChannelId: process.env.LOG_CHANNEL_ID || null,
    // Where 🎉 promotion celebrations post; falls back to the log channel.
    celebrateChannelId: process.env.CELEBRATE_CHANNEL_ID || null,
    // Dedup bucket for "first time this split" — bump at each ranked split
    // (then restart); celebration state resets naturally under the new key.
    splitKey: process.env.SPLIT_KEY || "2026-split-2",
  };
}
