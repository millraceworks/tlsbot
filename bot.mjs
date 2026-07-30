#!/usr/bin/env node
// bot.mjs — TLSBot: League rank self-role bot. Zero-dep (Node 22+, built-in WebSocket).
//
// Gateway client (hello -> heartbeat -> identify -> READY -> dispatch), interactions
// answered via REST callbacks. Commands are (re-)registered idempotently per guild on
// every GUILD_CREATE, so inviting the bot to a server is the ONLY setup step.
//
//   /ranksetup  mods — create any missing rank roles (colored, zero permissions)
//   /rankpanel  mods — post the persistent picker panel (the ONLY member
//                      interface; there is deliberately no /rank command)
//
// The picker shows Riot's official rank crests via APPLICATION-owned emojis
// (uploaded once by scripts/upload-emojis.mjs). When a guild has the boost-gated
// ROLE_ICONS feature, /ranksetup also stamps the crest onto each role itself.
//
// Role changes carry X-Audit-Log-Reason, and each change is echoed to #bot-logging
// (or LOG_CHANNEL_ID) when such a channel exists.
import { readFileSync } from "node:fs";
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

const { appId, logChannelId } = creds();

const log = (m) =>
  process.stderr.write(`[tlsbot ${new Date().toISOString()}] ${m}\n`);

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

// Ephemeral error to the user: try the callback; if we already responded, fall
// back to a followup so the user is never left with "interaction failed".
async function errorReply(d, content) {
  try {
    await respond(d, { type: 4, data: { flags: 64, content } });
  } catch {
    await rest("POST", `/webhooks/${appId}/${d.token}`, {
      body: { flags: 64, content },
    }).catch((e) => log(`error-reply failed: ${e.message}`));
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

// --- handlers -------------------------------------------------------------------
async function handlePick(d) {
  const gid = d.guild_id;
  const member = d.member;
  const uid = member.user.id;
  const value = d.data.values?.[0];

  const roles = await rest("GET", `/guilds/${gid}/roles`);
  const rankRoles = roles.filter((r) => RANK_NAME_SET.has(r.name));
  const have = new Set(member.roles);
  const current = rankRoles.filter((r) => have.has(r.id));

  let confirmation;
  if (value === "clear") {
    for (const r of current)
      await rest("DELETE", `/guilds/${gid}/members/${uid}/roles/${r.id}`, {
        reason: "rank cleared via /rank",
      });
    confirmation = current.length
      ? "🧹 Rank cleared."
      : "You had no rank role to clear.";
  } else {
    const rank = RANK_BY_KEY.get(value);
    if (!rank) throw new Error(`unknown rank value: ${value}`);
    let target = rankRoles.find((r) => r.name === rank.name);
    if (!target)
      target = await rest("POST", `/guilds/${gid}/roles`, {
        body: rolePayload(rank),
        reason: "rank role auto-created by /rank",
      });
    for (const r of current)
      if (r.id !== target.id)
        await rest("DELETE", `/guilds/${gid}/members/${uid}/roles/${r.id}`, {
          reason: "rank swap via /rank",
        });
    if (!have.has(target.id))
      await rest("PUT", `/guilds/${gid}/members/${uid}/roles/${target.id}`, {
        reason: "rank set via /rank",
      });
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

  const was = current.map((r) => r.name).join(", ");
  logLine(
    gid,
    value === "clear"
      ? `🧹 **${displayName(member)}** cleared their rank${was ? ` (was ${was})` : ""}`
      : `${emojiText(RANK_BY_KEY.get(value))} **${displayName(member)}** → **${RANK_BY_KEY.get(value).name}**${
          was && was !== RANK_BY_KEY.get(value).name ? ` (was ${was})` : ""
        }`,
  );
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
      if (d.data.name === "ranksetup") return await handleSetup(d);
      if (d.data.name === "rankpanel") return await handlePanel(d);
      return;
    }
    if (d.type === 3 && d.data.custom_id === "rank:pick")
      return await handlePick(d);
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
      process.exit(1);
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
await loadAppEmojis();
connect();
