// An app's own files through /api/storage, as firmware 1.4.1 opens it to apps (2fe36de1): a request from an app
// (the firmware's mark x-busybar-fetch: js) has /ext/data translated to the app's folder,
// /ext/apps_data/js_apps/<id>; any other path is refused. The firmware's own test of paths outside the folder is
// skipped (FW-1271, tests/integration/frontend/storage/test_js_storage.py), so a bar's answers are the reference.
//
// test/api.mjs runs it: on a bar and in the emulator, live (--bar), and the bar's answers go into its recording;
// without a bar, the emulator against the recording of its firmware when the recording has them.
//
// The probe app makes the requests one after another and leaves each answer in its localStorage; the test reads it
// from the computer. Afterwards the test removes the app, its localStorage and its folder, and checks from the computer
// that nothing the app was refused was made outside the folder. The paths outside it name files that do not exist.
import { setTimeout as sleep } from "node:timers/promises";

import { targz } from "./package.mjs";

export const APP = "app.probe.storage";
const FOLDER = `/ext/apps_data/js_apps/${APP}`;
const LOCAL_STORAGE = `/ext/apps_data/jsrunner/${APP}.localstorage.json`;
// Outside the folder, where nothing is: what the app is refused must not appear there.
const OUTSIDE = ["/ext/emu-probe-outside.txt", "/ext/emu-probe-outside-dir"];

/** The requests, in order: [name, method, path and query, body]. */
export const REQUESTS = [
  ["list the folder", "GET", "storage/list?path=/ext/data"],
  ["write a file", "POST", "storage/write?path=/ext/data/a.txt", "one"],
  ["append to it", "POST", "storage/write?path=/ext/data/a.txt&append=1", " two"],
  ["read it", "GET", "storage/read?path=/ext/data/a.txt"],
  ["make a folder", "POST", "storage/mkdir?path=/ext/data/d"],
  ["rename into it", "POST", "storage/rename?path=/ext/data/a.txt&new_path=/ext/data/d/b.txt"],
  ["list the inner folder", "GET", "storage/list?path=/ext/data/d"],
  ["a path ending in /", "GET", "storage/list?path=/ext/data/d/"],
  // The bar's own numbers: compared by status and the answer's keys (BY_KEYS).
  ["the storage's status", "GET", "storage/status"],
  ["a path without /ext/data", "GET", "storage/list?path=/ext"],
  ["another app's file", "GET", "storage/read?path=/ext/user_assets/app.probe.storage/appmeta/manifest.json"],
  ["a name that only starts like it", "GET", "storage/list?path=/ext/database"],
  ["a relative path", "GET", "storage/list?path=data"],
  ["/ext/data/.. in the query", "GET", "storage/list?path=/ext/data/.."],
  ["/ext/data/../.. to a file outside", "GET", "storage/read?path=/ext/data/../../user_assets/app.probe.storage/appmeta/manifest.json"],
  ["%2e%2e in the query", "GET", "storage/list?path=/ext/data/%2e%2e"],
  ["a write outside", "POST", `storage/write?path=${OUTSIDE[0]}`, "x"],
  ["a folder outside", "POST", `storage/mkdir?path=${OUTSIDE[1]}`],
  ["a rename to outside", "POST", `storage/rename?path=/ext/data/d/b.txt&new_path=${OUTSIDE[0]}`],
  ["a rename from outside", "POST", `storage/rename?path=/ext/user_assets/app.probe.storage/appmeta/manifest.json&new_path=/ext/data/m.json`],
  ["remove the file", "DELETE", "storage/remove?path=/ext/data/d/b.txt"],
  ["remove the inner folder", "DELETE", "storage/remove?path=/ext/data/d"],
  ["list the folder again", "GET", "storage/list?path=/ext/data"],
];

const SCRIPT = `
const requests = ${JSON.stringify(REQUESTS)};
const all = {};
const one = (i) => {
  if (i >= requests.length) return;
  const [name, method, path, body] = requests[i];
  fetch("http://localhost/api/" + path, body === undefined ? { method } : { method, body })
    .then((r) => r.text().then((text) => ({ status: r.status, text })))
    .then((value) => value, (e) => ({ error: String(e && e.message !== undefined ? e.message : e) }))
    .then((value) => {
      all[name] = value;
      localStorage.setItem("answers", JSON.stringify(all));
      one(i + 1);
    });
};
one(0);
`;

