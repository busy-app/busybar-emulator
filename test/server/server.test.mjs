// startServer and the handle it gives: options, several servers in one process, failures and stopping.
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { bar } from "../../packages/server/bar-speed.mjs";
import { Device } from "../../packages/server/device.mjs";
import { loadFirmware } from "../../packages/server/firmware.mjs";
import { AppRuntime } from "../../packages/server/runtime.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { activeResourcesAtRest, activeResourcesSettled, finish, get, installApp, knownPort, port, request, tempDir, until } from "./helpers.mjs";

after(finish);

const turn = () => new Promise((resolve) => setImmediate(resolve));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorOf = (response) => JSON.parse(new TextDecoder().decode(response.body)).error;

/** A server for a test, stopped when the test is over whatever happens in it. */
async function start(t, options = {}) {
  const lines = [];
  const emulator = await startServer({ port: port(0), dataDir: tempDir(t), log: (line) => lines.push(line), ...options });
  t.after(() => emulator.stop());
  return Object.assign(emulator, { lines });
}

const firmwareOf = async (emulator) => (await get(`${emulator.url}/api/status/firmware`)).json();
const refused = (url) => assert.rejects(get(url), { code: "ECONNREFUSED" });

/** Listens on a port of this computer, as another program would. */
async function occupy(t, wanted) {
  const other = net.createServer();
  await new Promise((resolve, reject) => other.once("error", reject).listen(wanted, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => other.close(resolve)));
  return other.address().port;
}

test("a server answers on its port, and the handle says what was started", async (t) => {
  const dataDir = tempDir(t);
  const emulator = await start(t, { dataDir, firmware: "dev", barSpeed: false });
  assert.equal(emulator.url, `http://127.0.0.1:${emulator.port}`);
  if (port(0)) assert.equal(emulator.port, port(0));
  assert.equal(emulator.dataDir, dataDir);
  assert.equal(emulator.barDir, join(dataDir, "bar", "dev"));
  assert.deepEqual(emulator.dataFolder, { format: 1, created: true, lockFile: join(dataDir, "run", "server.lock"), keyFile: join(dataDir, "key") });
  assert.equal(emulator.firmware.name, "dev");
  assert.equal(emulator.barSpeed, false);
  assert.equal(typeof emulator.stop, "function");

  const version = await get(`${emulator.url}/api/version`);
  assert.equal(version.status, 200);
  assert.deepEqual(version.json(), { api_semver: emulator.apiVersion });
  const state = (await get(`${emulator.url}/_emu/state`)).json();
  assert.deepEqual(state.firmware, { name: "dev", commit: emulator.firmware.info.firmware });
  assert.equal((await get(`${emulator.url}/emulator`)).status, 200);
  // The data folder holds a bar for the firmware, whose ext is the bar's /ext.
  assert.ok(existsSync(join(dataDir, "bar", "dev", "ext", "user_assets")));
});

test("port 0 takes a free port and the handle names it", async (t) => {
  const emulator = await start(t, { port: 0 });
  assert.ok(emulator.port > 0);
  assert.equal((await get(`http://127.0.0.1:${emulator.port}/api/version`)).status, 200);
});

test("the firmware is the default one unless named, and bar speed is on unless turned off", async (t) => {
  const emulator = await start(t);
  assert.equal(emulator.firmware.name, "1.3.1");
  assert.equal((await firmwareOf(emulator)).version, "1.3.1");
  assert.equal(emulator.barSpeed, true);
});

test("options that cannot work are refused before anything is touched", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const before = await activeResourcesAtRest();
  await assert.rejects(startServer({ port: port(0) }), TypeError);
  await assert.rejects(startServer({ port: -1, dataDir }), RangeError);
  await assert.rejects(startServer({ port: 65536, dataDir }), RangeError);
  await assert.rejects(startServer({ port: Number.NaN, dataDir }), RangeError);
  await assert.rejects(startServer({ port: "8761", dataDir }), RangeError);
  await assert.rejects(startServer({ port: port(0), dataDir, firmware: "no-such-firmware" }), { name: "FirmwareError", code: "unknown-firmware", message: /^Unknown firmware "no-such-firmware"\. The emulator has: 1\.3\.1, dev / });
  assert.ok(!existsSync(dataDir), "the data folder was not made");
  assert.deepEqual(await activeResourcesSettled(before), before);
});

