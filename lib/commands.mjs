// lib/commands.mjs — the slash-command set, shared by bot.mjs (auto-registration
// on GUILD_CREATE) and register.mjs (manual recovery). The VERIFY panel is the
// member interface — there is deliberately no /rank command, and no self-report
// picker: a rank role can ONLY be earned by real Riot verification.
const MANAGE_ROLES = "268435456";

// League platform routing values, labeled the way players say them.
export const REGIONS = [
  ["NA", "na1"],
  ["EUW", "euw1"],
  ["EUNE", "eun1"],
  ["KR", "kr"],
  ["BR", "br1"],
  ["LAN", "la1"],
  ["LAS", "la2"],
  ["OCE", "oc1"],
  ["TR", "tr1"],
  ["RU", "ru"],
  ["JP", "jp1"],
  ["SG", "sg2"],
  ["TW", "tw2"],
  ["VN", "vn2"],
  ["ME", "me1"],
];

export const COMMANDS = [
  {
    name: "verify",
    type: 1,
    description:
      "Verify your real League rank via your Riot ID (crest role applied)",
    options: [
      {
        type: 3,
        name: "riot_id",
        description: "Your Riot ID, e.g. Faker#KR1",
        required: true,
      },
      {
        type: 3,
        name: "region",
        description: "Your League server (default NA)",
        required: false,
        choices: REGIONS.map(([name, value]) => ({ name, value })),
      },
    ],
  },
  {
    name: "ranksetup",
    type: 1,
    description: "Create the rank roles (mods only)",
    default_member_permissions: MANAGE_ROLES,
  },
  {
    name: "verifypanel",
    type: 1,
    description:
      "Post the verify panel (button -> Riot-ID modal) in this channel (mods only)",
    default_member_permissions: MANAGE_ROLES,
  },
  {
    // Message context-menu (right-click a message -> Apps): the "copy your post and
    // repost it" path. Components can't live on a human's message, so the bot
    // re-posts the targeted message's text with the Verify button attached. No
    // description field — Discord rejects it on context-menu (type 2/3) commands.
    name: "Add Verify panel",
    type: 3, // MESSAGE
    default_member_permissions: MANAGE_ROLES,
  },
  {
    name: "logsetup",
    type: 1,
    description:
      "Set this server's log channel (and optional milestones channel) — mods only",
    default_member_permissions: MANAGE_ROLES,
    options: [
      {
        type: 7, // CHANNEL
        name: "channel",
        description:
          "Channel for rank-change logs (and milestones, unless a separate one is set)",
        required: true,
        channel_types: [0, 5], // GUILD_TEXT, GUILD_ANNOUNCEMENT
      },
      {
        type: 7,
        name: "milestones",
        description:
          "Optional separate channel for Master/GM/Challenger milestone posts",
        required: false,
        channel_types: [0, 5],
      },
    ],
  },
];
