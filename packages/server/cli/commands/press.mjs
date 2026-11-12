// busy-emulator press <up|down|ok|back|start> [--times <n>] [--hold <ms>]: a button of the emulated BUSY Bar, or a click
// of its wheel, as a hand does it. The agent's hands: in the field test every `curl` to the BUSY Bar's address was refused
// by the agent's permissions, so the buttons of every app went untested.
//
// A press is the BUSY Bar's own input API, POST /api/input?key=…, as a client of a real BUSY Bar sends it: press, short,
// release at once. `up` and `down` are the wheel, one click (an app gets the key "encoder", clockwise for up). With
// --hold the button goes down, stays down that long and comes up (the emulator's POST /_emu/key, which the device
// window's buttons use): from 300 ms on an app gets "long", then "repeat"; a long Back is the firmware's own, it
// force-quits the app. --times repeats the press. The command does not start the emulator and writes nothing.
//
// A BUSY Bar that is powered off (from its settings, or with an empty battery) answers nothing over its API, so the key
// reaches nothing: the answer is bar_off. On a BUSY Bar a press of one of its own buttons turns it on, and that press goes to
// no app; --power-on does that here (the hardware press, POST /_emu/press) and waits until the BUSY Bar is up. The mode
// switch at OFF is another thing: the BUSY Bar is on and takes keys, its screens are dark.
import { blockedNetwork, commandLine, emulatorStatus, ready } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";

export const KEYS = Object.freeze(["up", "down", "ok", "back", "start"]);
const USAGE = "press <up|down|ok|back|start> [--times <n>] [--hold <ms>] [--power-on]";
/** Between two presses: an app that redraws after a key gets its turn. */
const GAP_MS = 60;
const MAX_TIMES = 100;
const MAX_HOLD_MS = 10_000;

const WHAT = { up: "Turned the wheel up one click", down: "Turned the wheel down one click", ok: "Pressed OK (the wheel's button)", back: "Pressed Back", start: "Pressed Start" };

function wholeNumber(value, flag, min, max, self) {
  const number = /^\d{1,6}$/.test(value) ? Number(value) : NaN;
  if (!(number >= min && number <= max)) throw new CliError("usage", `${flag} takes a whole number from ${min} to ${max}, not ${JSON.stringify(value)}.`, `Usage: ${self} ${USAGE}`, { option: flag });
  return number;
}

export default {
  name: "press",
  summary: "Press a button of the emulated BUSY Bar or turn its wheel one click (--times repeats, --hold <ms> holds it down)",
  usage: USAGE,
  maxArguments: 1,
  options: { "--times": { key: "times", value: "<n>" }, "--hold": { key: "hold", value: "<ms>" }, "--power-on": { key: "powerOn" } },
  async run(ctx, sys, { args, options }) {
    const self = commandLine(ctx);
    const key = (args[0] ?? "").toLowerCase();
    if (!KEYS.includes(key)) {
      throw new CliError("usage", args.length ? `There is no key ${JSON.stringify(args[0])}: the keys are ${KEYS.join(", ")} (up and down turn the wheel).` : `press needs a key: ${KEYS.join(", ")} (up and down turn the wheel).`, `Usage: ${self} ${USAGE}`, { argument: args[0] ?? null, keys: KEYS });
    }
    const times = options.times === undefined ? 1 : wholeNumber(options.times, "--times", 1, MAX_TIMES, self);
    const hold = options.hold === undefined ? null : wholeNumber(options.hold, "--hold", 1, MAX_HOLD_MS, self);
    if (hold !== null && (key === "up" || key === "down")) throw new CliError("usage", `--hold is for a button (ok, back, start): the wheel turns in clicks; ${key} with --times turns it further.`, `Usage: ${self} ${USAGE}`, { option: "--hold" });

    const status = await emulatorStatus(ctx, sys);
    if (!ready(status)) {
      const hint = `Start it with ${self} start, then run ${self} press ${key} again.`;
      if (!status.running) throw new CliError("not_running", "The emulator is not running, so there is no BUSY Bar whose buttons to press.", hint);
      throw new CliError("not_running", `The emulator is running, but its BUSY Bar is not ready (${status.state}).`, hint);
    }
    const { port } = status;
    const address = `127.0.0.1:${port}`;
    const powered = async () => {
      const answer = await sys.barGet(port, "/_emu/state");
      if (answer.status !== 200) return null;
      try {
        return JSON.parse(answer.body).powered ?? null;
      } catch {
        return null;
      }
    };
    const barOff = () =>
      new CliError(
        "bar_off",
        `The emulated BUSY Bar at ${address} is powered off, so the key ${key} reached nothing: a BUSY Bar that is off answers nothing over its API, and a press of one of its own buttons only turns it on.`,
        `Turn it on with ${self} press ${key} --power-on (or a button in the emulator's window), then press again.`,
        { key },
      );
    if (options.powerOn && (await powered()) === false) {
      // The hand's press on a bar that is off: it turns on, and the press goes to no app.
      const answer = await sys.barSend(port, "POST", `/_emu/press?key=${key}`);
      if (answer.blocked) throw blockedNetwork(port, answer.blocked);
      if (answer.failed || answer.status !== 200) throw new CliError("press_failed", `The emulated BUSY Bar at ${address} did not take the press that turns it on (${answer.failed ?? `HTTP ${answer.status}`}).`, `Check that it is the emulator that listens there: ${self} status.`, { key });
      // The bar's API answers once the bar is up.
      let up = false;
      for (let n = 0; n < 3 && !up; n++) up = (await sys.barGet(port, "/api/version")).status === 200;
      return {
        data: { key, times: 0, hold_ms: null, address, powered_on: true, up },
        text: `The emulated BUSY Bar at ${address} was off: pressing ${key} turned it on, as on a BUSY Bar, and reached no app. ${up ? "It is up" : "It is still starting"}: ${self} press ${key} now goes to the BUSY Bar.`,
      };
    }
    const send = async (pathname) => {
      const answer = await sys.barSend(port, "POST", pathname);
      if (answer.blocked) throw blockedNetwork(port, answer.blocked);
      if (answer.failed || answer.status !== 200) {
        if (answer.status === 503 && (await powered()) === false) throw barOff();
        let said = "";
        try {
          said = JSON.parse(answer.body ?? "").error ?? "";
        } catch {
          // no JSON: the status alone
        }
        throw new CliError("press_failed", `The emulated BUSY Bar at ${address} did not take the key ${key} (${answer.failed ?? `HTTP ${answer.status}${said ? `: ${said}` : ""}`}).`, `Check that it is the emulator that listens there: ${self} status.`, { key });
      }
    };
    // The hardware's button on a bar that is off would turn it on (keyDown); a press asked to hold is not that.
    if (hold !== null && (await powered()) === false) throw barOff();
    for (let n = 0; n < times; n++) {
      if (n) await sys.sleep(GAP_MS);
      if (hold === null) await send(`/api/input?key=${key}`);
      else {
        await send(`/_emu/key?key=${key}&action=down`);
        try {
          await sys.sleep(hold);
        } finally {
          await send(`/_emu/key?key=${key}&action=up`);
        }
      }
    }
    const how = `${hold === null ? "" : `, held ${hold} ms`}${times > 1 ? `, ${times} times` : ""}`;
    return {
      data: { key, times, hold_ms: hold, address },
      text: `${WHAT[key]}${how} on the emulated BUSY Bar at ${address}. To see what the app made of it: ${self} screenshot --scale 8, ${self} logs.`,
    };
  },
};
