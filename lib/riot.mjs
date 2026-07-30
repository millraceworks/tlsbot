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

// Riot ID -> { account: {puuid, gameName, tagLine}, solo: league entry | null }.
// Primary path is league-v4 entries by-puuid; falls back through summoner-v4 for
// platforms/deploys where the by-puuid route isn't available.
export async function lookupSoloRank({ gameName, tagLine, platform }) {
  const account = await riot(
    ACCOUNT_HOST,
    `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
  );
  const host = `https://${platform}.api.riotgames.com`;
  let entries;
  try {
    entries = await riot(
      host,
      `/lol/league/v4/entries/by-puuid/${account.puuid}`,
    );
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
    const summ = await riot(
      host,
      `/lol/summoner/v4/summoners/by-puuid/${account.puuid}`,
    );
    entries = await riot(host, `/lol/league/v4/entries/by-summoner/${summ.id}`);
  }
  const solo =
    (entries || []).find((e) => e.queueType === "RANKED_SOLO_5x5") || null;
  return { account, solo };
}
