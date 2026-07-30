// lib/riot.mjs — minimal Riot Games API client for rank verification.
//
// The key is re-read from .env on EVERY call (dev keys expire every 24h, so
// rotating one is "edit .env" — no restart, and a fixed key is never baked into
// a long-lived process). 429s honor Retry-After. Errors carry err.status so the
// caller can turn 401/403 (dead key) and 404 (no such Riot ID) into friendly text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.mjs";

// account-v1 is globally replicated — any regional cluster resolves any Riot ID.
const ACCOUNT_HOST = "https://americas.api.riotgames.com";

export function riotKey() {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(
      /\r?\n/,
    )) {
      const t = line.trim();
      if (t.startsWith("RIOT_API_KEY="))
        return t.slice("RIOT_API_KEY=".length).trim() || null;
    }
  } catch {
    /* fall through to process.env */
  }
  return process.env.RIOT_API_KEY || null;
}

async function riot(host, path) {
  const key = riotKey();
  if (!key) {
    const e = new Error("no RIOT_API_KEY configured");
    e.riot = "nokey";
    throw e;
  }
  for (;;) {
    const res = await fetch(`${host}${path}`, {
      headers: { "X-Riot-Token": key },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after")) || 2;
      await new Promise((r) => setTimeout(r, wait * 1000 + 250));
      continue;
    }
    if (!res.ok) {
      const err = new Error(`Riot API ${res.status} ${path}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
}

// Riot ID -> { puuid, gameName, tagLine }.
export function lookupAccount({ gameName, tagLine }) {
  return riot(
    ACCOUNT_HOST,
    `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
  );
}

// puuid -> summoner (carries profileIconId — the ownership-handshake signal).
export function getSummoner({ puuid, platform }) {
  return riot(
    `https://${platform}.api.riotgames.com`,
    `/lol/summoner/v4/summoners/by-puuid/${puuid}`,
  );
}

// puuid -> ranked solo/duo league entry | null. Primary path is league-v4
// entries by-puuid; falls back through summoner-v4 for platforms/deploys where
// the by-puuid route isn't available.
export async function soloEntry({ puuid, platform }) {
  const host = `https://${platform}.api.riotgames.com`;
  let entries;
  try {
    entries = await riot(host, `/lol/league/v4/entries/by-puuid/${puuid}`);
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
    const summ = await getSummoner({ puuid, platform });
    entries = await riot(host, `/lol/league/v4/entries/by-summoner/${summ.id}`);
  }
  return (entries || []).find((e) => e.queueType === "RANKED_SOLO_5x5") || null;
}

// puuid -> live game object, or null when not currently in a game (404).
// Spectator-v5 is the Riot-side "is a game happening" signal — no dependence
// on Discord presence/activity-sharing, which is opt-in and often off.
export async function activeGame({ puuid, platform }) {
  try {
    return await riot(
      `https://${platform}.api.riotgames.com`,
      `/lol/spectator/v5/active-games/by-summoner/${puuid}`,
    );
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// Size of the Challenger solo/duo ladder — the split-rollover canary. The
// ladder sits ~300 all split and collapses to near-zero at a reset, so a
// once-daily size check detects new splits with no date table to maintain.
export async function challengerLadderSize(platform) {
  const j = await riot(
    `https://${platform}.api.riotgames.com`,
    `/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5`,
  );
  return (j.entries || []).length;
}

// Riot ID -> { account, solo } (kept for scripts/lookup.mjs).
export async function lookupSoloRank({ gameName, tagLine, platform }) {
  const account = await lookupAccount({ gameName, tagLine });
  const solo = await soloEntry({ puuid: account.puuid, platform });
  return { account, solo };
}

// Data Dragon (no API key needed): image URL for a profile icon, for showing
// the member exactly which icon to switch to. Version is fetched once, lazily;
// a fetch failure degrades to a recent pinned version rather than breaking.
let ddVersion = null;
export async function profileIconUrl(iconId) {
  if (!ddVersion) {
    try {
      const versions = await (
        await fetch("https://ddragon.leagueoflegends.com/api/versions.json")
      ).json();
      ddVersion = versions?.[0] || "14.24.1";
    } catch {
      ddVersion = "14.24.1";
    }
  }
  return `https://ddragon.leagueoflegends.com/cdn/${ddVersion}/img/profileicon/${iconId}.png`;
}