test("until the BUSY Bar is up nobody is answered", async (t) => {
  const wanted = await knownPort(0);
  // One connection after another while the server starts: refused (the port is not taken yet), closed without an
  // answer (taken, the bar not up), or answered.
  const attempt = () =>
    new Promise((resolve) => {
      const socket = net.connect(wanted, "127.0.0.1", () => socket.write(`GET /api/version HTTP/1.1\r\nHost: localhost:${wanted}\r\nConnection: close\r\n\r\n`));
      let answer = "";
      socket.on("data", (chunk) => (answer += chunk));
      socket.on("error", (error) => resolve(error.code === "ECONNREFUSED" ? "refused" : "closed"));
      socket.on("close", () => resolve(answer.startsWith("HTTP/1.1 200") ? "answered" : "closed"));
    });
  let started = false;
  const starting = startServer({ port: wanted, dataDir: tempDir(t) }).then((emulator) => {
    started = true;
    return emulator;
  });
  // The port is taken a turn of the event loop after the call; the bar takes longer.
  await turn();
  await turn();
  const seen = { refused: 0, closed: 0, answered: 0 };
  while (!started) {
    const outcome = await attempt();
    // An answer that came before the start was over would be one given by a bar that is not up.
    if (!started) assert.notEqual(outcome, "answered");
    seen[outcome]++;
  }
  const emulator = await starting;
  t.after(() => emulator.stop());
  assert.equal(await attempt(), "answered");
  // That nobody is kept waiting is shown where the start is long: the command line's first start (cli.test.mjs).
  t.diagnostic(`while the server started: ${seen.refused} connections refused, ${seen.closed} closed without an answer, ${seen.answered} answered just as it was up`);
});

