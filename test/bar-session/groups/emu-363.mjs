// EMU-363: clearInterval inside the interval's own handler. js_interval.c's interval_callback calls the handler, and
// clearInterval in it frees the handler while it runs (JerryScript keeps no reference to the running function): the
// next garbage collection in the handler may free its bytecode. No network: the handler clears itself, then allocates
// thousands of objects and makes a closure. In the emulator (18.11) inline ends the app with a fatal assertion
// (jerryscript fatal error 120); named runs to its end.
//   inline   the handler written in place, held by nothing but the interval (the case that fails in the emulator);
//   named    the control: the same handler held in a variable of the module.
// Each waits for OK (a fatal error reloads the app or restarts the BUSY Bar, and APPS would open it again); both need
// --consent reboot. What the app saved and the log are raw.
import { sleep } from "../lib.mjs";

// Thousands of objects, most of them garbage at once: a collection comes whatever the heap's size (96 KiB in the CLI,
// 128 KiB for an app of the APPS menu).
const BODY = `clearInterval(id); let a = []; let made = 0; for (let i = 0; i < 20000; i++) { a.push({ i }); made++; if (a.length >= 1000) a = []; } const f = () => console.log("kit-gc closure " + made); f(); localStorage.setItem("gc", JSON.stringify({ phase: "done", made }));`;
// The interval is set up by code of its own (eval), as a script's top level sets it up: once that code has run, nothing
// but the interval holds the inline handler. (Set up in the OK handler itself, the handler's code would stay held by
// the OK handler's, and nothing fails.) The marker in localStorage keeps a run that APPS opens again from doing it again.
const SETUP = {
  inline: `id = setInterval(() => { ${BODY} }, 100);`,
  named: `handler = () => { ${BODY} }; id = setInterval(handler, 100);`,
};
const SCRIPTS = Object.fromEntries(
  Object.entries(SETUP).map(([kind, setup]) => [
    kind,
    `let id; let handler; listen("input", function (e) { if (e.key !== "ok" || e.action !== "short" || localStorage.getItem("gc")) return; localStorage.setItem("gc", JSON.stringify({ phase: "started" })); eval(${JSON.stringify(setup)}); });`,
  ]),
);

export default {
  id: "EMU-363",
  title: "clearInterval inside its own handler, then a garbage collection",
  async run(ctx) {
    const device = ctx.device;
    for (const kind of ["inline", "named"]) {
      await ctx.part(kind, { firmware: "1.4.1", consent: ["reboot"] }, async () => {
        const id = ctx.app(`gc.${kind}`);
        const marker = ctx.marker(kind);
        try {
          await device.install(id, { "scripts/main.js": `console.log(${JSON.stringify(marker)});\n${SCRIPTS[kind]}\nsetInterval(function () {}, 1000);\n` });
          await device.launch(id);
          await sleep(1500);
          const got = await ctx.risky(id, "gc", (v) => v.phase === "done", 10000);
          ctx.observe(`${kind}: what the app saved`, got.outcome === "done" ? got.value : { outcome: got.outcome, saved: got.value, displays: got.frames }, "raw");
          ctx.observe(`${kind}: log`, await device.logAfter(marker).catch(() => []), "raw");
        } finally {
          if ((await device.waitUp(180000)) !== null) await device.remove(id);
        }
      });
    }
  },
};
