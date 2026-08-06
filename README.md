# TLSBot — League rank self-role bot

Zero-dependency Discord bot (Node 22+, built-in `fetch` + `WebSocket`). Members
prove they own a Riot ID (summoner-icon handshake); the bot pulls their REAL
solo/duo rank from the Riot API, creates the colored rank roles, applies the
matching one, keeps it current on its own, and logs every change to `#bot-logging`.

## Commands

| Command        | Who  | What                                                                   |
| -------------- | ---- | ---------------------------------------------------------------------- |
| `/verify`      | all  | Prove you own a Riot ID (icon handshake), get your REAL solo/duo rank  |
| `/verifypanel` | mods | Post the persistent **verify panel** (pin it) — button → Riot-ID modal |
| `/ranksetup`   | mods | Create any missing rank roles — colored, zero permissions, unhoisted   |

There is deliberately no `/rank` command and **no self-report picker**: a rank
role can only be earned by real verification. Members either run `/verify` or
click **Verify my rank** on the panel; either way the rank comes from the Riot
API (`RIOT_API_KEY` in `.env`, re-read on every call so rotating the 24h dev key
needs no restart), never from the member's imagination.

`/verify` enforces **ownership**, not just existence: it challenges the member
to switch their summoner icon to a random starter icon (never the one they're
wearing), then re-checks via summoner-v4 before applying the rank — so claiming
someone else's account fails. Challenges live in memory with a 15-minute TTL;
the icon can be switched back immediately after.

## Setup

1. Copy `.env.example` to `.env`, fill in the bot token + application ID.
2. Invite the bot (Manage Roles + View Channels + Send Messages — never Admin):
   `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=268438528`
3. `node bot.mjs` — commands auto-register in every server the bot joins
   (GUILD_CREATE), so there is no separate registration step.

## Design notes

- **Official Riot crests everywhere** — verification replies, confirmations, and
  log lines use Riot's ranked emblems (from the official developer asset pack) uploaded as
  **application-owned emojis** (`scripts/upload-emojis.mjs`, idempotent). App
  emojis work in ANY server with zero boost requirement and consume no guild
  emoji slots. Where a guild has the boost-gated `ROLE_ICONS` feature (level 2),
  `/ranksetup` also stamps the crest onto each role itself; elsewhere that step
  is skipped silently.
- **No privileged intents** — slash commands + components aren't intent-gated;
  the bot never reads messages or the member list.
- **Rank roles carry `permissions: "0"`** and are created _by_ the bot, so they
  land below the bot's own role and hierarchy always works. If roles were made by
  hand above the bot's role, verification replies with the exact drag-to-fix hint.
- **Every role change carries `X-Audit-Log-Reason`** — attributable in the
  server's audit log, plus a human-readable line in `#bot-logging`.
- **Ranks stay current on their own** — a successful `/verify` stores a link
  (`.links.json`, flat file — no database at this scale) and from then on,
  three layers keep it fresh, fastest first: (1) **spectator polling** — the
  universal Riot-side game detector: every ~2 min the bot asks spectator-v5
  whether each linked account is in a live game; an in-game → not-in-game
  transition refreshes the rank ~90s later. Works for everyone, no Discord
  settings involved. (2) **Discord presence** (privileged intent, portal
  toggle) — a free accelerator for members who share game activity; opt-in on
  the member's side, never relied on. (3) **hourly sweep** — catches whatever
  slipped past (bot downtime, LP from dodges). Tier changes swap the role;
  changes post 📈/📉 lines to `#bot-logging` (currently verbose incl. LP-only,
  for testing). No `/update` command — the automation makes it redundant. Riot
  has no push API; "realtime" is well-aimed polling.
- **🎉 Promotion celebrations** — a tier promotion posts a congratulations
  (with @mention) to `CELEBRATE_CHANNEL_ID` (default: the log channel), **once
  per tier per split**: demote-then-repromote stays quiet (Goonmaster's spec).
  Dedup state lives on the member's link under the current split key. **Split
  rollover is automatic**: a once-daily canary checks the Challenger ladder
  size (~300 all split, near-zero right after a reset); on collapse the bot
  rolls its split key, resets the slate, and announces it in the log channel.
  `SPLIT_KEY` in `.env` is a manual override that disables auto-detection.
- **Flex queue** — tracked unconditionally (same API call as solo, zero extra
  cost) but **silent by default**: state stays current in `.links.json` with no
  roles, log lines, or celebrations (owner's call, 2026-07-30: "Let's ignore
  flex rank"). Because the data never goes stale, changing his mind later is a
  flag flip with no backfill: `FLEX_VISIBLE=1` enables `(Flex)`-tagged logs +
  separately-deduped 🎉s; `FLEX_ROLES=1` adds a parallel `<Tier> (Flex)` role
  ladder that never displaces solo roles.
- `scripts/whoami.mjs` — token + guild sanity check. `register.mjs` — manual
  command re-registration (recovery only; normally automatic).

## Legal

TLSBot was created under Riot Games' "Legal Jibber Jabber" policy using assets
owned by Riot Games. Riot Games does not endorse or sponsor this project.
