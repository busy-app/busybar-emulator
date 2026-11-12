// The update's pop-up (update-popup.mjs): once per version in a run, again a day after if the app stays open, never
// while the app is busy or in a run that shows no pop-up; and the release notes' short summary it shows
// (update-check.mjs releaseSummary).
import assert from "node:assert/strict";
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
