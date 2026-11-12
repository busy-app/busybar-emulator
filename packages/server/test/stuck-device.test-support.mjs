// A device whose firmware hangs in a wait, for waits.test.mjs: makes a thread of the system sleep without end (the
// screen module's probe for tests) and says what the server did about it, as one line of JSON. A process of its own,
// so that the test can stop it: node stuck-device.test-support.mjs <data folder> <firmware version>.

import { Device } from "../device.mjs";
import { loadFirmware } from "../firmware.mjs";

const lines = [];
const device = new Device({ dataDir: process.argv[2], firmware: loadFirmware(process.argv[3]), log: (line) => lines.push(line) });
await device.start();
const version = () => device.handle("GET", "http://localhost/api/version").then((r) => r.status);

const before = { boots: device.boots, version: await version() };
// What a request or a key would do if firmware code behind it polled for something that never comes.
const stuck = device.screen;
const returned = stuck.enter(() => stuck.M._emu_wait_probe(1_000_000), "the system is down");
const down = { returned, disposed: stuck.disposed === true, request: (await stuck.request("GET", "busy/snapshot", "", null)).status, frame: stuck.frame(0).every((byte) => byte === 0) };
// The restart follows; a request made while it goes on waits for it.
for (let i = 0; i < 200 && device.boots === before.boots; i++) await new Promise((done) => setTimeout(done, 50));
const after = { version: await version(), boots: device.boots, powered: device.powered, sameScreen: device.screen === stuck };

console.log(JSON.stringify({ before, down, after, lines }));
process.exit(0);
