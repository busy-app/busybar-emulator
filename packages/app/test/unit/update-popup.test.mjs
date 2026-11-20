// The update's pop-up (update-popup.mjs): once per version in a run, again a day after if the app stays open, never
// while the app is busy or in a run that shows no pop-up; and the release's notes it shows whole, as the app reads and
// keeps them (update-check.mjs parseReleaseNotes, storedNotes).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createSettings, createUpdateCheck, NOTES_CHARS, NOTES_DEPTH, NOTES_ENTRIES, NOTES_LINE, notesInAnswer, parseReleaseNotes, storedNotes } from "../../src/update-check.mjs";
import { ASK_AGAIN_MS, BUSY_RETRY_MS, createUpdatePopup } from "../../src/update-popup.mjs";

function setup({ enabled = true, state = { state: "available", version: "0.1.0-beta.2", current: "0.1.0-beta.1", canInstall: true }, notice = null } = {}) {
  const time = { now: 1_000_000 };
  const o = { state, busy: null, notice };
  const popup = createUpdatePopup({ enabled, state: () => o.state, notice: () => o.notice, busy: () => o.busy, now: () => time.now });
  return { popup, o, time };
}

test("a version offered is shown once in a run, and again a day later if the person said Later", () => {
  const { popup, time } = setup({ notice: { version: "0.1.0-beta.2", notes: { blocks: [{ type: "paragraph", text: "Fixes." }], more: false } } });
  const first = popup.ask();
  assert.deepEqual(first, { show: true, version: "0.1.0-beta.2", current: "0.1.0-beta.1", canInstall: true, page: "https://github.com/busy-app/busybar-emulator/releases/tag/v0.1.0-beta.2", notes: { blocks: [{ type: "paragraph", text: "Fixes." }], more: false } });
  const second = popup.ask();
  assert.equal(second.show, false);
  assert.equal(second.retryMs, ASK_AGAIN_MS);
  time.now += ASK_AGAIN_MS - 5000;
  assert.equal(popup.ask().show, false);
  time.now += 5000;
  assert.equal(popup.ask().show, true, "a day on, it is offered again");
});

test("a newer version found while the app is open is offered too", () => {
  const { popup, o } = setup();
  assert.equal(popup.ask().show, true);
  o.state = { ...o.state, version: "0.1.0-beta.3" };
  const next = popup.ask();
  assert.equal(next.show, true);
  assert.equal(next.version, "0.1.0-beta.3");
});

test("not while the app is busy: the window asks again soon; and only while a version is offered", () => {
  const { popup, o } = setup();
  o.busy = "a build is running in the window";
  assert.deepEqual(popup.ask(), { show: false, retryMs: BUSY_RETRY_MS });
  o.busy = null;
  for (const state of ["none", "downloading", "ready", "failed"]) {
    o.state = { ...o.state, state };
    assert.deepEqual(popup.ask(), { show: false, retryMs: null }, state);
  }
  o.state = { ...o.state, state: "available" };
  assert.equal(popup.ask().show, true, "nothing was spent on the refusals");
});

test("where the copy cannot update itself, the answer says why", () => {
  const { popup } = setup({ state: { state: "available", version: "0.2.0", current: "0.1.0", canInstall: false, why: "This copy runs from Downloads: move it to Applications first." } });
  const answer = popup.ask();
  assert.equal(answer.canInstall, false);
  assert.equal(answer.why, "This copy runs from Downloads: move it to Applications first.");
  assert.equal(answer.notes, undefined, "no notes of another version");
});

test("a run without the pop-up never shows it", () => {
  const { popup } = setup({ enabled: false });
  assert.deepEqual(popup.ask(), { show: false, retryMs: null });
  assert.deepEqual(popup.shown, {});
});

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const list = (...items) => ({ type: "list", ordered: false, items });
const item = (text, ...details) => (details.length ? { text, list: { ordered: false, items: details.map((one) => (typeof one === "string" ? { text: one } : one)) } } : { text });
const feature = (lead, text, ...details) => ({ ...item(text, ...details), lead });
/** Every string of the notes, in the order they are shown. */
const words = (notes) => JSON.stringify(notes).match(/"(?:lead|text)":"(?:[^"\\]|\\.)*"/g).map((one) => JSON.parse(one.slice(one.indexOf(":") + 1)));

