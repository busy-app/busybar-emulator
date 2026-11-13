// The resources of `busy-emulator mcp`: the emulator's own texts, so that a chat client without the project open has
// the cheat sheet too. Both are made from what the emulator already says; nothing is read from the disk.
import { agentsSection } from "../../projects/template-fixes.mjs";

const GUIDE = [
  "# Making a BUSY Bar app with BUSY Bar Emulator's tools, up to the app catalog",
  "",
  "BUSY Bar is a desk device with a front display of 72x16 color pixels, a back display of 160x80 gray ones, a Start button, a small Back button and a wheel that turns and clicks (OK). Its apps are JavaScript (TypeScript in the template) that the firmware runs; their settings are set on the BUSY Bar's web page, as the BUSY Bar has no keyboard. The emulator runs the BUSY Bar's own firmware on this computer.",
  "",
  "## Make it",
  "",
  "1. `status`; if the emulator is not running, `start`.",
  "2. `create_app` with an absolute path of a new folder, a `name` and a one-line `description`. Its answer names the `folder`: every other project tool takes that path.",
  "3. Write the app in `src/` of the folder (`src/main.ts`, settings in `src/appmeta/settings.json`). The project's `AGENTS.md` says how; the resource busy-emulator://guide/project is its emulator section.",
  "4. `refresh` builds, installs and starts it. `tool_failed`: the build's words are in `output`. `app_crashed`: the script's error is in `error`, the rest in `logs`.",
  "5. `screenshot` shows the front display enlarged; `display: \"back\"` the back one. `press` presses the buttons, `time` with `action: \"advance\"` lets a timer run out at once, `settings_set` with `restart: true` tries other settings. `record` makes a short clip for a post.",
  "",
  "## Get it ready for the catalog (stage 1: nothing is sent)",
  "",
  "6. `icon` with `text` (one or two letters) makes the app's icons.",
  "7. `catalog_texts` writes the name and the catalog's texts: `category` (one id of `rules.categories`), `short_description` (10 to 120 characters), `description` (50 to 4000), `changelog`. Write what the app is; ask the person what you cannot know.",
  "8. `publish` with `step: \"screenshots\"` and `take: \"front\"` (and `\"back\"` when the app draws there) while the app shows its best screen; the first front one is the catalog's cover.",
  "9. `publish` with `step: \"readme\"`, `readme_action: \"set\"`, `intro` and `controls`: How to use, one row per control of the BUSY Bar (`Start`, `Wheel turn`, `Wheel press`, `Back`) with what it does in this app, plus `usage`, a sentence after them.",
  "10. Ask the person which license (MIT, Apache-2.0, GPL-3.0, or their own: `license: \"other\"` with `from`, the file in the project) and who holds the copyright. Then `publish` with `step: \"prepare\"` and `license`: it writes LICENSE, .gitignore and the README, builds, runs the catalog's checks and writes submission/. `check_failed`: fix what each failure's `change` says and prepare again. `publish` `step: \"status\"` says where every step stands.",
  "",
  "## Send it (stage 2: the person confirms each step in the emulator's window)",
  "",
  "11. `publish` `step: \"signin\"`. `choose_account` lists GitHub CLI's `accounts` on this computer: ask the person which one, then `signin` with `use_existing: true` and `user`. Or `new_account: true`: the answer has `userCode` and `verificationUri`; give them to the person, and once they say they entered it, `signin` with `wait: true`.",
  "12. `publish` `step: \"push\"`: the project's files go to a new public repository of the person's account, after they click Publish in the emulator's dialog (the upload's progress comes as progress notifications when your client asks for them).",
  "13. Ask the person how AI was used (none, partly, full), then `publish` `step: \"pr\"` with `ai`. The emulator shows the catalog's author checklist; the person reads and ticks it there, then ticks or leaves each optional item (such as the BUSY JS Apps Contest's) in its own dialog, and clicks Send. Tell the person about the optional items before; never tick them. The answer's `url` is the pull request, and `optional` says which optional items it ticks.",
  "",
  "Only the person can: trust a folder the emulator did not create (`busy-emulator trust <folder>` in a terminal), sign in to GitHub and choose the account, choose the license and the AI usage, confirm the push and the pull request, tick the author checklist and its optional items. Ask them; never choose for them, and never tick or confirm anything for them. `refused`: they chose Cancel; do not ask again unless they say so.",
  "",
  "Every answer has `ok`; a failure has `code`, `message` and `hint`. The hints name commands of the command line `busy-emulator`: each has the tool of the same name here (`create` is create_app, `dev --once` is refresh, `settings get` and `settings set` are settings_get and settings_set, `catalog-texts` is catalog_texts, `publish <step>` is publish with that `step`). `allow-local` has no tool: when an app's log says a request to this computer was refused, ask the person to run `busy-emulator allow-local <port>` in a terminal. Settings marked `sensitive` in settings.json read as `(hidden)`; settings_set still sets them.",
  "",
  "The emulated BUSY Bar answers the BUSY Bar's own HTTP API at the `url` status gives: the person's own busy-cli works against it too (`npx busy-cli app install --addr 127.0.0.1:<port>`).",
  "",
  "The tools take only the project folders the emulator knows (the projects tool lists them): those create_app made and those the person trusted. Building a project runs its code on this computer, so a folder made some other way (cloned, copied, made with npm create) is refused with `untrusted_project`. Only the person can trust it: they run `busy-emulator trust <folder>` in a terminal and answer the emulator's dialog. No tool here trusts a folder, reads or writes files the tools do not name, or runs other programs.",
].join("\n");

export const RESOURCES = [
  {
    uri: "busy-emulator://guide/start",
    name: "start",
    title: "How to make a BUSY Bar app with these tools and send it to the catalog",
    description: "The steps from an idea to an app running on the emulated BUSY Bar, then to the catalog's pull request, what only the person may do, and what the answers and errors mean. Read it first.",
    mimeType: "text/markdown",
    text: () => GUIDE,
  },
  {
    uri: "busy-emulator://guide/project",
    name: "project",
    title: "The emulator's section of a project's AGENTS.md",
    description: "What create_app writes into the project's AGENTS.md: the commands, the format of settings.json and how an app reads its settings.",
    mimeType: "text/markdown",
    text: () => agentsSection(),
  },
];

export function resourceList() {
  return RESOURCES.map(({ uri, name, title, description, mimeType }) => ({ uri, name, title, description, mimeType }));
}

export function readResource(uri) {
  const resource = RESOURCES.find((one) => one.uri === uri);
  return resource ? { uri, mimeType: resource.mimeType, text: resource.text() } : null;
}
