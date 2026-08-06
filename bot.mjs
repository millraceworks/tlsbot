#!/usr/bin/env node
// bot.mjs — TLSBot: League rank self-role bot. Zero-dep (Node 22+, built-in WebSocket).
//
// Gateway client (hello -> heartbeat -> identify -> READY -> dispatch), interactions
// answered via REST callbacks. Commands are (re-)registered idempotently per guild on
// every GUILD_CREATE, so inviting the bot to a server is the ONLY setup step.
//
//   /verify      all  — Riot-ID rank verification: pulls the REAL solo/duo rank
//                       from the Riot API and applies the crest role
//   /verifypanel mods — post the persistent VERIFY panel: a button that opens a
//                       Riot-ID modal and runs the exact same verification. This
//                       is the ONLY path to a rank role — the old self-report
//                       picker is retired, so nobody can hand themselves a rank.
//   /ranksetup   mods — create any missing rank roles (colored, zero permissions)
//
// Rank messages show Riot's official rank crests via APPLICATION-owned emojis
// (uploaded once by scripts/upload-emojis.mjs). When a guild has the boost-gated
// ROLE_ICONS feature, /ranksetup also stamps the crest onto each role itself.
//
// Role changes carry X-Audit-Log-Reason, and each change is echoed to the guild's
// log channel — set per-server via /logsetup (falls back to LOG_CHANNEL_ID, then
// to a channel named #bot-logging).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { creds, ROOT } from "./lib/env.mjs";
import { rest } from "./lib/rest.mjs";
import {
  RANKS,
  RANK_BY_KEY,
  RANK_NAME_SET,
  rolePayload,
} from "./lib/ranks.mjs";
import { COMMANDS, REGIONS } from "./lib/commands.mjs";
import {
  lookupAccount,
  getSummoner,
  rankedEntries,
  activeGame,
  challengerLadderSize,
  profileIconUrl,
} from "./lib/riot.mjs";

const {
  appId,
  logChannelId,
  celebrateChannelId,
  splitKey: envSplitKey,
  flexVisible,
  flexRoles,
} = creds();

const log = (m) =>
  process.stderr.write(`[tlsbot ${new Date().toISOString()}] ${m}\n`);

// Valid League platform routing values — the /verify command constrains region
// to a choice list, but the panel's modal is free text, so we validate it.
const PLATFORMS = new Set(REGIONS.map(([, v]) => v));

// Milestone tiers whose SOLO promotions post to the celebrate channel (Goonmaster
// 2026-08-05: only Master / Grandmaster / Challenger, solo only, promotion only,
// once per split). Everything below still logs to #bot-logging — it just never
// posts to the public updates channel.
const MILESTONE_TIERS = new Set(["MASTER", "GRANDMASTER", "CHALLENGER"]);

// --- singleton lock (one gateway connection, ever) ------------------------------
// Two live processes would both receive INTERACTION_CREATE and double-apply role
// changes. PID file validated by LIVENESS (kill(pid,0)), never trusted blindly,
// so a stale lock after a crash or reboot can never wedge the bot shut.
// Exit codes the keeper script keys off: 3 = another instance is live (stop),
// 9 = bad token (retrying can't help; stop). Anything else = crash (restart me).
const LOCK = join(ROOT, ".bot.lock");
function claimLock() {
  let holder = 0;
  try {
    holder = Number(JSON.parse(readFileSync(LOCK, "utf8")).pid) || 0;
  } catch {
    /* missing/unreadable lock counts as stale */
  }
  if (holder && holder !== process.pid) {
    let alive = false;
    try {
      process.kill(holder, 0);
      alive = true;
    } catch {
      /* dead */
    }
    if (alive) {
      log(`refusing to start: TLSBot pid ${holder} is already live`);
      process.exit(3);
    }
    log(`taking over stale lock from dead pid ${holder}`);
  }
  try {
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid }));
  } catch {
    /* a lock we cannot write must never block the bot — degrade, don't die */
  }
  process.on("exit", () => {
    try {
      const held = Number(JSON.parse(readFileSync(LOCK, "utf8")).pid) || 0;
      if (held === process.pid) writeFileSync(LOCK, JSON.stringify({ pid: 0 }));
    } catch {
      /* best-effort */
    }
  });
}

// --- commands (registered per guild — instant, unlike global) -------------------
async function registerCommands(guildId) {
  await rest("PUT", `/applications/${appId}/guilds/${guildId}/commands`, {
    body: COMMANDS,
  });
  log(`commands registered in guild ${guildId}`);
}

// --- application-owned rank-crest emojis ----------------------------------------
// Uploaded once by scripts/upload-emojis.mjs as rank_<key>; resolved by name at
// startup. Falls back to the unicode glyphs if an upload is ever missing.
const appEmoji = new Map(); // rank key -> emoji id

async function loadAppEmojis() {
  try {
    const listing = await rest("GET", `/applications/${appId}/emojis`);
    const items = Array.isArray(listing) ? listing : listing.items || [];
    for (const e of items) {
      const m = /^rank_(\w+)$/.exec(e.name);
      if (m && RANK_BY_KEY.has(m[1])) appEmoji.set(m[1], e.id);
    }
    log(`app emojis loaded (${appEmoji.size}/${RANKS.length} crests)`);
  } catch (e) {
    log(`app-emoji load failed (falling back to unicode): ${e.message}`);
  }
}

// In-message-text form of a rank's crest: the custom app emoji if we have it,
// else the unicode glyph fallback.
const emojiText = (rank) =>
  appEmoji.has(rank.key)
    ? `<:rank_${rank.key}:${appEmoji.get(rank.key)}>`
    : rank.emoji;

