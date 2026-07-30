#!/usr/bin/env node
// scripts/lookup.mjs — CLI probe for the /verify chain without Discord:
//   node scripts/lookup.mjs "Name#TAG" [platform]
// Prints the resolved account and the ranked solo/duo entry (or unranked).
import { lookupSoloRank } from "../lib/riot.mjs";

const raw = process.argv[2];
const platform = process.argv[3] || "na1";
if (!raw || !raw.includes("#")) {
  console.error('usage: node scripts/lookup.mjs "Name#TAG" [platform]');
  process.exit(2);
}
// exitCode (not process.exit) below: an abrupt exit with the fetch socket still
// open trips a libuv assertion on Windows and reports a bogus 127.
const hash = raw.indexOf("#");
const gameName = raw.slice(0, hash).trim();
const tagLine = raw.slice(hash + 1).trim();

try {
  const { account, solo } = await lookupSoloRank({
    gameName,
    tagLine,
    platform,
  });
  console.log(
    `account: ${account.gameName}#${account.tagLine} (puuid ${account.puuid.slice(0, 12)}…)`,
  );
  console.log(
    solo
      ? `solo/duo: ${solo.tier} ${solo.rank} — ${solo.leaguePoints} LP (${solo.wins}W/${solo.losses}L)`
      : "solo/duo: unranked this season",
  );
} catch (e) {
  console.error(`lookup failed: ${e.message}`);
  process.exitCode = 1;
}
