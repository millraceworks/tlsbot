#!/usr/bin/env node
// bot.mjs — TLSBot: League rank self-role bot. Zero-dep (Node 22+, built-in WebSocket).
//
// Gateway client (hello -> heartbeat -> identify -> READY -> dispatch), interactions
// answered via REST callbacks. Commands are (re-)registered idempotently per guild on
// every GUILD_CREATE, so inviting the bot to a server is the ONLY setup step.
//
//   /verify     all  — Riot-ID rank verification: pulls the REAL solo/duo rank
//                      from the Riot API and applies the crest role
//   /ranksetup  mods — create any missing rank roles (colored, zero permissions)
//   /rankpanel  mods — post the persistent picker panel (self-report fallback;
//                      there is deliberately no /rank command)
//
// The picker shows Riot's official rank crests via APPLICATION-owned emojis
// (uploaded once by scripts/upload-emojis.mjs). When a guild has the boost-gated
// ROLE_ICONS feature, /ranksetup also stamps the crest onto each role itself.
//
// Role changes carry X-Audit-Log-Reason, and each change is echoed to #bot-logging
// (or LOG_CHANNEL_ID) when such a channel exists.
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
import { COMMANDS } from "./lib/commands.mjs";
import {
  lookupAccount,
  getSummoner,
  soloEntry,
  profileIconUrl,
} from "./lib/riot.mjs";

const { appId, logChannelId } = creds();

const log = (m) =>
  process.stderr.write(`[tlsbot ${new Date().toISOString()}] ${m}\n`);

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

// Component-shaped emoji ({id} = custom crest, {name} = unicode fallback), and
// the in-message-text form of the same.
const emojiObj = (rank) =>
  appEmoji.has(rank.key)
    ? { id: appEmoji.get(rank.key), name: `rank_${rank.key}` }
    : { name: rank.emoji };
const emojiText = (rank) =>
  appEmoji.has(rank.key)
    ? `<:rank_${rank.key}:${appEmoji.get(rank.key)}>`
    : rank.emoji;

// --- logging to #bot-logging ----------------------------------------------------
const logChannels = new Map(); // guildId -> channelId | null
const guildFeatures = new Map(); // guildId -> Set of feature flags (ROLE_ICONS…)

function cacheLogChannel(guild) {
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

const selectRow = () => ({
  type: 1,
  components: [
    {
      type: 3,
      custom_id: "rank:pick",
      placeholder: "Select your rank…",
      options: [
        ...RANKS.map((r) => ({
          label: r.name,
          value: r.key,
          emoji: emojiObj(r),
        })),
        { label: "Clear my rank", value: "clear", emoji: { name: "🧹" } },
      ],
    },
  ],
});

// --- rank-role core (shared by the panel picker and /verify) --------------------
// Swap the member onto the target rank role: remove every other rank role they
// hold, add the target (auto-creating it if a mod deleted it), return what was.
async function swapToRank(gid, member, rankKey, reason) {
  const uid = member.user.id;
  const rank = RANK_BY_KEY.get(rankKey);
  if (!rank) throw new Error(`unknown rank value: ${rankKey}`);
  const roles = await rest("GET", `/guilds/${gid}/roles`);
  const rankRoles = roles.filter((r) => RANK_NAME_SET.has(r.name));
  const have = new Set(member.roles);
  const current = rankRoles.filter((r) => have.has(r.id));
  let target = rankRoles.find((r) => r.name === rank.name);
  if (!target)
    target = await rest("POST", `/guilds/${gid}/roles`, {
      body: rolePayload(rank),
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
async function handlePick(d) {
  const gid = d.guild_id;
  const member = d.member;
  const uid = member.user.id;
  const value = d.data.values?.[0];

  let confirmation;
  let wasNames = [];
  if (value === "clear") {
    const roles = await rest("GET", `/guilds/${gid}/roles`);
    const have = new Set(member.roles);
    const current = roles.filter(
      (r) => RANK_NAME_SET.has(r.name) && have.has(r.id),
    );
    for (const r of current)
      await rest("DELETE", `/guilds/${gid}/members/${uid}/roles/${r.id}`, {
        reason: "rank cleared via panel",
      });
    wasNames = current.map((r) => r.name);
    confirmation = current.length
      ? "🧹 Rank cleared."
      : "You had no rank role to clear.";
  } else {
    const { rank, was } = await swapToRank(
      gid,
      member,
      value,
      "rank picked via panel",
    );
    wasNames = was;
    confirmation = `${emojiText(rank)} You're now **${rank.name}**.`;
  }

  // From the ephemeral /rank flow: update that message in place. From a shared
  // panel: never touch the panel — send a fresh ephemeral confirmation instead.
  const ephemeralSource = ((d.message?.flags ?? 0) & 64) !== 0;
  await respond(
    d,
    ephemeralSource
      ? { type: 7, data: { content: confirmation, components: [] } }
      : { type: 4, data: { flags: 64, content: confirmation } },
  );

  const was = wasNames.join(", ");
  logLine(
    gid,
    value === "clear"
      ? `🧹 **${displayName(member)}** cleared their rank${was ? ` (was ${was})` : ""}`
      : `${emojiText(RANK_BY_KEY.get(value))} **${displayName(member)}** → **${RANK_BY_KEY.get(value).name}**${
          was && was !== RANK_BY_KEY.get(value).name ? ` (was ${was})` : ""
        }`,
  );
}

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

async function handleVerify(d) {
  // Riot round-trips can outrun the 3s callback window — defer immediately.
  await respond(d, { type: 5, data: { flags: 64 } });
  const opts = Object.fromEntries(
    (d.data.options || []).map((o) => [o.name, o.value]),
  );
  const platform = opts.region || "na1";
  const raw = String(opts.riot_id || "").trim();
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
  const solo = await soloEntry({ puuid, platform });
  if (!solo)
    return edit({
      content: `✅ Ownership of **${riotId}** verified — but no ranked solo/duo entry this season, so there's no rank role to apply. Play placements and re-run \`/verify\`.`,
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

async function handlePanel(d) {
  await respond(d, {
    type: 4,
    data: {
      content:
        "**Choose your League rank**\nPick from the menu below — your old rank role is swapped out automatically. Come back here any time to change it.",
      components: [selectRow()],
    },
  });
  logLine(
    d.guild_id,
    `📌 **${displayName(d.member)}** posted a rank panel in <#${d.channel_id}>`,
  );
}

async function onInteraction(d) {
  try {
    if (d.type === 2) {
      if (d.data.name === "verify") return await handleVerify(d);
      if (d.data.name === "ranksetup") return await handleSetup(d);
      if (d.data.name === "rankpanel") return await handlePanel(d);
      return;
    }
    if (d.type === 3 && d.data.custom_id === "rank:pick")
      return await handlePick(d);
    if (d.type === 3 && d.data.custom_id === "verify:check")
      return await handleVerifyCheck(d);
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
const INTENTS = 1; // GUILDS only — no privileged intents, interactions aren't gated

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
    intents: INTENTS,
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
      registerCommands(d.id).catch((e) =>
        log(`command registration failed for ${d.id}: ${e.message}`),
      );
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