// --- per-guild logging config + resolution --------------------------------------
// The log channel is configurable PER SERVER: mods run /logsetup to pick it, and
// the choice is persisted so it survives restarts. Resolution precedence, highest
// first: (1) the channel a mod set via /logsetup [.guilds.json]; (2) the global
// LOG_CHANNEL_ID env [legacy single-guild pin]; (3) a channel literally named
// "bot-logging" [zero-config fallback, e.g. the sandbox]; (4) none -> logging off
// for that guild until a mod configures it (the real server has no #bot-logging).
const GUILDS_FILE = join(ROOT, ".guilds.json");
let guildCfg = {}; // guildId -> { logChannelId?, celebrateChannelId? }
try {
  guildCfg = JSON.parse(readFileSync(GUILDS_FILE, "utf8"));
} catch {
  /* no per-guild config yet */
}
function saveGuildCfg() {
  try {
    writeFileSync(GUILDS_FILE, JSON.stringify(guildCfg, null, 2));
  } catch {
    /* best-effort */
  }
}

const logChannels = new Map(); // guildId -> resolved channelId | null (cache)
const guildFeatures = new Map(); // guildId -> Set of feature flags (ROLE_ICONS…)

// Resolve + cache a guild's log channel from its GUILD_CREATE payload.
function cacheLogChannel(guild) {
  const configured = guildCfg[guild.id]?.logChannelId;
  if (configured) {
    logChannels.set(guild.id, configured);
    return;
  }
  if (logChannelId) {
    logChannels.set(guild.id, logChannelId);
    return;
  }
  const ch = (guild.channels || []).find(
    (c) => c.type === 0 && c.name === "bot-logging",
  );
  logChannels.set(guild.id, ch ? ch.id : null);
}

// Best-effort, never throws: a broken log line must not break a role change.
function logLine(guildId, content) {
  const ch = logChannels.get(guildId);
  if (!ch) return;
  rest("POST", `/channels/${ch}/messages`, { body: { content } }).catch((e) =>
    log(`log-line failed (non-fatal): ${e.message}`),
  );
}

// 🎉 promotion celebrations: a guild's milestone-channel override if it set one,
// else the global CELEBRATE_CHANNEL_ID env, else the guild's own log channel
// ("put it all in bot-logging" = set no override and milestones ride the logs).
function celebrate(guildId, content) {
  const ch =
    guildCfg[guildId]?.celebrateChannelId ||
    celebrateChannelId ||
    logChannels.get(guildId);
  if (!ch) return;
  rest("POST", `/channels/${ch}/messages`, { body: { content } }).catch((e) =>
    log(`celebrate post failed (non-fatal): ${e.message}`),
  );
}

const displayName = (member) =>
  member?.nick || member?.user?.global_name || member?.user?.username || "?";

// --- interaction plumbing -------------------------------------------------------
const respond = (d, payload) =>
  rest("POST", `/interactions/${d.id}/${d.token}/callback`, { body: payload });

const editOriginal = (d, data) =>
  rest("PATCH", `/webhooks/${appId}/${d.token}/messages/@original`, {
    body: data,
  });

// Ephemeral error to the user: try the callback; if we already acked (e.g. a
// deferred reply), edit the original so no "thinking…" spinner is left hanging;
// last resort, post a followup — the user is never left with "interaction failed".
async function errorReply(d, content) {
  try {
    await respond(d, { type: 4, data: { flags: 64, content } });
  } catch {
    try {
      await editOriginal(d, { content });
    } catch {
      await rest("POST", `/webhooks/${appId}/${d.token}`, {
        body: { flags: 64, content },
      }).catch((e) => log(`error-reply failed: ${e.message}`));
    }
  }
}

// --- rank-role core (shared by /verify and the refresher) -----------------------
// Swap the member onto the target rank role: remove every other rank role of
// the SAME variant they hold, add the target (auto-creating it if missing),
// return what was. variant "flex" uses a parallel "<Tier> (Flex)" role ladder,
// so solo and flex roles never displace each other.
async function swapToRank(gid, member, rankKey, reason, variant = "solo") {
  const uid = member.user.id;
  const rank = RANK_BY_KEY.get(rankKey);
  if (!rank) throw new Error(`unknown rank value: ${rankKey}`);
  const nameFor = (r) => (variant === "flex" ? `${r.name} (Flex)` : r.name);
  const variantNames = new Set(RANKS.map(nameFor));
  const roles = await rest("GET", `/guilds/${gid}/roles`);
  const rankRoles = roles.filter((r) => variantNames.has(r.name));
  const have = new Set(member.roles);
  const current = rankRoles.filter((r) => have.has(r.id));
  let target = rankRoles.find((r) => r.name === nameFor(rank));
  if (!target)
    target = await rest("POST", `/guilds/${gid}/roles`, {
      body: { ...rolePayload(rank), name: nameFor(rank) },
      reason: "rank role auto-created",
    });
  for (const r of current)
    if (r.id !== target.id)
      await rest("DELETE", `/guilds/${gid}/members/${uid}/roles/${r.id}`, {
        reason,
      });
  if (!have.has(target.id))
    await rest("PUT", `/guilds/${gid}/members/${uid}/roles/${target.id}`, {
      reason,
    });
  return { rank, was: current.map((r) => r.name) };
}

// --- handlers -------------------------------------------------------------------
// /verify riot_id:<Name#TAG> [region] — the flagship: pull the REAL solo/duo
// rank from the Riot API and apply the crest role. Self-reported rank is junk
// data; this is the thing native onboarding and off-the-shelf bots don't do.
// Ownership challenges awaiting the icon handshake: userId -> challenge.
// Persisted to .verify-pending.json so a restart never strands a member
// mid-handshake (learned live: a copy-fix restart wiped an active challenge).
const PENDING_FILE = join(ROOT, ".verify-pending.json");
const pendingVerify = new Map();
try {
  for (const [uid, c] of Object.entries(
    JSON.parse(readFileSync(PENDING_FILE, "utf8")),
  ))
    if (c.expires > Date.now()) pendingVerify.set(uid, c);
} catch {
  /* no pending file yet */
}
function savePending() {
  try {
    writeFileSync(
      PENDING_FILE,
      JSON.stringify(Object.fromEntries(pendingVerify)),
    );
  } catch {
    /* best-effort */
  }
}
const VERIFY_TTL_MS = 15 * 60 * 1000;
// Icons 0-28 are the classic starters every account owns.
const STARTER_ICONS = Array.from({ length: 29 }, (_, i) => i);

