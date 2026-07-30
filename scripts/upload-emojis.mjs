#!/usr/bin/env node
// scripts/upload-emojis.mjs — upload the rank crests in assets/ranks/ as
// APPLICATION-owned emojis (usable by this bot in any server, no guild emoji
// slots consumed). Idempotent: existing rank_<key> emojis are left alone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { creds, ROOT } from "../lib/env.mjs";
import { rest } from "../lib/rest.mjs";
import { RANKS } from "../lib/ranks.mjs";

const { appId } = creds();

// LIST returns { items: [...] } for app emojis (unlike guild emojis).
const listing = await rest("GET", `/applications/${appId}/emojis`);
const existing = new Map(
  (Array.isArray(listing) ? listing : listing.items || []).map((e) => [
    e.name,
    e.id,
  ]),
);

for (const rank of RANKS) {
  const name = `rank_${rank.key}`;
  if (existing.has(name)) {
    console.log(`skip  ${name} (already uploaded, id ${existing.get(name)})`);
    continue;
  }
  const png = readFileSync(join(ROOT, "assets", "ranks", `${rank.key}.png`));
  const created = await rest("POST", `/applications/${appId}/emojis`, {
    body: { name, image: `data:image/png;base64,${png.toString("base64")}` },
  });
  console.log(`upload ${name} -> id ${created.id}`);
}
console.log("done");
