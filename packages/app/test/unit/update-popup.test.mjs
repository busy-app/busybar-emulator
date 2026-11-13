// The update's pop-up (update-popup.mjs): once per version in a run, again a day after if the app stays open, never
// while the app is busy or in a run that shows no pop-up; and the release notes' short summary it shows
// (update-check.mjs releaseSummary).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { releaseSummary, SUMMARY_CHARS, summaryInAnswer } from "../../src/update-check.mjs";
import { ASK_AGAIN_MS, BUSY_RETRY_MS, createUpdatePopup } from "../../src/update-popup.mjs";

function setup({ enabled = true, state = { state: "available", version: "0.1.0-beta.2", current: "0.1.0-beta.1", canInstall: true }, notice = null } = {}) {
  const time = { now: 1_000_000 };
  const o = { state, busy: null, notice };
  const popup = createUpdatePopup({ enabled, state: () => o.state, notice: () => o.notice, busy: () => o.busy, now: () => time.now });
  return { popup, o, time };
}

test("a version offered is shown once in a run, and again a day later if the person said Later", () => {
  const { popup, time } = setup({ notice: { version: "0.1.0-beta.2", summary: { kind: "text", lines: ["Fixes."] } } });
  const first = popup.ask();
  assert.deepEqual(first, { show: true, version: "0.1.0-beta.2", current: "0.1.0-beta.1", canInstall: true, page: "https://github.com/busy-app/busybar-emulator/releases/tag/v0.1.0-beta.2", summary: { kind: "text", lines: ["Fixes."] } });
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
  assert.equal(answer.summary, undefined, "no notes of another version");
});

test("a run without the pop-up never shows it", () => {
  const { popup } = setup({ enabled: false });
  assert.deepEqual(popup.ask(), { show: false, retryMs: null });
  assert.deepEqual(popup.shown, {});
});

test("the release notes' summary: the first sentences, or the first items of a list; plain text", () => {
  const prose = "The first trial release of BUSY Bar Emulator: a BUSY Bar on your computer. Write an app, run it, take screenshots and a clip for your post, and get it ready for the BUSY Apps Catalog, all without a bar. A desktop app for macOS (Apple\nSilicon and Intel) and Windows x64.\n\n### What is in it\n\n- One\n";
  const text = releaseSummary(prose);
  assert.equal(text.kind, "text");
  assert.deepEqual(text.lines, ["The first trial release of BUSY Bar Emulator: a BUSY Bar on your computer. Write an app, run it, take screenshots and a clip for your post, and get it ready for the BUSY Apps Catalog, all without a bar."]);

  const list = releaseSummary("### Fixed\n\n- **Run** no longer stops at the first `fetch`.\n- The [3D view](https://example.com/x) keeps its camera\n  after a restart.\n- Publish says which file is too large.\n- A fourth item.\n\n## Files\n\n- `busybar-emulator-mac-arm64.dmg`");
  assert.deepEqual(list, { kind: "list", lines: ["Run no longer stops at the first fetch.", "The 3D view keeps its camera after a restart.", "Publish says which file is too large."] });

  const long = releaseSummary(`${"word ".repeat(200)}end.`);
  assert.ok(long.lines[0].length <= SUMMARY_CHARS && long.lines[0].endsWith("…"), long.lines[0]);
  assert.deepEqual(releaseSummary("<b>Hello</b> \u00b7 there."), { kind: "text", lines: ["Hello there."] });
  for (const empty of [null, "", "   ", "## Files\n\n- a", 5]) assert.equal(releaseSummary(empty), null, String(empty));
  assert.deepEqual(summaryInAnswer(JSON.stringify({ tag_name: "v0.2.0", body: "Fixes the Run button." })), { kind: "text", lines: ["Fixes the Run button."] });
  assert.equal(summaryInAnswer("not json"), null);
});

test("a lead-in that ends with a colon is not the summary: the list or the paragraph it introduces is", () => {
  // The changelog groups its items under such lines; the summary of 0.1.0-beta.2 was once "The window:" alone.
  assert.deepEqual(releaseSummary("The window:\n\n- A new app column.\n- A new dashboard.\n\nPublish:\n\n- One more."), { kind: "list", lines: ["A new app column.", "A new dashboard."] });
  assert.deepEqual(releaseSummary("Fixed:\n- Run keeps going.\n- Publish says why."), { kind: "list", lines: ["Run keeps going.", "Publish says why."] });
  assert.deepEqual(releaseSummary("### Fixed\n\nThe window:\n\n- Run keeps going."), { kind: "list", lines: ["Run keeps going."] });
  assert.deepEqual(releaseSummary("In short:\n\nRun keeps going. Publish says why."), { kind: "text", lines: ["Run keeps going. Publish says why."] });
  // A loose list (a blank line between its items) is one list; a paragraph after it is not part of it.
  assert.deepEqual(releaseSummary("The window:\n\n- One.\n\n- Two.\n\nAlso this.\n\n- Three."), { kind: "list", lines: ["One.", "Two."] });
  // A paragraph that ends with a colon but says something itself stays the summary.
  const said = releaseSummary("The first trial release of BUSY Bar Emulator, a BUSY Bar on your computer, for macOS and Windows. Start here:\n[download](https://example.com).\n\n- One");
  assert.equal(said.kind, "text");
  assert.match(said.lines[0], /^The first trial release/);
  // Prose that starts the list's item without a blank line is a paragraph, and is the summary.
  assert.deepEqual(releaseSummary("This release fixes three things, all in the window.\n- One."), { kind: "text", lines: ["This release fixes three things, all in the window."] });
});

test("the real notes of 0.1.0-beta.2 give the first three items of the window's list, each cut at a clause", () => {
  const body = readFileSync(new URL("../fixtures/release-notes-v0.1.0-beta.2.md", import.meta.url), "utf8");
  assert.ok(body.startsWith("The window:\n\n- "), "the fixture is the release's body as GitHub has it");
  const summary = releaseSummary(body);
  assert.deepEqual(summary, {
    kind: "list",
    lines: ["A new app column: the project's folder with Copy and Open in Finder…", "A new dashboard for the BUSY Bar: its name and address with Copy…", "Square buttons and one kind of hover descriptor across the window…"],
  });
  assert.ok(summary.lines.join("").length <= SUMMARY_CHARS);
  assert.deepEqual(summaryInAnswer(JSON.stringify({ tag_name: "v0.1.0-beta.2", body })), summary);
});

test("a lead-in with nothing after it says nothing: no pop-up line of its own", () => {
  assert.equal(releaseSummary("The window:\n"), null);
  assert.equal(releaseSummary("The window:\n\n## Files\n\n- busybar-emulator-mac-arm64.dmg\n"), null);
});