const editByToken = (token, data) =>
  rest("PATCH", `/webhooks/${appId}/${token}/messages/@original`, {
    body: data,
  });

const riotErrorText = (e, who, platform) => {
  if (e.riot === "nokey" || e.status === 401 || e.status === 403)
    return "⚠️ The Riot API key is missing or expired — a mod needs to refresh it (dev keys last 24h).";
  if (e.status === 404 && who)
    return `⚠️ Couldn't find **${who}** — check the spelling and tag, and the region (this looked in ${platform.toUpperCase()}).`;
  return null;
};

// The shared verification core. Both entry points — the /verify slash command
// and the panel's Riot-ID modal — defer an ephemeral reply FIRST, then hand the
// raw Riot ID + platform here; everything the member sees (icon challenge, Check
// button, errors) is edited onto that deferred message via editOriginal(d, …).
async function startVerification(d, rawRiotId, platform) {
  const raw = String(rawRiotId || "").trim();
  const hash = raw.indexOf("#");
  if (hash < 1 || hash === raw.length - 1)
    return editOriginal(d, {
      content:
        "⚠️ That doesn't look like a Riot ID — use the full `Name#TAG` form (e.g. `Faker#KR1`).",
    });
  const gameName = raw.slice(0, hash).trim();
  const tagLine = raw.slice(hash + 1).trim();

  try {
    const account = await lookupAccount({ gameName, tagLine });
    const summ = await getSummoner({ puuid: account.puuid, platform });
    const riotId = `${account.gameName}#${account.tagLine}`;
    // Ownership handshake: demand a starter icon they're NOT currently wearing,
    // so a stale/lucky match can never pass someone claiming another's account.
    const pool = STARTER_ICONS.filter((i) => i !== summ.profileIconId);
    const iconId = pool[Math.floor(Math.random() * pool.length)];
    pendingVerify.set(d.member.user.id, {
      puuid: account.puuid,
      riotId,
      platform,
      iconId,
      gid: d.guild_id,
      token: d.token,
      expires: Date.now() + VERIFY_TTL_MS,
    });
    savePending();
    await editOriginal(d, {
      content:
        `Found **${riotId}** (${platform.toUpperCase()}). Now prove it's yours:\n` +
        `1. In the **League client** (the game itself — not Discord), open your profile → change your **summoner icon** to the starter icon shown here (icon **#${iconId}**).\n` +
        `2. Come back and press **Check** — I'll confirm it via the Riot API and apply your real rank.\n` +
        `-# You can switch your icon back right after. Challenge expires in 15 minutes.`,
      embeds: [
        {
          title: `Set this icon: #${iconId}`,
          thumbnail: { url: await profileIconUrl(iconId) },
          color: 0x5ca8e8,
        },
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: "Check — I changed it",
              custom_id: "verify:check",
            },
          ],
        },
      ],
    });
  } catch (e) {
    const friendly = riotErrorText(e, `${gameName}#${tagLine}`, platform);
    if (friendly) return editOriginal(d, { content: friendly });
    throw e; // anything else -> onInteraction's catch (errorReply edits the deferred msg)
  }
}

// /verify riot_id:<Name#TAG> [region] — the slash entry point.
async function handleVerify(d) {
  // Riot round-trips can outrun the 3s callback window — defer immediately.
  await respond(d, { type: 5, data: { flags: 64 } });
  const opts = Object.fromEntries(
    (d.data.options || []).map((o) => [o.name, o.value]),
  );
  return startVerification(d, opts.riot_id, opts.region || "na1");
}

// /verifypanel — post the persistent VERIFY panel (mods). One public message with
// a single button; each click opens a private modal, so the panel stays clean and
// every member's verification is their own ephemeral thread. This replaces the old
// self-report picker: a rank role can now only come from real Riot verification.
async function handleVerifyPanel(d) {
  await respond(d, {
    type: 4,
    data: {
      content:
        "**Verify your League rank** 🛡️\n" +
        "Click **Verify my rank**, enter your Riot ID (`Name#TAG`), and do a quick one-time " +
        "summoner-icon check to prove the account is yours. Your **real** solo/duo rank is then " +
        "pulled straight from Riot and the matching role is applied automatically.\n" +
        "-# No self-reporting — every rank here is verified against the Riot API.",
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: "Verify my rank",
              custom_id: "verify:start",
              emoji: { name: "✅" },
            },
          ],
        },
      ],
    },
  });
  logLine(
    d.guild_id,
    `📌 **${displayName(d.member)}** posted the verify panel in <#${d.channel_id}>`,
  );
}

// Panel button click -> open the Riot-ID modal. Respond with the modal directly
// (type 9): a modal is NOT deferrable, so no ack precedes it.
async function handleVerifyStart(d) {
  return respond(d, {
    type: 9,
    data: {
      custom_id: "verify:modal",
      title: "Verify your League rank",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4, // text input
              custom_id: "riot_id",
              style: 1,
              label: "Riot ID (Name#TAG)",
              placeholder: "Faker#KR1",
              min_length: 3,
              max_length: 40,
              required: true,
            },
          ],
        },
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "region",
              style: 1,
              label: "Region (leave blank for NA)",
              placeholder: "na1 / euw1 / kr / br1 …",
              max_length: 8,
              required: false,
            },
          ],
        },
      ],
    },
  });
}

// Modal submit -> validate the region, then run the identical verification core.
async function handleVerifyModal(d) {
  await respond(d, { type: 5, data: { flags: 64 } }); // deferred ephemeral
  const fields = {};
  for (const row of d.data.components || [])
    for (const c of row.components || []) fields[c.custom_id] = c.value;
  const region = String(fields.region || "")
    .trim()
    .toLowerCase();
  if (region && !PLATFORMS.has(region))
    return editOriginal(d, {
      content:
        `⚠️ Unknown region "${region}". Leave it blank for NA, or use one of: ` +
        `${REGIONS.map(([, v]) => v).join(", ")}.`,
    });
  return startVerification(d, fields.riot_id, region || "na1");
}

