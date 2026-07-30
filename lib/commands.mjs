// lib/commands.mjs — the slash-command set, shared by bot.mjs (auto-registration
// on GUILD_CREATE) and register.mjs (manual recovery). The panel IS the member
// interface — there is deliberately no /rank command (owner preference).
const MANAGE_ROLES = "268435456";

export const COMMANDS = [
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