test("the real notes of 0.1.0-beta.6 come whole, up to their Files: every feature with its nested details, nothing cut", () => {
  const body = fixture("release-notes-v0.1.0-beta.6.md");
  assert.ok(body.startsWith("- **Firmware 1.4.1.**") && body.includes("\n## Files\n"), "the fixture is the release's body as GitHub has it");
  const notes = parseReleaseNotes(body);
  assert.deepEqual(notes, {
    blocks: [
      list(
        feature("Firmware 1.4.1.", "The emulated BUSY Bar runs the firmware BUSY Bars get with auto-update.", "Switch to 1.3.1 and back in the window or with busy-emulator firmware use previous. Apps, their data and settings stay.", "Apps can keep files with /api/storage and log with console.warn (needs api_version 27.15.0).", "The emulator tells you when an app needs a newer firmware than the one running."),
        feature("Cleaner window.", "", "The BUSY Bar's card fits in one row.", "Buttons look the same everywhere.", "A failed update is one clear button."),
        feature("LEDs beside Start / Pause", "blink and go dark as on a real BUSY Bar. They no longer stay lit after a notification."),
        feature("Fixes", "", "An empty response header no longer restarts the BUSY Bar (#1).", "busy-emulator install works again."),
        // A detail wrapped onto a second line is one detail; a word in a code span stays as written, though it looks like a tag.
        feature("New data folder layout", "on first start. Older versions of the emulator can't open it after that.", "The firmware dev is gone: 1.4.1 has everything it had. Apps installed on it are set aside, untouched, in set-aside/format-1-bars-<time>/."),
      ),
    ],
    more: false,
  });
  assert.ok(!words(notes).some((one) => one.includes("…")), "nothing is cut");
  assert.ok(!JSON.stringify(notes).includes("busybar-emulator-mac-arm64.dmg"), "the Files section is not in the notes");
  assert.deepEqual(notesInAnswer(JSON.stringify({ tag_name: "v0.1.0-beta.6", body })), notes);
});