test("two servers in one process: their own ports, data folders, firmware and state", async (t) => {
  const release = await start(t, { firmware: "1.3.1" });
  const dev = await start(t, { port: port(1), firmware: "dev" });
  assert.notEqual(release.port, dev.port);
  assert.notEqual(release.dataDir, dev.dataDir);

  // Each says its own firmware.
  const [a, b] = [await firmwareOf(release), await firmwareOf(dev)];
  assert.equal(a.version, "1.3.1");
  assert.equal(b.version, "dev");
  assert.equal(a.commit_hash, release.firmware.info.firmware);
  assert.equal(b.commit_hash, dev.firmware.info.firmware);
  assert.notEqual(a.commit_hash, b.commit_hash);

  // And runs it: 1.3.1's runtime has no console.warn, dev's has. The same app is installed on both.
  const script = `console.log("console.warn is " + typeof console.warn); setInterval(function () {}, 1000);`;
  for (const emulator of [release, dev]) {
    await installApp(emulator.url, "app.test.warn", script);
    assert.equal((await request("POST", `${emulator.url}/api/apps/launch?app_id=app.test.warn`)).status, 200);
  }
  const said = (emulator) => until(`the app's line on ${emulator.firmware.name}`, () => emulator.lines.find((line) => line.includes("console.warn is")));
  assert.match(await said(release), /console\.warn is undefined/);
  assert.match(await said(dev), /console\.warn is function/);

  // The screen modules are their firmware's too: a short Back takes a running app's picture off the screen on
  // 1.3.1 and leaves it on dev.
  const draw = `
    fetch("http://localhost/api/display/draw", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      application_name: "app.test.draw", elements: [{ id: "t", type: "text", text: "HELLO", font: "small", x: 0, y: 0, display: "front" }],
    }) }).then(function (r) { console.log("drawn " + r.status); });
    setInterval(function () {}, 1000);`;
  const front = async (emulator) => (await get(`${emulator.url}/api/screen?display=0`)).text;
  const afterBack = {};
  for (const emulator of [release, dev]) {
    await installApp(emulator.url, "app.test.draw", draw);
    assert.equal((await request("POST", `${emulator.url}/api/apps/launch?app_id=app.test.draw`)).status, 200);
    await until(`the drawing on ${emulator.firmware.name}`, () => emulator.lines.some((line) => line.includes("drawn 200")));
    // The picture once it stands still: the launcher's own screens are over.
    let drawn = await front(emulator);
    await until("a still picture", async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const frame = await front(emulator);
      const still = frame === drawn;
      drawn = frame;
      return still;
    });
    assert.equal((await request("POST", `${emulator.url}/api/input?key=back`)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    afterBack[emulator.firmware.name] = (await front(emulator)) === drawn ? "kept" : "cleared";
    assert.equal((await get(`${emulator.url}/_emu/state`)).json().running.id, "app.test.draw");
  }
  assert.deepEqual(afterBack, { "1.3.1": "cleared", dev: "kept" });

  // An app installed on one is not on the other, in the API and on disk.
  await installApp(release.url, "app.test.only", "setInterval(function () {}, 1000);");
  const apps = async (emulator) => (await get(`${emulator.url}/api/apps/list`)).json().apps.map((app) => app.id).sort();
  assert.deepEqual(await apps(release), ["app.test.draw", "app.test.only", "app.test.warn"]);
  assert.deepEqual(await apps(dev), ["app.test.draw", "app.test.warn"]);
  assert.deepEqual(readdirSync(join(dev.barDir, "ext", "user_assets")).sort(), ["app.test.draw", "app.test.warn"]);

  // The bars' settings and what runs on them are apart.
  assert.equal((await request("POST", `${release.url}/api/audio/volume?volume=7&silent=1`)).status, 200);
  assert.equal((await request("POST", `${release.url}/api/name`, Buffer.from(JSON.stringify({ name: "First" })))).status, 200);
  assert.equal((await get(`${release.url}/api/audio/volume`)).json().volume, 7);
  assert.equal((await get(`${dev.url}/api/audio/volume`)).json().volume, 50);
  assert.equal((await get(`${release.url}/api/name`)).json().name, "First");
  assert.notEqual((await get(`${dev.url}/api/name`)).json().name, "First");
  assert.equal((await request("POST", `${dev.url}/api/apps/quit`)).status, 200);
  await until("the app to stop on dev", async () => (await get(`${dev.url}/_emu/state`)).json().running === null);
  assert.equal((await get(`${release.url}/_emu/state`)).json().running.id, "app.test.draw");

  // Stopping one leaves the other working.
  await release.stop();
  await refused(`${release.url}/api/version`);
  assert.equal((await firmwareOf(dev)).version, "dev");
});

test("two servers with different firmware started at the same moment", async (t) => {
  const dirs = [tempDir(t), tempDir(t)];
  const [release, dev] = await Promise.all([
    startServer({ port: port(0), dataDir: dirs[0], firmware: "1.3.1" }),
    startServer({ port: port(1), dataDir: dirs[1], firmware: "dev" }),
  ]);
  t.after(() => Promise.all([release.stop(), dev.stop()]));
  assert.equal((await firmwareOf(release)).version, "1.3.1");
  assert.equal((await firmwareOf(dev)).version, "dev");
});

test("a port in use: a clear error, and nothing left behind", async (t) => {
  const taken = await occupy(t, port(0));
  const dataDir = join(tempDir(t), "data");
  const before = await activeResourcesAtRest();
  const lines = [];
  await assert.rejects(startServer({ port: taken, dataDir, log: (line) => lines.push(line), onError: (e) => lines.push(String(e)) }), (error) => {
    assert.equal(error.code, "EADDRINUSE");
    assert.match(error.message, new RegExp(`^Port ${taken} on 127\\.0\\.0\\.1 is in use`));
    return true;
  });
  assert.deepEqual(await activeResourcesSettled(before), before, "no socket or timer of the failed start is left");
  assert.ok(!existsSync(dataDir), "the data folder was not made");
  assert.deepEqual(lines, [], "nothing was logged");
  // The program that had the port still has it.
  await assert.rejects(startServer({ port: taken, dataDir }), { code: "EADDRINUSE" });
});

test("a stop during the start: the start fails with the reason, and the port and the process are free again", async (t) => {
  const reason = new Error("the test changed its mind");
  // At once, and some turns of the event loop into the start: while the port is taken, while the bar's screen
  // module loads. With enough turns the start is over first, and the signal stops the server that runs.
  for (const turns of [0, 1, 2, 3, 4, 5, 6, 8, 12, 40]) {
    const dataDir = tempDir(t);
    const wanted = await knownPort(0);
    await t.test(`after ${turns} turns`, async (t) => {
      const before = await activeResourcesAtRest();
      const controller = new AbortController();
      const starting = startServer({ port: wanted, dataDir, signal: controller.signal });
      (async () => {
        for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
        controller.abort(reason);
      })();
      const emulator = await starting.then((value) => value, (error) => error);
      if (emulator === reason) {
        t.diagnostic("the start was stopped");
        assert.deepEqual(await activeResourcesSettled(before), before, "nothing of the stopped start is left");
      } else {
        // The start was over before the stop came: the signal then stops the server it started.
        assert.equal(typeof emulator.stop, "function", `unexpected failure: ${emulator?.stack ?? emulator}`);
        await new Promise((resolve) => (controller.signal.aborted ? resolve() : controller.signal.addEventListener("abort", resolve)));
        await emulator.stop();
        t.diagnostic("the start was over first: the signal stopped the running server");
      }
      await refused(`http://127.0.0.1:${wanted}/api/version`);
      // The same port and data folder serve a new server.
      const next = await startServer({ port: wanted, dataDir });
      assert.equal((await get(`${next.url}/api/version`)).status, 200);
      await next.stop();
    });
  }
});

test("a stop while the port is being taken: the port is let go of when it has been taken", async (t) => {
  // With a free port asked for, taking it is the first thing a start does, and Node cannot call that off.
  const before = await activeResourcesAtRest();
  const controller = new AbortController();
  const starting = startServer({ port: 0, dataDir: join(tempDir(t), "data"), signal: controller.signal });
  controller.abort(new Error("stopped at once"));
  await assert.rejects(starting, /stopped at once/);
  assert.deepEqual(await activeResourcesSettled(before), before, "no listening socket is left");
});

test("a signal aborted beforehand starts nothing", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const before = await activeResourcesAtRest();
  await assert.rejects(startServer({ port: port(0), dataDir, signal: AbortSignal.abort(new Error("never mind")) }), /never mind/);
  assert.ok(!existsSync(dataDir));
  assert.deepEqual(await activeResourcesSettled(before), before);
});