// Answers whose values are the device's own: compared by their status and keys.
const BY_KEYS = new Set(["the storage's status"]);

/** What is compared of an answer: the status and the body, a JSON body by its value (not its white space). */
function answerOf(value) {
  if (!value || value.error !== undefined) return value ?? null;
  let body = value.text;
  try {
    body = JSON.parse(value.text);
  } catch {}
  return { status: value.status, body };
}

/**
 * Runs the probe on the device at `host` (a bar or an emulator). Returns { answers: { name → { status, body } },
 * noApp: { status, body } (a request with the firmware's mark while no app runs), outside: [paths that exist] }.
 */
export async function probeAppStorage(host) {
  const api = async (method, path, body, headers) => {
    const r = await fetch(`http://${host}/api/${path}`, { method, body, headers, signal: AbortSignal.timeout(10000) });
    return { status: r.status, text: await r.text() };
  };
  const manifest = { format_version: 1, id: APP, name: "Storage probe", version: "0.1.0", api_version: "27.15.0", description: "An app's own files through /api/storage", debug: true };
  const archive = targz({ [`${APP}/appmeta/manifest.json`]: JSON.stringify(manifest), [`${APP}/scripts/main.js`]: SCRIPT });
  const staged = JSON.parse((await api("POST", "apps/stage", archive)).text);
  if (!staged.install_key) throw new Error(`stage: ${JSON.stringify(staged)}`);
  const installed = await api("POST", `apps/install?install_key=${staged.install_key}`);
  if (installed.status !== 200) throw new Error(`install: ${installed.text}`);
  await sleep(500);
  await api("DELETE", `storage/remove?path=${LOCAL_STORAGE}`);
  await api("DELETE", `storage/remove?path=${FOLDER}`);
  const answers = {};
  try {
    const launched = await api("POST", `apps/launch?app_id=${APP}`);
    if (launched.status !== 200) throw new Error(`launch: ${launched.text}`);
    for (let i = 0; i < 30 && Object.keys(answers).length < REQUESTS.length; i++) {
      await sleep(1000);
      const file = await api("GET", `storage/read?path=${LOCAL_STORAGE}`);
      if (file.status !== 200) continue;
      Object.assign(answers, JSON.parse(JSON.parse(file.text).data?.answers ?? "{}"));
    }
  } finally {
    await api("POST", "apps/quit");
    await sleep(1000);
    await api("DELETE", `apps?app_id=${APP}`);
    await api("DELETE", `storage/remove?path=${LOCAL_STORAGE}`);
    await api("DELETE", `storage/remove?path=${FOLDER}`);
  }
  // The firmware's mark on a request from the computer while no app runs.
  const noApp = await api("GET", "storage/list?path=/ext/data", undefined, { "X-Busybar-Fetch": "js" });
  const outside = [];
  for (const path of OUTSIDE) if ((await api("GET", `storage/list?path=${path}`)).status === 200 || (await api("GET", `storage/read?path=${path}`)).status === 200) outside.push(path);
  for (const path of outside) await api("DELETE", `storage/remove?path=${path}`);
  return {
    answers: Object.fromEntries(REQUESTS.map(([name]) => [name, answerOf(answers[name])])),
    noApp: answerOf(noApp),
    outside,
  };
}

/** Each difference between two probes' results (probeAppStorage), as [name, ok, detail]. */
export function compareAppStorage(want, got) {
  const lines = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const show = (a) => JSON.stringify(a)?.slice(0, 200);
  const keys = (a) => (a?.body && typeof a.body === "object" ? { status: a.status, keys: Object.keys(a.body).sort() } : a);
  for (const [name] of REQUESTS) {
    const ok = BY_KEYS.has(name) ? same(keys(want.answers[name]), keys(got.answers[name])) : same(want.answers[name], got.answers[name]);
    lines.push([`app storage: ${name}`, ok, ok ? `${got.answers[name]?.status}` : `bar ${show(want.answers[name])} | emulator ${show(got.answers[name])}`]);
  }
  const noApp = same(want.noApp, got.noApp);
  lines.push(["app storage: the firmware's mark while no app runs", noApp, noApp ? `${got.noApp?.status}` : `bar ${show(want.noApp)} | emulator ${show(got.noApp)}`]);
  lines.push(["app storage: nothing made outside the app's folder", got.outside.length === 0 && want.outside.length === 0, `bar ${show(want.outside)}, emulator ${show(got.outside)}`]);
  return lines;
}