test("the real notes of 0.1.0-beta.2: lead-ins and their lists, each item whole with the lines it is wrapped on", () => {
  const notes = parseReleaseNotes(fixture("release-notes-v0.1.0-beta.2.md"));
  assert.deepEqual(
    notes.blocks.map((block) => (block.type === "list" ? block.items.length : block.text)),
    ["The window:", 5, "Publish and agents:", 2, "The command line:", 2],
  );
  assert.match(notes.blocks[1].items[0].text, /^A new app column: .* A crash says so under the app's name, with the error and Show in Console\.$/);
  assert.equal(notes.more, false);
});

test("headings, paragraphs, ordered lists, loose lists and lists three deep: plain text in the notes' own shape", () => {
  const body = [
    "# Big news",
    "",
    "The first trial release, for macOS",
    "and Windows. Start [here](https://example.com/start).",
    "",
    "### Fixed ###",
    "",
    "1. Run keeps going.",
    "2. Publish says why.",
    "",
    "* One.",
    "",
    "* Two, a loose list's item.",
    "",
    "  A paragraph under Two.",
    "* Three.",
    "  - Three's detail.",
    "    - A detail of the detail.",
    "      - Deeper still: an item of the deepest list.",
    "",
    "---",
    "After the list.",
    "## Files changed in the window",
    "",
    "Only the heading that is just Files ends the notes.",
    "## Files",
    "- not shown",
  ].join("\n");
  assert.deepEqual(parseReleaseNotes(body), {
    blocks: [
      { type: "heading", text: "Big news" },
      { type: "paragraph", text: "The first trial release, for macOS and Windows. Start here." },
      { type: "heading", text: "Fixed" },
      { type: "list", ordered: true, items: [{ text: "Run keeps going." }, { text: "Publish says why." }] },
      // A loose list (blank lines between items) is one list; the ordered one before it is another.
      list(item("One."), item("Two, a loose list's item. A paragraph under Two."), item("Three.", item("Three's detail.", "A detail of the detail.", "Deeper still: an item of the deepest list."))),
      { type: "paragraph", text: "After the list." },
      { type: "heading", text: "Files changed in the window" },
      { type: "paragraph", text: "Only the heading that is just Files ends the notes." },
    ],
    more: false,
  });
});

test("plain text only: tags, images and marks go, links become their words, middle dots become spaces", () => {
  const notes = parseReleaseNotes("<b>Hello</b> \u00b7 there <script>alert(1)</script>.\n\n- ![logo](x.png)**Bold** _and_ `code` [a link](javascript:alert) \u2022 end\n- <img src=x onerror=alert(1)>");
  assert.deepEqual(notes, { blocks: [{ type: "paragraph", text: "Hello there alert(1)." }, list(item("Bold and code a link end"))], more: false });
  for (const empty of [null, "", "   ", "## Files\n\n- a", "<br>", 5]) assert.equal(parseReleaseNotes(empty), null, String(empty));
  assert.equal(notesInAnswer("not json"), null);
  assert.equal(notesInAnswer(JSON.stringify({ tag_name: "v0.2.0" })), null);
});

test("a huge or hostile body is kept within bounds, in whole entries only, and says the rest is on the page", () => {
  // Many items: the first NOTES_ENTRIES, each whole.
  const many = parseReleaseNotes(Array.from({ length: 5000 }, (_, i) => `- Item ${i} of a very long list.`).join("\n"));
  assert.equal(many.blocks[0].items.length, NOTES_ENTRIES);
  assert.equal(many.blocks[0].items.at(-1).text, `Item ${NOTES_ENTRIES - 1} of a very long list.`);
  assert.equal(many.more, true);
  // Long items: as many as fit in NOTES_CHARS, none cut.
  const longOne = "word ".repeat(300).trim();
  const long = parseReleaseNotes(Array.from({ length: 40 }, () => `- ${longOne}`).join("\n"));
  assert.ok(long.more);
  assert.ok(long.blocks[0].items.every((one) => one.text === longOne));
  assert.equal(long.blocks[0].items.length, Math.floor(NOTES_CHARS / longOne.length));
  assert.ok(words(long).join("").length <= NOTES_CHARS);
  // A line longer than NOTES_LINE (its tabs four spaces each): it is not shown at all, not shown cut, and the reading
  // stops there.
  assert.deepEqual(parseReleaseNotes(`- First.\n- ${"x".repeat(NOTES_LINE)}\n- Third.`), { blocks: [list(item("First."))], more: true });
  assert.deepEqual(parseReleaseNotes(`- First.\n  ${"\t".repeat(NOTES_LINE / 4)}x`), { blocks: [], more: true });
  assert.deepEqual(parseReleaseNotes("x".repeat(NOTES_LINE + 1)), { blocks: [], more: true });
  assert.deepEqual(parseReleaseNotes(`- ${"x".repeat(NOTES_LINE - 2)}`).blocks[0].items[0].text.length, NOTES_LINE - 2, "a line of NOTES_LINE is read");
  // An item wrapped over lines that the reading stops in the middle of is left out whole.
  const wrapped = parseReleaseNotes(`- Short.\n- Wrapped\n${"  and on and on and on and on and on.\n".repeat(400)}`);
  assert.deepEqual(wrapped, { blocks: [list(item("Short."))], more: true });
  // A body past what is read (64 KiB): the item it ends in is not shown cut.
  const huge = parseReleaseNotes(`- Kept.\n- ${"y".repeat(70 * 1024)}`);
  assert.deepEqual(huge, { blocks: [list(item("Kept."))], more: true });
  // Deep nesting: no deeper than NOTES_DEPTH.
  const deep = parseReleaseNotes(Array.from({ length: 20 }, (_, i) => `${"  ".repeat(i)}- Level ${i + 1}`).join("\n"));
  let depth = 0;
  for (let at = deep.blocks[0]; at; at = at.items.at(-1).list) depth += 1;
  assert.equal(depth, NOTES_DEPTH);
  assert.equal(words(deep).length, 20, "the deeper items are kept, in the deepest list");
});

test("the notes are read fast however the body is made: every line's work is linear, in the app's main process", () => {
  // 64 KiB of one hostile line over and over; each was once seconds (a heading's closing #s, links, images, tags).
  const fill = (line) => `${line}\n`.repeat(Math.max(8, Math.floor((64 * 1024) / (line.length + 1))));
  const bodies = {
    "a heading with a run of tabs": fill(`# a${"\t".repeat(490)}b`),
    "a heading with a run of spaces": fill(`# a${" ".repeat(1990)}b`),
    "a heading with tabs past the line's bound": `# a${"\t".repeat(7990)}b\n`.repeat(8),
    "images opened, never closed": fill("![".repeat(999)),
    "brackets opened, never closed": fill("[".repeat(1999)),
    "links' addresses opened, never closed": fill("[](".repeat(666)),
    "references opened": fill("[a][".repeat(499)),
    "backticks": fill("`".repeat(1999)),
    "code spans opened": fill("`a".repeat(999)),
    "tags opened, never closed": fill("<a".repeat(999)),
    "bold opened": fill("**a".repeat(666)),
    "emphasis marks": fill(`- ${"* _ ".repeat(499)}`),
    "all the marks": fill("**[`<".repeat(399)),
  };
  for (const [what, body] of Object.entries(bodies)) {
    const started = performance.now();
    parseReleaseNotes(body);
    const ms = performance.now() - started;
    assert.ok(ms < 100, `${what}: ${ms.toFixed(1)} ms`);
  }
});

test("the notes kept in app-settings.json: the new shape is read and checked again; the shape of 0.1.0-beta.6 is dropped", () => {
  const notes = parseReleaseNotes(fixture("release-notes-v0.1.0-beta.6.md"));
  assert.deepEqual(storedNotes({ version: "0.1.0-beta.7", ...notes }, "0.1.0-beta.7"), notes);
  assert.deepEqual(storedNotes({ version: "0.1.0-beta.7", ...notes }, "v0.1.0-beta.7"), notes);
  assert.equal(storedNotes({ version: "0.1.0-beta.7", ...notes }, "0.1.0-beta.8"), null, "notes of another version");
  // What 0.1.0-beta.6 and before kept: two or three lines cut with an ellipsis. Not shown.
  for (const old of [
    { version: "0.1.0-beta.7", kind: "list", lines: ["Firmware 1.4.1. The emulated BUSY Bar runs the firmware…", "Cleaner window.", "LEDs beside Start / Pause blink…"] },
    { version: "0.1.0-beta.7", kind: "text", lines: ["Fixes."] },
  ])
    assert.equal(storedNotes(old, "0.1.0-beta.7"), null, old.kind);
  // A file edited by hand or broken: what is not of the shape is left out; a control character is a space.
  for (const bad of [null, "notes", [], 5, { version: "0.1.0-beta.7" }, { version: "0.1.0-beta.7", blocks: "x" }, { version: "0.1.0-beta.7", blocks: [{ type: "script", text: "x" }, { type: "list", items: "x" }, 5] }])
    assert.equal(storedNotes(bad, "0.1.0-beta.7"), null, JSON.stringify(bad));
  assert.deepEqual(storedNotes({ version: "1.0.0", blocks: [{ type: "paragraph", text: "a\u0000b", extra: "<b>" }, { type: "list", items: [{ text: 5 }, { lead: "L", text: "t", list: { ordered: "yes", items: [{ text: "d" }] } }] }] }, "1.0.0"), { blocks: [{ type: "paragraph", text: "a b" }, { type: "list", ordered: false, items: [{ lead: "L", text: "t", list: { ordered: false, items: [{ text: "d" }] } }] }], more: false });
  // Bounds hold for what is read back too.
  const big = { version: "1.0.0", blocks: [list(...Array.from({ length: NOTES_ENTRIES + 50 }, (_, i) => item(`Item ${i}`)))] };
  const back = storedNotes(big, "1.0.0");
  assert.equal(back.blocks[0].items.length, NOTES_ENTRIES);
  assert.equal(back.more, true);
});

test("an app that kept the old shape and is updated: no notes until its check at the start, then the whole notes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "update-notes-"));
  try {
    const file = path.join(dir, "app-settings.json");
    // What 0.1.0-beta.6 wrote, for a newer version it found.
    writeFileSync(file, `${JSON.stringify({ welcomed: true, updateLatest: "0.1.0-beta.8", updateCheckedBy: "0.1.0-beta.6", updateChecked: 1, updateNotes: { version: "0.1.0-beta.8", kind: "list", lines: ["Cut…"] } })}\n`);
    const notices = [];
    const body = fixture("release-notes-v0.1.0-beta.6.md");
    let answer;
    const answered = new Promise((resolve) => (answer = resolve));
    const check = createUpdateCheck({ current: "0.1.0-beta.7", allowed: true, settings: createSettings(file), ask: () => answered, log: () => {}, onNotice: (notice) => notices.push(notice), now: () => 10_000_000 });
    const asking = check.check({ atStart: true });
    // What the last check found is shown at once, without the old notes.
    assert.deepEqual(notices, [{ version: "0.1.0-beta.8", page: "https://github.com/busy-app/busybar-emulator/releases/tag/v0.1.0-beta.8" }]);
    answer(JSON.stringify({ tag_name: "v0.1.0-beta.8", body }));
    await asking;
    assert.equal(notices.length, 2, "the notice again, now with the notes");
    assert.deepEqual(notices[1].notes, parseReleaseNotes(body));
    const kept = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(kept.updateNotes, { version: "0.1.0-beta.8", ...parseReleaseNotes(body) }, "the new shape in the old one's place");
    // And the pop-up's answer carries them.
    const popup = createUpdatePopup({ enabled: true, state: () => ({ state: "available", version: "0.1.0-beta.8", current: "0.1.0-beta.7", canInstall: true }), notice: () => check.notice, busy: () => null });
    assert.deepEqual(popup.ask().notes, parseReleaseNotes(body));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
