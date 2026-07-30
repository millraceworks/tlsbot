#!/usr/bin/env node
// register.mjs — manually (re-)register the slash commands in every guild the bot
// is in. Normally unnecessary: bot.mjs auto-registers on GUILD_CREATE. Kept as a
// standalone for recovery / offline registration.
import { creds } from "./lib/env.mjs";
import { rest } from "./lib/rest.mjs";

const { appId } = creds();
const MANAGE_ROLES = "268435456";
const COMMANDS = [
  { name: "rank", type: 1, description: "Pick your League rank role" },
  {
    name: "ranksetup",
    type: 1,
    description: "Create the rank roles (mods only)",
    default_member_permissions: MANAGE_ROLES,
  },
  {
    name: "rankpanel",
    type: 1,
    description: "Post a rank-picker panel in this channel (mods only)",
    default_member_permissions: MANAGE_ROLES,
  },
];

const guilds = await rest("GET", "/users/@me/guilds");
if (!guilds.length) {
  console.log("bot is in no guilds yet — click the invite link first");
  process.exit(0);
}
for (const g of guilds) {
  await rest("PUT", `/applications/${appId}/guilds/${g.id}/commands`, {
    body: COMMANDS,
  });
  console.log(`registered ${COMMANDS.length} commands in ${g.name} (${g.id})`);
}