// Complete a proven challenge: pull the rank, swap the role, update the
// member's ephemeral message (best-effort — the role matters more than the
// message), log. Shared by the Check button and the auto-watcher.
async function finishVerification(uid, challenge, editToken) {
  const { puuid, riotId, platform, gid } = challenge;
  pendingVerify.delete(uid);
  savePending();
  const edit = (data) =>
    editByToken(editToken, data).catch((e) =>
      log(`verify edit failed (non-fatal): ${e.message}`),
    );
  const entries = await rankedEntries({ puuid, platform });
  const solo = entries.find((e) => e.queueType === "RANKED_SOLO_5x5") || null;
  const fx = entries.find((e) => e.queueType === "RANKED_FLEX_SR") || null;
  // Ownership proven — remember the link (ranked or not) so the refresher
  // keeps this member's roles current from here on. Both queues tracked.
  links[uid] = {
    gid,
    puuid,
    riotId,
    platform,
    tier: solo?.tier || null,
    division: solo?.rank || null,
    lp: solo?.leaguePoints ?? null,
    // Explicit nulls (not a bare {}): "tier" being PRESENT-but-null means
    // "verified while unranked" — a later placement is a real transition and
    // celebrates. A state object MISSING the key entirely means "queue never
    // seeded" and gets adopted silently (see processQueueEntry).
    flex: fx
      ? { tier: fx.tier, division: fx.rank, lp: fx.leaguePoints }
      : { tier: null, division: null, lp: null },
    // Re-verifying must NOT wipe celebration history, or demote -> re-verify
    // -> re-promote would farm duplicate 🎉s (the exact thing the spec bans).
    celebrated: links[uid]?.celebrated ?? {},
    verifiedAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveLinks();
  if (fx && flexRoles) {
    const fxKey = String(fx.tier || "").toLowerCase();
    if (RANK_BY_KEY.has(fxKey))
      await swapToRank(
        gid,
        await rest("GET", `/guilds/${gid}/members/${uid}`),
        fxKey,
        `flex rank verified via Riot icon handshake (${riotId}, ${platform})`,
        "flex",
      ).catch((e) => log(`flex role on verify failed: ${e.message}`));
  }
  if (!solo)
    return edit({
      content: `✅ Ownership of **${riotId}** verified — no ranked solo/duo entry this season yet, so no rank role for now. You're linked though: once you play placements, your role will appear on its own.`,
      embeds: [],
      components: [],
    });
  const rankKey = String(solo.tier || "").toLowerCase();
  if (!RANK_BY_KEY.has(rankKey))
    return edit({
      content: `⚠️ Riot returned an unexpected tier ("${solo.tier}") — tell a mod.`,
      embeds: [],
      components: [],
    });
  // Fresh member fetch: the watcher path has no interaction payload, and even
  // on the button path the snapshot may be minutes old.
  const member = await rest("GET", `/guilds/${gid}/members/${uid}`);
  const { rank, was } = await swapToRank(
    gid,
    member,
    rankKey,
    `rank verified via Riot icon handshake (${riotId}, ${platform})`,
  );
  const division = ["MASTER", "GRANDMASTER", "CHALLENGER"].includes(solo.tier)
    ? ""
    : ` ${solo.rank}`;
  const label = `${rank.name}${division} · ${solo.leaguePoints} LP`;
  await edit({
    content: `${emojiText(rank)} Verified owner of **${riotId}** — **${label}**. Role applied; feel free to switch your icon back.`,
    embeds: [],
    components: [],
  });
  logLine(
    gid,
    `✅ ${emojiText(rank)} **${displayName(member)}** verified as **${riotId}** (icon handshake) — ${label}${
      was.length && was[0] !== rank.name ? ` (was ${was.join(", ")})` : ""
    }`,
  );
}

// After a failed Check, keep polling Riot until the icon lands — their cache
// can run MINUTES behind the client (observed live), and the member shouldn't
// have to hammer the button against it. One watcher per user, in-memory (a
// restart drops the watcher, but the persisted challenge keeps Check alive).
const watching = new Set();
function watchChallenge(uid) {
  if (watching.has(uid)) return;
  watching.add(uid);
  const tick = async () => {
    const challenge = pendingVerify.get(uid);
    if (!challenge || challenge.expires < Date.now()) {
      watching.delete(uid);
      if (challenge) {
        pendingVerify.delete(uid);
        savePending();
        editByToken(challenge.token, {
          content:
            "⏱️ Verification expired before the icon change appeared — run `/verify` again.",
          embeds: [],
          components: [],
        }).catch(() => {});
      }
      return;
    }
    try {
      const summ = await getSummoner(challenge);
      if (summ.profileIconId === challenge.iconId) {
        watching.delete(uid);
        await finishVerification(uid, challenge, challenge.token);
        return;
      }
    } catch (e) {
      log(`verify watcher (${uid}): ${e.message}`);
      if (e.riot === "nokey" || e.status === 401 || e.status === 403) {
        watching.delete(uid);
        return; // dead key — pointless to keep polling
      }
    }
    setTimeout(tick, 20_000);
  };
  setTimeout(tick, 20_000);
}

// The "Check" button: re-fetch the summoner; the icon matching the challenge
// proves account control, and only then does the rank role get applied. A
// miss arms the auto-watcher, so slow Riot propagation resolves itself.
async function handleVerifyCheck(d) {
  const uid = d.member.user.id;
  const challenge = pendingVerify.get(uid);
  if (!challenge || challenge.expires < Date.now()) {
    pendingVerify.delete(uid);
    savePending();
    return respond(d, {
      type: 4,
      data: {
        flags: 64,
        content:
          "⏱️ No active verification (or it expired) — run `/verify` again to restart.",
      },
    });
  }
  // Deferred UPDATE (type 6): Riot calls + role ops can outrun the 3s window.
  await respond(d, { type: 6 });
  // Future edits (including the watcher's) target this click's message token.
  challenge.token = d.token;
  savePending();
  const { puuid, riotId, platform, iconId } = challenge;
  try {
    const summ = await getSummoner({ puuid, platform });
    if (summ.profileIconId !== iconId) {
      watchChallenge(uid);
      return editOriginal(d, {
        content:
          `Not yet — **${riotId}** is currently wearing icon **#${summ.profileIconId}**, I asked for **#${iconId}**.\n` +
          `Riot's API can run a few **minutes** behind the client. If you've already changed it, just wait — ` +
          `I'm now re-checking every 20 seconds and this message will update on its own the moment it lands.`,
      });
    }
    await finishVerification(uid, challenge, d.token);
  } catch (e) {
    const friendly = riotErrorText(e, riotId, platform);
    if (friendly) return editOriginal(d, { content: friendly });
    throw e;
  }
}

// --- verified links + the "realtime" refresh engine ------------------------------
// uid -> { gid, puuid, riotId, platform, tier, division, lp, verifiedAt, updatedAt }
// Flat JSON file, like the challenge store — at this scale a database is pure
// ceremony, and the file moves with the folder to any host with a disk.
const LINKS_FILE = join(ROOT, ".links.json");
let links = {};
try {
  links = JSON.parse(readFileSync(LINKS_FILE, "utf8"));
} catch {
  /* no links yet */
}
function saveLinks() {
  try {
    writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
  } catch {
    /* best-effort */
  }
}

// Split state: current split key + the canary baseline. SPLIT_KEY in .env pins
// it manually (auto-detect off); otherwise a once-daily Challenger-ladder size
// check rolls the key automatically when a reset is detected — the ladder sits
// ~300 all split and collapses to near-zero the day a new split starts.
const SPLIT_FILE = join(ROOT, ".split.json");
let splitState = { key: "2026-split-2", ladder: 0 };
try {
  splitState = {
    ...splitState,
    ...JSON.parse(readFileSync(SPLIT_FILE, "utf8")),
  };
} catch {
  /* first run */
}
function saveSplit() {
  try {
    writeFileSync(SPLIT_FILE, JSON.stringify(splitState));
  } catch {
    /* best-effort */
  }
}
const currentSplit = () => envSplitKey || splitState.key;

async function checkSplitRollover() {
  if (envSplitKey) return; // pinned manually in .env — auto-detection off
  try {
    const platform = Object.values(links)[0]?.platform || "na1";
    const size = await challengerLadderSize(platform);
    if (splitState.ladder >= 100 && size < 30) {
      splitState.key = `auto-${new Date().toISOString().slice(0, 10)}`;
      log(
        `split rollover detected (challenger ladder ${splitState.ladder} -> ${size}) — new key ${splitState.key}`,
      );
      for (const gid of new Set(Object.values(links).map((l) => l.gid)))
        logLine(
          gid,
          "🔄 New ranked split detected — celebration slate reset; first tier promotions get their 🎉 again.",
        );
    }
    splitState.ladder = size;
    saveSplit();
  } catch (e) {
    log(`split canary failed (non-fatal): ${e.message}`);
  }
}
setInterval(checkSplitRollover, 24 * 60 * 60 * 1000);
setTimeout(checkSplitRollover, 90_000);

const rankScore = (tier, division) => {
  const ti = RANKS.findIndex(
    (r) => r.name.toUpperCase() === String(tier || "").toUpperCase(),
  );
  if (ti < 0) return -100; // unranked sorts below Iron IV
  return ti * 4 + (3 - ["I", "II", "III", "IV"].indexOf(division || "I"));
};
function rankLabel(link) {
  if (!link.tier) return "Unranked";
  const name =
    RANK_BY_KEY.get(String(link.tier).toLowerCase())?.name || link.tier;
  const div = ["MASTER", "GRANDMASTER", "CHALLENGER"].includes(link.tier)
    ? ""
    : ` ${link.division}`;
  return `${name}${div}`;
}

const tierIndexOf = (t) =>
  RANKS.findIndex(
    (r) => r.name.toUpperCase() === String(t || "").toUpperCase(),
  );

// Process one queue's entry for a link: mutate the queue state, swap the role
// (when this queue manages roles), log the change, and celebrate first-time
// tier promotions (Goonmaster spec: once per tier per split, per queue;
// demote-then-repromote stays quiet; unranked -> placed counts as a first).
// LP-only changes log too for now (Noah 2026-07-30: verbose while testing).
async function processQueueEntry({
  uid,
  link,
  entry,
  state,
  getMember,
  why,
  variant,
  label,
  manageRoles,
  visible,
}) {
  // Silent paths — state updates, zero output: (1) first observation of a
  // queue for a link that predates its tracking (the "tier" key absent
  // entirely, vs present-but-null = truly unranked at verify), and (2) a queue
  // tracked but not VISIBLE (flex, per Goonmaster: "Let's ignore flex rank" —
  // we keep the data current so flipping it on later needs no backfill).
  if (!("tier" in state) || !visible) {
    state.tier = entry.tier;
    state.division = entry.rank;
    state.lp = entry.leaguePoints;
    return;
  }
  const changedTier = entry.tier !== state.tier;
  const changedDiv = changedTier || entry.rank !== state.division;
  const changedLp = entry.leaguePoints !== state.lp;
  const beforeTier = state.tier;
  const beforeLabel = rankLabel(state);
  const beforeScore = rankScore(state.tier, state.division);
  const beforeLp = state.lp;
  state.tier = entry.tier;
  state.division = entry.rank;
  state.lp = entry.leaguePoints;
  if (!changedDiv && !changedLp) return;
  const rank = RANK_BY_KEY.get(String(entry.tier).toLowerCase());
  if (!rank) return;
  const member = await getMember();
  if (changedTier && manageRoles)
    await swapToRank(
      link.gid,
      member,
      rank.key,
      `rank auto-refresh${label} (${why})`,
      variant,
    );
  if (changedDiv) {
    const up = rankScore(state.tier, state.division) >= beforeScore;
    logLine(
      link.gid,
      `${up ? "📈" : "📉"} ${emojiText(rank)} **${displayName(member)}** ${up ? "climbed" : "fell"}${label}: **${beforeLabel}** → **${rankLabel(state)}** (${entry.leaguePoints} LP)`,
    );
    // Milestone celebration -> the public updates channel (CELEBRATE_CHANNEL_ID).
    // Spec (Goonmaster 2026-08-05): SOLO/DUO only, Master/GM/Challenger only,
    // promotion only (this branch is already promotion-gated), once per split
    // (the dedup below; demote -> re-promote within a split stays quiet). Lower
    // tiers and flex still log to #bot-logging above — they just never post here.
    const promoted =
      changedTier && tierIndexOf(state.tier) > tierIndexOf(beforeTier);
    if (promoted && variant === "solo" && MILESTONE_TIERS.has(state.tier)) {
      link.celebrated ??= {};
      const done = (link.celebrated[currentSplit()] ??= []);
      if (!done.includes(state.tier)) {
        done.push(state.tier);
        // Persist the dedup + the new tier NOW, before the celebrate POST and
        // before the (later) flex pass — otherwise a flex-branch throw or a
        // restart in that window re-observes the same promotion and double-posts
        // the milestone. refreshLink() saves again at the end; this is the guard.
        saveLinks();
        celebrate(
          link.gid,
          `🎉 ${emojiText(rank)} <@${uid}> just hit **${rank.name}** in Solo/Duo for the first time this split — GGs! 🏆 (${link.riotId})`,
        );
      }
    }
  } else {
    const up = entry.leaguePoints > (beforeLp ?? 0);
    logLine(
      link.gid,
      `${up ? "📈" : "📉"} ${emojiText(rank)} **${displayName(member)}** ${rankLabel(state)}${label}: ${beforeLp ?? "?"} → ${entry.leaguePoints} LP`,
    );
  }
}

// PUUIDs are ENCRYPTED PER API KEY: swapping keys (dev -> personal, or any
// rotation) silently invalidates every stored puuid — Riot answers 400 to
// by-puuid calls. Self-heal: re-resolve the Riot ID under the current key and
// carry on. A key rotation costs one extra call per link, once, automatically.
const healing = new Set();
async function healLink(uid, link) {
  if (healing.has(uid)) return false;
  healing.add(uid);
  try {
    const hash = link.riotId.indexOf("#");
    const acct = await lookupAccount({
      gameName: link.riotId.slice(0, hash),
      tagLine: link.riotId.slice(hash + 1),
    });
    if (acct?.puuid && acct.puuid !== link.puuid) {
      link.puuid = acct.puuid;
      saveLinks();
      log(
        `healed puuid for ${link.riotId} (API-key change re-encrypts puuids)`,
      );
      return true;
    }
    return false;
  } catch (e) {
    log(`puuid heal failed for ${link.riotId}: ${e.message}`);
    return false;
  } finally {
    healing.delete(uid);
  }
}

// Re-pull one linked account — ONE Riot call covers both queues. Solo/duo
// state lives on the link root (back-compat) and always manages roles; flex
// lives under link.flex, always tracked/logged/celebrated, roles only behind
// the FLEX_ROLES flag (a parallel "<Tier> (Flex)" ladder).
const refreshing = new Set();
async function refreshLink(uid, why) {
  const link = links[uid];
  if (!link || refreshing.has(uid)) return;
  refreshing.add(uid);
  try {
    const entries = await rankedEntries({
      puuid: link.puuid,
      platform: link.platform,
    });
    let member = null; // fetched at most once, and only when something changed
    const getMember = async () =>
      (member ??= await rest("GET", `/guilds/${link.gid}/members/${uid}`));

    const solo = entries.find((e) => e.queueType === "RANKED_SOLO_5x5");
    if (solo)
      await processQueueEntry({
        uid,
        link,
        entry: solo,
        state: link,
        getMember,
        why,
        variant: "solo",
        label: "",
        manageRoles: true,
        visible: true,
      });

    const fx = entries.find((e) => e.queueType === "RANKED_FLEX_SR");
    if (fx) {
      link.flex ??= {};
      await processQueueEntry({
        uid,
        link,
        entry: fx,
        state: link.flex,
        getMember,
        why,
        variant: "flex",
        label: " (Flex)",
        manageRoles: flexRoles,
        visible: flexVisible,
      });
    }

    link.updatedAt = Date.now();
    saveLinks();
  } catch (e) {
    if (e.status === 400) {
      // Stale puuid from a key rotation — heal, then retry once.
      if (await healLink(uid, link))
        setTimeout(() => refreshLink(uid, why), 1000);
      return;
    }
    log(`refresh ${uid} (${why}) failed: ${e.message}`);
  } finally {
    refreshing.delete(uid);
  }
}

// Presence layer: ranks only change when a game ends, so with the (privileged,
// portal-toggled) Presence Intent we refresh a member ~2.5 min after their
// League session ends — "realtime" without wasting a single API call on
// people who aren't playing.
const inGame = new Set();
const REFRESH_DELAY_MS = 2.5 * 60 * 1000;

const playingLeague = (presence) =>
  (presence.activities || []).some(
    (a) => a.type === 0 && /league of legends/i.test(a.name || ""),
  );

function onPresence(d) {
  const uid = d.user?.id;
  if (!uid || !links[uid]) return;
  if (playingLeague(d)) {
    inGame.add(uid);
    return;
  }
  if (!inGame.has(uid)) return;
  inGame.delete(uid);
  log(`presence: linked member ${uid} finished a League session`);
  setTimeout(() => refreshLink(uid, "game ended"), REFRESH_DELAY_MS);
}

// THE universal game-end detector (Riot-side, works for every linked member):
// poll spectator-v5 per link on a cycle; an in-game -> not-in-game transition
// means the game just ended, so refresh ~90s later when the ladder has it.
// Discord presence (above) remains only as a free accelerator for members who
// happen to share activity — this loop needs nothing from anyone's settings.
const SPECTATE_INTERVAL_MS = 2 * 60 * 1000;
const inLiveGame = new Set();

// Live feed: also announce game start/end in #bot-logging (Noah 2026-07-30:
// "I want all of that in bot logging — I'll turn it off later if it makes
// sense"). Flip to false to quiet the feed without touching the detector.
const LIVE_FEED = true;
const QUEUE_NAMES = {
  420: "Ranked Solo/Duo",
  440: "Ranked Flex",
  400: "Normal Draft",
  430: "Normal Blind",
  450: "ARAM",
  490: "Quickplay",
  1700: "Arena",
};
const queueLabel = (game) => {
  const q = QUEUE_NAMES[game?.gameQueueConfigId];
  return q ? ` (${q})` : "";
};

async function pollLiveGames() {
  for (const [uid, link] of Object.entries(links)) {
    try {
      const game = await activeGame({
        puuid: link.puuid,
        platform: link.platform,
      });
      if (game) {
        if (!inLiveGame.has(uid)) {
          inLiveGame.add(uid);
          log(`spectator: ${link.riotId} is in a live game`);
          if (LIVE_FEED)
            logLine(
              link.gid,
              `🎮 **${link.riotId}** is in a live game${queueLabel(game)}`,
            );
        }
      } else if (inLiveGame.has(uid)) {
        inLiveGame.delete(uid);
        log(`spectator: ${link.riotId} finished a game — refresh in 90s`);
        if (LIVE_FEED)
          logLine(
            link.gid,
            `🏁 **${link.riotId}** finished their game — rank check in ~90s`,
          );
        setTimeout(() => refreshLink(uid, "game ended"), 90_000);
      }
    } catch (e) {
      if (e.status === 400)
        await healLink(uid, link); // stale puuid (key rotation) — next cycle works
      else
        log(`spectator poll (${link.riotId}) failed (non-fatal): ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  setTimeout(pollLiveGames, SPECTATE_INTERVAL_MS);
}
setTimeout(pollLiveGames, 15_000);

// Hourly safety net: catches ranks that changed while the bot was down or the
// member played invisible/offline. Sequential with spacing — rate-limit kind.
async function sweepLinks() {
  const ids = Object.keys(links);
  if (ids.length) log(`sweep: refreshing ${ids.length} linked account(s)`);
  for (const uid of ids) {
    await refreshLink(uid, "hourly sweep");
    await new Promise((r) => setTimeout(r, 1500));
  }
}
setInterval(sweepLinks, 60 * 60 * 1000);
setTimeout(sweepLinks, 60 * 1000); // one pass shortly after startup

async function handleSetup(d) {
  // 10 sequential role creates can outrun the 3s callback window — defer first.
  await respond(d, { type: 5, data: { flags: 64 } });
  const gid = d.guild_id;
  const roles = await rest("GET", `/guilds/${gid}/roles`);
  const existing = new Set(
    roles.filter((r) => RANK_NAME_SET.has(r.name)).map((r) => r.name),
  );
  const created = [];
  // Reverse order: each new role lands at the bottom of the list, so creating
  // Challenger first leaves the ladder reading top-down Challenger -> Iron.
  for (const rank of [...RANKS].reverse()) {
    if (existing.has(rank.name)) continue;
    await rest("POST", `/guilds/${gid}/roles`, {
      body: rolePayload(rank),
      reason: "/ranksetup",
    });
    created.push(rank.name);
  }
  // Where the guild has the boost-gated ROLE_ICONS feature, stamp the official
  // crest onto each rank role itself (skipped silently elsewhere — the crests
  // still show in the picker via app emojis).
  let iconNote = "";
  if (guildFeatures.get(gid)?.has("ROLE_ICONS")) {
    const fresh = await rest("GET", `/guilds/${gid}/roles`);
    let stamped = 0;
    for (const role of fresh) {
      const rank = RANKS.find((r) => r.name === role.name);
      if (!rank || role.icon) continue;
      const png = readFileSync(
        join(ROOT, "assets", "ranks", `${rank.key}.png`),
      );
      await rest("PATCH", `/guilds/${gid}/roles/${role.id}`, {
        body: { icon: `data:image/png;base64,${png.toString("base64")}` },
        reason: "/ranksetup — official crest as role icon",
      });
      stamped++;
    }
    if (stamped)
      iconNote = ` Stamped the official crest icon onto ${stamped} role${stamped === 1 ? "" : "s"}.`;
  }

  await editOriginal(d, {
    content:
      (created.length
        ? `✅ Created ${created.length} rank role${created.length === 1 ? "" : "s"}: ${created.join(", ")}. They carry zero permissions and sit below my role, so I can manage them.`
        : "✅ All 10 rank roles already exist — nothing to create.") + iconNote,
  });
  if (created.length)
    logLine(
      gid,
      `🛠️ **${displayName(d.member)}** ran /ranksetup — created: ${created.join(", ")}`,
    );
}

// /logsetup #channel [#milestones] — mods pick this SERVER's log channel (and,
// optionally, a separate milestones channel). We prove the bot can actually post
// there before saving, so a silent 403 later can't leave logging quietly broken.
async function handleLogSetup(d) {
  await respond(d, { type: 5, data: { flags: 64 } }); // deferred ephemeral
  const gid = d.guild_id;
  const opts = Object.fromEntries(
    (d.data.options || []).map((o) => [o.name, o.value]),
  );
  const logCh = opts.channel; // CHANNEL option value is the channel id
  const msCh =
    opts.milestones && opts.milestones !== logCh ? opts.milestones : null;

  const postProbe = async (chId, note) => {
    try {
      await rest("POST", `/channels/${chId}/messages`, {
        body: { content: note },
      });
      return null;
    } catch (e) {
      return e.status === 403 ? "I don't have access" : e.message;
    }
  };

  let err = await postProbe(
    logCh,
    `✅ **TLSBot** log channel set by **${displayName(d.member)}** — rank changes${msCh ? "" : " and milestone promotions"} will post here.`,
  );
  if (err)
    return editOriginal(d, {
      content: `⚠️ ${err} in <#${logCh}>. Give my **TLSBot** role **View Channel** + **Send Messages** there, then run /logsetup again — nothing was saved.`,
    });

  if (msCh) {
    err = await postProbe(
      msCh,
      `🏆 **TLSBot** milestone promotions (Master / Grandmaster / Challenger, solo/duo) will post here.`,
    );
    if (err)
      return editOriginal(d, {
        content: `⚠️ The log channel is fine, but ${err.toLowerCase()} in the milestones channel <#${msCh}>. Grant access there and re-run — nothing was saved.`,
      });
  }

  guildCfg[gid] = {
    ...(guildCfg[gid] || {}),
    logChannelId: logCh,
    celebrateChannelId: msCh, // null -> milestones ride the log channel
  };
  saveGuildCfg();
  logChannels.set(gid, logCh); // update the live cache; no restart needed

  return editOriginal(d, {
    content:
      `✅ Done. Rank-change logs → <#${logCh}>` +
      (msCh
        ? `, milestone promotions → <#${msCh}>.`
        : ` (milestone promotions post there too).`),
  });
}

async function onInteraction(d) {
  try {
    if (d.type === 2) {
      // APPLICATION_COMMAND
      if (d.data.name === "verify") return await handleVerify(d);
      if (d.data.name === "ranksetup") return await handleSetup(d);
      if (d.data.name === "verifypanel") return await handleVerifyPanel(d);
      if (d.data.name === "logsetup") return await handleLogSetup(d);
      return;
    }
    if (d.type === 3) {
      // MESSAGE_COMPONENT (button / select)
      if (d.data.custom_id === "verify:start")
        return await handleVerifyStart(d);
      if (d.data.custom_id === "verify:check")
        return await handleVerifyCheck(d);
      // Retired self-report picker: any lingering panel message clicks land here.
      // Answer gracefully instead of failing, and point them at verification.
      if (d.data.custom_id === "rank:pick")
        return await respond(d, {
          type: 4,
          data: {
            flags: 64,
            content:
              "Rank self-report has been turned off — use the **Verify my rank** button on the verify panel to get your real solo/duo rank, pulled straight from Riot.",
          },
        });
      return;
    }
    if (d.type === 5) {
      // MODAL_SUBMIT
      if (d.data.custom_id === "verify:modal")
        return await handleVerifyModal(d);
      return;
    }
  } catch (e) {
    log(`interaction failed: ${e.message}`);
    await errorReply(
      d,
      e.status === 403
        ? "⚠️ I don't have permission for that role change. A mod needs to drag my **TLSBot** role *above* the rank roles (Server Settings → Roles)."
        : "⚠️ Something went wrong — try again in a moment.",
    );
  }
}

// --- gateway --------------------------------------------------------------------
const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
// GUILDS + GUILD_PRESENCES. Presences are privileged: if the portal toggle is
// off, Discord refuses the whole connection (4014) — we then drop the bit and
// reconnect, so the bot never dies over it (presence refresh off, sweep still on).
const INTENTS = 1 | (1 << 8);
let intents = INTENTS;

let ws = null;
let heartbeatTimer = null;
let seq = null;
let acked = true;
let reconnects = 0;

function send(op, d) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op, d }));
}

