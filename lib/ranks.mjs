// lib/ranks.mjs — the League ladder, colors tuned to the in-game tier palette.
// Rank roles are cosmetic: permissions "0", never hoisted, never mentionable.
export const RANKS = [
  { key: "iron", name: "Iron", color: 0x5b5a56, emoji: "⛓️" },
  { key: "bronze", name: "Bronze", color: 0xa05c2f, emoji: "🥉" },
  { key: "silver", name: "Silver", color: 0x9faabf, emoji: "🥈" },
  { key: "gold", name: "Gold", color: 0xe7b94b, emoji: "🥇" },
  { key: "platinum", name: "Platinum", color: 0x4fa3a5, emoji: "💠" },
  { key: "emerald", name: "Emerald", color: 0x2aad60, emoji: "💚" },
  { key: "diamond", name: "Diamond", color: 0x5ca8e8, emoji: "💎" },
  { key: "master", name: "Master", color: 0xa85cd6, emoji: "🔮" },
  { key: "grandmaster", name: "Grandmaster", color: 0xd64545, emoji: "🔥" },
  { key: "challenger", name: "Challenger", color: 0xf4c874, emoji: "👑" },
];

export const RANK_BY_KEY = new Map(RANKS.map((r) => [r.key, r]));
export const RANK_NAME_SET = new Set(RANKS.map((r) => r.name));

export const rolePayload = (rank) => ({
  name: rank.name,
  color: rank.color,
  permissions: "0",
  hoist: false,
  mentionable: false,
});