test("aborting the signal of a running server stops it", async (t) => {
  const controller = new AbortController();
  const emulator = await start(t, { signal: controller.signal });
  assert.equal((await get(`${emulator.url}/api/version`)).status, 200);
  controller.abort();
  await emulator.stop();
  await refused(`${emulator.url}/api/version`);
});

test("stop twice, and at the same time: one stop, the same promise", async (t) => {
  const emulator = await start(t);
  const first = emulator.stop();
  const second = emulator.stop();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(emulator.stop(), first);
  await emulator.stop();
  await refused(`${emulator.url}/api/version`);
});

test("after a stop the same port and data folder start again, with the apps still installed; another firmware has a BUSY Bar of its own", async (t) => {
  const dataDir = tempDir(t);
  const first = await start(t, { dataDir });
  await installApp(first.url, "app.test.kept", "setInterval(function () {}, 1000);");
  await first.stop();
  const again = await start(t, { dataDir, port: first.port });
  assert.equal(again.dataFolder.created, false);
  assert.deepEqual((await get(`${again.url}/api/apps/list`)).json().apps.map((app) => app.id), ["app.test.kept"]);
  await again.stop();
  const dev = await start(t, { dataDir, port: first.port, firmware: "dev" });
  assert.equal((await firmwareOf(dev)).version, "dev");
  assert.deepEqual((await get(`${dev.url}/api/apps/list`)).json().apps, []);
  assert.deepEqual(readdirSync(join(dataDir, "bar")).filter((name) => !name.startsWith("._")).sort(), ["1.3.1", "dev"]);
});