function startHeartbeat(intervalMs) {
  clearInterval(heartbeatTimer);
  acked = true;
  heartbeatTimer = setInterval(() => {
    if (!acked) {
      log("heartbeat not ACKed — reconnecting");
      try {
        ws.close(4000);
      } catch {
        /* ignore */
      }
      return;
    }
    acked = false;
    send(1, seq);
  }, intervalMs);
}

function identify() {
  send(2, {
    token: creds().token,
    intents,
    properties: { os: "windows", browser: "tlsbot", device: "tlsbot" },
    presence: { status: "online", afk: false, activities: [] },
  });
}

function connect() {
  log(`connecting (attempt ${reconnects + 1})`);
  ws = new WebSocket(GATEWAY);

  ws.addEventListener("open", () => log("gateway open"));

  ws.addEventListener("message", (ev) => {
    let payload;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      return;
    }
    const { op, t, s, d } = payload;
    if (s != null) seq = s;

    if (op === 10) {
      startHeartbeat(d.heartbeat_interval);
      identify();
      return;
    }
    if (op === 11) {
      acked = true;
      return;
    }
    if (op === 1) {
      send(1, seq);
      return;
    }
    if (op === 7 || op === 9) {
      log(`op ${op} — reconnecting`);
      try {
        ws.close(4000);
      } catch {
        /* ignore */
      }
      return;
    }
    if (op !== 0) return;

    if (t === "READY") {
      reconnects = 0;
      log(
        `READY as ${d.user?.username} (uid ${d.user?.id}) — ${d.guilds?.length ?? 0} guild(s)`,
      );
      return;
    }
    if (t === "GUILD_CREATE") {
      log(`guild available: ${d.name} (${d.id})`);
      guildFeatures.set(d.id, new Set(d.features || []));
      cacheLogChannel(d);
      // Seed who's mid-game right now, so a session that ends after startup
      // still triggers a refresh.
      for (const p of d.presences || [])
        if (links[p.user?.id] && playingLeague(p)) inGame.add(p.user.id);
      registerCommands(d.id).catch((e) =>
        log(`command registration failed for ${d.id}: ${e.message}`),
      );
      return;
    }
    if (t === "PRESENCE_UPDATE") {
      onPresence(d);
      return;
    }
    if (t === "INTERACTION_CREATE") {
      onInteraction(d);
      return;
    }
  });

  ws.addEventListener("close", (ev) => {
    clearInterval(heartbeatTimer);
    if (ev.code === 4004) {
      log("auth failed (4004): bad DISCORD_BOT_TOKEN — exiting");
      process.exit(9);
    }
    if (ev.code === 4014 && intents & (1 << 8)) {
      intents &= ~(1 << 8);
      log(
        "disallowed intents (4014): Presence Intent not enabled in the Dev Portal — " +
          "presence-triggered refresh OFF (hourly sweep still on). Enable it under " +
          "Bot -> Privileged Gateway Intents, then restart to turn it on.",
      );
      setTimeout(connect, 1000);
      return;
    }
    reconnects++;
    const backoff = Math.min(5000 * reconnects, 30000);
    log(`closed (code ${ev.code}) — reconnecting in ${backoff}ms`);
    setTimeout(connect, backoff);
  });

  ws.addEventListener("error", (ev) => {
    log(`ws error: ${ev.message ?? "unknown"}`);
    // 'close' fires after 'error' and handles the reconnect.
  });
}

log("starting TLSBot");
claimLock();
await loadAppEmojis();
connect();
