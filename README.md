# TLSBot — League rank self-role bot

Zero-dependency Discord bot (Node 22+, built-in `fetch` + `WebSocket`). Members pick
their League of Legends rank from a select menu; the bot creates the colored rank
roles, swaps the old rank out, and logs every change to `#bot-logging`.

## Commands

| Command      | Who  | What                                                                 |
| ------------ | ---- | -------------------------------------------------------------------- |
| `/rank`      | all  | Ephemeral rank picker (Iron → Challenger, plus "Clear my rank")      |
| `/ranksetup` | mods | Create any missing rank roles — colored, zero permissions, unhoisted |
| `/rankpanel` | mods | Post a persistent picker panel in the current channel (pin it)       |

## Setup

1. Copy `.env.example` to `.env`, fill in the bot token + application ID.
2. Invite the bot (Manage Roles + View Channels + Send Messages — never Admin):
   `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=268438528`
3. `node bot.mjs` — commands auto-register in every server the bot joins
   (GUILD_CREATE), so there is no separate registration step.

## Design notes

- **No privileged intents** — slash commands + components aren't intent-gated;
  the bot never reads messages or the member list.
- **Rank roles carry `permissions: "0"`** and are created _by_ the bot, so they
  land below the bot's own role and hierarchy always works. If roles were made by
  hand above the bot's role, `/rank` replies with the exact drag-to-fix hint.
- **Every role change carries `X-Audit-Log-Reason`** — attributable in the
  server's audit log, plus a human-readable line in `#bot-logging`.
- `scripts/whoami.mjs` — token + guild sanity check. `register.mjs` — manual
  command re-registration (recovery only; normally automatic).