test("a stop with an app running, streams open and requests unfinished", async (t) => {
  const before = await activeResourcesAtRest();
  const errors = [];
  const emulator = await start(t, { onError: (error) => errors.push(error) });
  const base = emulator.url;
  // An app with a timer, requests to the bar's API under way and one to the network that never answers. "localhost"
  // in an app is the bar itself, so the silent server is on this computer's network address, if it has one.
  const address = Object.values(networkInterfaces()).flat().find((i) => i.family === "IPv4" && !i.internal)?.address;
  // It reads what comes, or it would never learn that the other side has closed.
  const silent = net.createServer((socket) => socket.on("error", () => {}).resume());
  if (address) await new Promise((resolve, reject) => silent.once("error", reject).listen(port(1), address, resolve));
  else t.diagnostic("no network address on this computer: the app makes no request to the network");
  t.after(() => silent.listening && new Promise((resolve) => silent.close(resolve)));
  await installApp(base, "app.test.busy", `
    setInterval(function () { fetch("http://localhost/api/status"); }, 50);
    ${address ? `fetch("http://${address}:${silent.address().port}/never");` : ""}
    console.log("the app is up");
  `);
  assert.equal((await request("POST", `${base}/api/apps/launch?app_id=app.test.busy`)).status, 200);
  await until("the app to run", () => emulator.lines.some((line) => line.includes("the app is up")));

  const sockets = [];
  const open = (lines) =>
    new Promise((resolve, reject) => {
      const socket = net.connect(emulator.port, "127.0.0.1", () => socket.write(lines.join("\r\n") + "\r\n\r\n"));
      sockets.push(socket);
      socket.once("data", () => resolve(socket)).once("error", reject);
      socket.on("error", () => {});
    });
  // The device window's event stream, the state stream's WebSocket, and an upgrade the server refuses.
  await open(["GET /_emu/events HTTP/1.1", `Host: localhost:${emulator.port}`]);
  await open(["GET /api/status/ws HTTP/1.1", `Host: localhost:${emulator.port}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"]);
  await open(["GET /nowhere HTTP/1.1", `Host: localhost:${emulator.port}`, "Connection: Upgrade", "Upgrade: websocket"]);
  // An upload that stops halfway, a button held down, a sound about to play, and a request the bar answers in 3 s.
  const upload = net.connect(emulator.port, "127.0.0.1", () => upload.write(`POST /api/apps/stage HTTP/1.1\r\nHost: localhost:${emulator.port}\r\nContent-Length: 100000\r\n\r\nhalf`));
  upload.on("error", () => {});
  sockets.push(upload);
  assert.equal((await request("POST", `${base}/_emu/key?key=ok&action=down`)).status, 200);
  assert.equal((await request("POST", `${base}/api/audio/volume?volume=30`)).status, 200);
  const slow = request("POST", `${base}/api/account/link`).then((r) => r.status, (error) => error.code);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const started = Date.now();
  await emulator.stop();
  assert.ok(Date.now() - started < 2000, "the stop does not wait for what was under way");
  // Every connection was closed by the server; the unfinished request never got its answer.
  await Promise.all(sockets.map((socket) => (socket.destroyed ? null : new Promise((resolve) => socket.once("close", resolve)))));
  assert.equal(await slow, "ECONNRESET");
  await refused(`${base}/api/version`);
  if (silent.listening) await new Promise((resolve) => silent.close(resolve));
  const lines = emulator.lines.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(emulator.lines.length, lines, "nothing is logged after the stop");
  assert.deepEqual(errors, [], "no request failed inside the server");
  assert.deepEqual(await activeResourcesSettled(before), before, "no socket or timer is left");
});

test("a client that drops its upload does not take the server down", async (t) => {
  const errors = [];
  const emulator = await start(t, { onError: (error) => errors.push(error) });
  await new Promise((resolve) => {
    const socket = net.connect(emulator.port, "127.0.0.1", () => {
      socket.write(`POST /api/apps/stage HTTP/1.1\r\nHost: localhost:${emulator.port}\r\nContent-Length: 100000\r\n\r\nhalf`);
      setTimeout(() => socket.destroy(), 100);
    });
    socket.on("close", resolve);
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await get(`${emulator.url}/api/version`)).status, 200);
  assert.deepEqual(errors, []);
});

test("a stop while an app is loading", async (t) => {
  // The launcher's "launch" line is logged when the app's runtime is about to be made: a stop right then, and one
  // a turn of the event loop later, find the runtime loading.
  for (const turns of [0, 1, 2]) {
    let launched;
    const launching = new Promise((resolve) => (launched = resolve));
    const emulator = await start(t, { log: (line) => line.startsWith("Launch app.test.loading") && launched() });
    await installApp(emulator.url, "app.test.loading", "setInterval(function () {}, 1000);");
    assert.equal((await request("POST", `${emulator.url}/api/apps/launch?app_id=app.test.loading`)).status, 200);
    await launching;
    for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
    await emulator.stop();
    await refused(`${emulator.url}/api/version`);
  }
});

// The bar itself, without a server in front: what close() promises whatever is asked of the bar afterwards. (A
// settings program of the firmware asks for a restart a moment after it is used; that moment can be after a stop.)
test("a BUSY Bar that was let go of does not start again", async (t) => {
  const lines = [];
  const before = await activeResourcesAtRest();
  const device = new Device({ dataDir: tempDir(t), firmware: loadFirmware(), log: (line) => lines.push(line) });
  await device.start();
  assert.equal((await device.handle("GET", "/api/version")).status, 200);
  device.close();
  const boots = device.boots;
  await device.reboot("asked after the BUSY Bar was let go of");
  await device.powerOn();
  assert.equal(device.boots, boots, "no restart");
  assert.deepEqual(lines.filter((line) => line.includes("restarts")), []);
  // What is left of the screen is the dark one: it has no module.
  assert.equal(device.screen.M, undefined);

  // Let go of before it started: the start makes a screen module and puts it down at once.
  const early = new Device({ dataDir: tempDir(t), firmware: loadFirmware(), log: (line) => lines.push(line) });
  early.close();
  await early.start();
  assert.equal(early.screen.M, undefined);
  assert.equal(early.zoneTimer, undefined, "no timer was made");
  assert.deepEqual(await activeResourcesSettled(before), before);
});

test("a request that waited for a restart of the BUSY Bar is not carried out once the BUSY Bar is let go of", async (t) => {
  const lines = [];
  const before = await activeResourcesAtRest();
  const device = new Device({ dataDir: tempDir(t), firmware: loadFirmware(), log: (line) => lines.push(line) });
  await device.start();
  // While the bar restarts, requests wait for it to be up again.
  device.reboot("asked by the test");
  const waiting = [
    device.handle("POST", "/api/audio/volume?volume=20"), // would set the volume and play a click
    device.handle("POST", "/api/input?key=ok"),
    device.handle("POST", "/api/display/brightness?value=7"),
    device.handle("GET", "/api/version"),
  ];
  const closing = device.close();
  const said = lines.length;
  // The restart cannot be called off; the bar says when it has come to its end.
  await closing;
  assert.equal(device.screen.M, undefined, "the screen module of the restart was put down");
  for (const response of await Promise.all(waiting)) {
    assert.equal(response.status, 503);
    assert.equal(errorOf(response), "The emulator has stopped");
  }
  assert.equal(device.state.volume, 50);
  assert.equal(device.state.brightness, "auto");
  assert.equal(device.audio.playing, false);
  assert.equal(device.held.size, 0);
  // Longer than the speaker's warm-up, after which the click would have played.
  await pause(200);
  assert.deepEqual(lines.slice(said), [], "nothing is logged after the BUSY Bar was let go of");
  assert.deepEqual(await activeResourcesSettled(before), before, "no timer was made");
});

test("a BUSY Bar that was let go of takes no request, no key and no power-off", async (t) => {
  const lines = [];
  const before = await activeResourcesAtRest();
  const device = new Device({ dataDir: tempDir(t), firmware: loadFirmware(), log: (line) => lines.push(line) });
  await device.start();
  await device.close();
  const said = lines.length;
  const response = await device.handle("GET", "/api/version");
  assert.equal(response.status, 503);
  assert.equal(errorOf(response), "The emulator has stopped");
  // A key held down would tick every 150 ms until it is let go.
  assert.equal(device.keyDown("ok"), false);
  assert.equal(device.pressKey("start"), false);
  assert.equal(device.held.size, 0);
  // A settings program of the firmware powers the bar off a moment after it is asked to.
  device.powerOff("asked after the BUSY Bar was let go of");
  assert.equal(device.powered, true, "it was not powered off: it is gone");
  assert.deepEqual(lines.slice(said), []);
  assert.deepEqual(await activeResourcesSettled(before), before);
});

test("a restart of the BUSY Bar, requests straight after it, a stop: nothing is done or logged after the stop", async (t) => {
  // Timers made by the server's code once a stop is over, each with where it was made.
  const late = [];
  let stopped = false;
  const hook = createHook({
    init(id, type) {
      if (!stopped || type !== "Timeout") return;
      const made = new Error().stack;
      if (/packages[\\/]server[\\/]/.test(made)) late.push(made);
    },
  }).enable();
  t.after(() => hook.disable());
  // A connection made beforehand, so that a request written to it is at the server at once. `ask` gives what came
  // back: the status of the answer, or "closed" when the server closed the connection without one.
  const connect = (emulator) =>
    new Promise((resolve, reject) => {
      const socket = net.connect(emulator.port, "127.0.0.1", () => resolve(socket));
      socket.on("error", reject);
    });
  const ask = (socket, path) =>
    new Promise((resolve) => {
      let answer = "";
      socket.on("data", (chunk) => {
        answer += chunk;
        if (answer.includes("\r\n\r\n")) resolve(Number(answer.split(" ")[1]));
      });
      socket.on("error", () => resolve("closed"));
      socket.on("close", () => resolve("closed"));
      socket.write(`POST ${path} HTTP/1.1\r\nHost: localhost:${socket.remotePort}\r\nContent-Length: 0\r\n\r\n`);
    });
  const outcomes = {};
  for (let round = 0; round < 30; round++) {
    stopped = false;
    const emulator = await start(t);
    await installApp(emulator.url, "app.test.restart", "setInterval(function () {}, 100);");
    const sockets = await Promise.all([0, 1, 2, 3, 4].map(() => connect(emulator)));
    t.after(() => sockets.forEach((socket) => socket.destroy()));
    // The restart and, in the same breath, requests that reach the bar while it restarts and wait for it.
    const restart = ask(sockets[0], "/_emu/power?action=restart");
    const asked = ["/api/audio/volume?volume=20", "/api/apps/launch?app_id=app.test.restart", "/api/input?key=ok", "/_emu/key?key=start&action=down"].map((path, i) => ask(sockets[i + 1], path));
    assert.equal(await restart, 200);
    // The stop comes while they wait: at once, or a turn or two of the event loop later.
    for (let turns = round % 3; turns > 0; turns--) await turn();
    await emulator.stop();
    stopped = true;
    const said = emulator.lines.length;
    for (const outcome of await Promise.all(asked)) outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    // Longer than the speaker's warm-up, after which a click would have played.
    await pause(150);
    assert.deepEqual(late, [], "no timer is made after the stop");
    assert.deepEqual(emulator.lines.slice(said), [], "nothing is logged after the stop");
  }
  t.diagnostic(`what the requests that waited got: ${JSON.stringify(outcomes)}`);
});

test("a port that a program holds on every address of the computer counts as in use", async (t) => {
  // Such a program does not keep 127.0.0.1 of the same port from being taken, on macOS, Linux or Windows.
  for (const everywhere of ["0.0.0.0", "::"]) {
    const other = net.createServer((socket) => socket.on("error", () => {}).resume());
    const listening = await new Promise((resolve) => other.once("error", (error) => resolve(error.code)).listen(port(0), everywhere, () => resolve("")));
    if (listening) {
      t.diagnostic(`cannot listen on ${everywhere} here (${listening}): not checked`);
      continue;
    }
    t.after(() => other.listening && new Promise((resolve) => other.close(resolve)));
    const taken = other.address().port;
    const dataDir = join(tempDir(t), "data");
    await assert.rejects(startServer({ port: taken, dataDir }), (error) => {
      assert.equal(error.code, "EADDRINUSE");
      assert.match(error.message, new RegExp(`^Port ${taken} on 127\\.0\\.0\\.1 is in use`));
      return true;
    });
    assert.ok(!existsSync(dataDir), "the data folder was not made");
    await new Promise((resolve) => other.close(resolve));
  }
});

test("the server listens on this computer's own address only", async (t) => {
  const emulator = await start(t);
  assert.match(emulator.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const addresses = Object.values(networkInterfaces()).flat().filter((i) => i.family === "IPv4" && !i.internal).map((i) => i.address);
  if (!addresses.length) t.diagnostic("no network address on this computer: only the address in the handle was checked");
  // On the computer's addresses in the network nothing answers on that port.
  for (const address of addresses) await assert.rejects(get(`http://${address}:${emulator.port}/api/version`), { code: "ECONNREFUSED" });
});

test("a data folder that cannot be used: an error that says what is wrong, and nothing left behind", async (t) => {
  const parent = tempDir(t);
  const before = await activeResourcesAtRest();
  const wanted = await knownPort(0);
  const refused = async (dataDir, why) => {
    await assert.rejects(startServer({ port: wanted, dataDir }), (error) => {
      assert.equal(error.code, "EMU_DATA_FOLDER");
      assert.equal(error.message, `The data folder ${dataDir} cannot be used: ${why}. Name another folder, or put this one right.`);
      assert.ok(error.cause, "the system's own error is kept as the cause");
      return true;
    });
    assert.deepEqual(await activeResourcesSettled(before), before);
  };
  // A file where the folder should be, and a file further down.
  const file = join(parent, "a-file");
  writeFileSync(file, "not a folder");
  await refused(file, "a file stands where one of its folders should be");
  const half = join(parent, "half");
  mkdirSync(half);
  writeFileSync(join(half, "bar"), "not a folder");
  await refused(half, "a file stands where one of its folders should be");
  // Folders this user may not write to (not on Windows, where a folder cannot be made so, and not for root).
  if (process.platform !== "win32" && process.getuid() !== 0) {
    const locked = join(parent, "locked");
    const inside = join(parent, "inside");
    mkdirSync(locked);
    const apps = join(inside, "bar", "1.3.1", "ext", "user_assets");
    mkdirSync(apps, { recursive: true });
    chmodSync(locked, 0o555);
    chmodSync(apps, 0o555);
    try {
      await refused(join(locked, "data"), "this user may not make folders there");
      await refused(inside, `this user may not write to ${apps}`);
    } finally {
      chmodSync(locked, 0o755);
      chmodSync(apps, 0o755);
    }
  }
  // The port was let go of every time: a server starts on it, on a folder that is not there yet.
  const emulator = await startServer({ port: wanted, dataDir: join(parent, "made", "on", "the", "way") });
  t.after(() => emulator.stop());
  assert.equal((await get(`${emulator.url}/api/version`)).status, 200);
});

test("there is no BUSY Bar without a firmware", () => {
  assert.throws(() => new Device({ dataDir: "unused", log: () => {} }), { name: "TypeError", message: /^Device needs the firmware the BUSY Bar runs/ });
  assert.throws(() => new AppRuntime({ appId: "app.test.none", heapKib: 64 }), /^Error: AppRuntime needs the firmware/);
});

test("the BUSY Bar's speed, shared by every server in the process, cannot be changed", () => {
  assert.ok(Object.isFrozen(bar) && Object.isFrozen(bar.model) && Object.isFrozen(bar.network));
  assert.throws(() => (bar.model.opMs = 1), TypeError);
});

test("an app's runtime ended while it was loading makes no engine and runs nothing", async () => {
  const said = [];
  const ended = [];
  const runtime = new AppRuntime({
    firmware: loadFirmware(),
    appId: "app.test.ended",
    heapKib: 64,
    entry: "/main.js",
    readFile: (path) => (path === "/main.js" ? new TextEncoder().encode('console.log("ran");') : null),
    writeFile: () => false,
    localApi: async () => ({ status: 404, headers: [], body: new Uint8Array() }),
    onConsole: (severity, text) => said.push(text),
    onLog: () => {},
    onExit: (reason) => ended.push(reason),
  });
  const starting = runtime.start();
  runtime.terminate("ended by the test");
  assert.equal(await starting, 0);
  assert.deepEqual(ended, ["ended by the test"]);
  assert.deepEqual(said, []);
  assert.equal(runtime.M, undefined, "no engine is kept for it");
});

test("the device window stops looking at the displays when its last event stream is closed", async (t) => {
  // The window's timers that are alive, by the line that made them.
  const alive = new Map();
  const hook = createHook({
    init(id, type) {
      if (type !== "Timeout") return;
      const made = new Error().stack.split("\n").find((line) => line.includes("device-window.mjs"));
      if (made) alive.set(id, made);
    },
    destroy: (id) => alive.delete(id),
  }).enable();
  t.after(() => hook.disable());
  const emulator = await start(t);
  const idle = alive.size;
  const streams = [];
  for (let i = 0; i < 2; i++) {
    const socket = net.connect(emulator.port, "127.0.0.1", () => socket.write(`GET /_emu/events HTTP/1.1\r\nHost: localhost:${emulator.port}\r\n\r\n`));
    socket.on("error", () => {});
    await new Promise((resolve) => socket.once("data", resolve));
    streams.push(socket);
  }
  assert.equal(alive.size, idle + 1, "one timer looks at the displays while a window is open");
  streams[0].destroy();
  await pause(100);
  assert.equal(alive.size, idle + 1, "it goes on for the window that is left");
  streams[1].destroy();
  await until("the timer to stop", () => alive.size === idle, 2000);
});
