// The shell's own message page: served by the app's scheme, shown without any server, and the only page with the
// bridge.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { alive, listening, PORTS, sleep, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const FAILURE = "Told on stderr <b>bold</b><img src=x onerror=window.pwned=1>";
let app;

before(async () => {
  // The server fails its first start and works from the second on.
  app = await launch({ env: { FAKE_SERVER_FAIL: FAILURE, FAKE_SERVER_FAIL_TIMES: "1" } });
  await app.waitWindow("message");
});
after(() => app?.close());

const fetchInApp = (address, method = "GET") =>
  app.run(
    async (_shell, electron, [url, how]) => {
      const answer = await electron.session.defaultSession.fetch(url, { method: how });
      return { status: answer.status, type: answer.headers.get("content-type"), text: (await answer.text()).slice(0, 60) };
    },
    [address, method],
  );

test("the page comes from the app's own scheme: its origin is app://shell, not null and not a file", async () => {
  const page = await app.page("({ href: location.href, origin: location.origin, self: self.origin, secure: isSecureContext })");
  assert.deepEqual(page, { href: "app://shell/message.html", origin: "app://shell", self: "app://shell", secure: true });
});

test("the message does not depend on the server: nothing listens, one start was made, and the page says what happened", async () => {
  assert.equal(await listening(app.port), false);
  assert.equal(await app.run((shell) => shell.keeper.starts), 1);
  assert.equal((await app.state()).name, "failed");
  const shown = await until(() => app.page(`document.body.dataset.kind && ({
    kind: document.body.dataset.kind,
    title: document.getElementById("title").textContent,
    text: document.getElementById("text").textContent,
    detail: document.getElementById("detail").textContent,
    buttons: [...document.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => b.textContent),
  })`), "the message");
  assert.equal(shown.kind, "failed");
  assert.equal(shown.title, "The emulator did not start");
  assert.ok(shown.text.includes(`The log is at ${app.logFile}`), shown.text);
  // The server said why it could not start: that is the detail, and the text does not claim it stopped.
  assert.ok(shown.text.startsWith("The emulator server could not start; what it said is below."), shown.text);
  assert.equal(shown.detail, FAILURE);
  assert.deepEqual(shown.buttons, ["Try again", "Quit"]);
});

test("what the server printed is shown as text, not as markup", async () => {
  assert.equal(await app.page("document.querySelector('#detail *') === null && window.pwned === undefined"), true);
});

test("the page has the bridge, and only its named actions", async () => {
  assert.deepEqual(await app.page("Object.keys(window.busyShell).sort()"), ["message", "quit", "retry"]);
  assert.equal(await app.page("typeof require + typeof process + typeof window.ipcRenderer"), "undefinedundefinedundefined");
  const prefs = await app.run((shell) => shell.windows.current.win.webContents.getLastWebPreferences());
  assert.deepEqual([prefs.sandbox, prefs.contextIsolation, prefs.nodeIntegration, prefs.webviewTag], [true, true, false, false]);
});

test("the page's policy refuses inline code and code from text", async () => {
  const result = await app.page(`(() => {
    let evaluated = "refused";
    try { evaluated = eval("'ran'"); } catch {}
    const script = document.createElement("script");
    script.textContent = "window.inlineRan = true";
    document.body.append(script);
    return { evaluated, inline: window.inlineRan === true };
  })()`);
  assert.deepEqual(result, { evaluated: "refused", inline: false });
});

test("the message page gets no permission at all, not even the clipboard", async () => {
  for (const name of ["clipboard-write", "clipboard-read", "geolocation", "notifications"]) {
    assert.equal(await app.page(`navigator.permissions.query({ name: ${JSON.stringify(name)} }).then((s) => s.state)`), "denied", name);
  }
});

test("the app's scheme serves the page's files and nothing outside their folder", async () => {
  assert.deepEqual(await fetchInApp("app://shell/message.css").then((a) => [a.status, a.type]), [200, "text/css; charset=utf-8"]);
  assert.equal((await fetchInApp("app://shell/message.html")).status, 200);
  const outside = [
    "app://shell/../main.mjs",
    "app://shell/%2e%2e/main.mjs",
    "app://shell/..%2fmain.mjs",
    "app://shell/..%5cmain.mjs",
    "app://shell/..%2f..%2fpackage.json",
    "app://shell/../preload.cjs",
    "app://shell/../../test-variant/hook.mjs",
    "app://shell/",
    "app://shell/missing.html",
    "app://other/message.html",
    "app://window/message.html",
  ];
  for (const address of outside) {
    const answer = await fetchInApp(address).catch((e) => ({ status: "failed", text: String(e.message) }));
    assert.ok(answer.status === 404 || answer.status === "failed", `${address}: ${JSON.stringify(answer)}`);
  }
  assert.equal((await fetchInApp("app://shell/message.html", "POST")).status, 405);
});

test("a foreign page in the same window calls the bridge: every action is refused", async () => {
  // The foreign page comes from the server's own address: the only one besides the app's scheme that a page of the
  // app can reach (security.mjs). While the message is shown nothing listens there.
  const foreign = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>foreign</title><p id='foreign'>foreign</p>");
  });
  await new Promise((resolve) => foreign.listen(PORTS.app, "127.0.0.1", resolve));
  try {
    await app.run((shell, _electron, address) => shell.windows.current.win.webContents.loadURL(address), `http://127.0.0.1:${PORTS.app}/`);
  } finally {
    foreign.closeAllConnections();
    await new Promise((resolve) => foreign.close(resolve));
  }
  assert.equal(await app.page("location.origin"), `http://127.0.0.1:${PORTS.app}`);
  // The preload gave this page the same functions; the main process decides.
  const answers = await app.page(`Promise.all(["message", "retry", "quit"].map((name) => window.busyShell[name]().then(() => "allowed", (e) => e.message)))`);
  for (const answer of answers) assert.match(answer, /This page may not ask the app for that\./);
  await sleep(400);
  assert.ok(alive(app.pid), "the foreign page quit the app");
  assert.equal(await app.run((shell) => shell.keeper.starts), 1, "the foreign page restarted the server");
  assert.match(app.log(), /bridge: refused "app\.quit" from http:\/\/127\.0\.0\.1:\d+: not a page that may call it/);

  await app.run((shell) => shell.windows.showMessage());
  await until(async () => (await app.page("location.origin")) === "app://shell", "the message page again");
});

test("Try again starts the server once more, and the device window takes the message's place", async () => {
  await until(() => app.page("document.body.dataset.kind === 'failed'"), "the message");
  await app.page(`document.getElementById("retry").click()`);
  await app.waitWindow("device");
  assert.equal(await app.run((shell) => shell.keeper.starts), 2);
  assert.equal(await app.run((_shell, electron) => electron.BrowserWindow.getAllWindows().length), 1);
  // The device window's page has the bridge's one function for the actions on app projects, not the message page's three.
  assert.deepEqual(await app.page("Object.keys(window.busyShell).sort()"), ["action", "onJob", "onMenu"]);
});
