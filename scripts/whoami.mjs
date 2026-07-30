#!/usr/bin/env node
// scripts/whoami.mjs — sanity check: does the token work, and which guilds is the
// bot in? Run any time; read-only.
import { rest } from "../lib/rest.mjs";

const me = await rest("GET", "/users/@me");
console.log(`bot: ${me.username}#${me.discriminator} (uid ${me.id})`);
const guilds = await rest("GET", "/users/@me/guilds");
if (!guilds.length) console.log("guilds: none yet — invite link not clicked");
for (const g of guilds) console.log(`guild: ${g.name} (${g.id})`);
