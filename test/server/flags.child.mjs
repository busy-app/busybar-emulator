// Run by lifecycle.test.mjs in a process of its own:  node --allow-natives-syntax flags.child.mjs <port> <data folder>
//
// The server switches two of V8's wasm flags while it compiles a firmware's runtime, and they belong to the whole
// process. This says how V8 treats a small wasm module of the process's own before the server starts, while it runs
// (the runtime compiled) and after it stopped, as one line of JSON: for each moment, whether the module's function
// was left uncompiled until its first call (lazy compilation) and compiled by the baseline compiler (liftoff) — V8's
// defaults, which is what a process started without flags of its own has.
import { startServer } from "../../packages/server/server.mjs";

const [port, dataDir] = [Number(process.argv[2]), process.argv[3]];
// (module (func (export "f") (result i32) i32.const <n>)): different bytes each time, so that V8 compiles each anew.
const module = (n) => Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 5, 1, 1, 102, 0, 0, 10, 6, 1, 4, 0, 65, n, 11]);
// V8's own test functions, there with --allow-natives-syntax.
const uncompiled = new Function("f", "return %IsUncompiledWasmFunction(f)");
const baseline = new Function("f", "return %IsLiftoffFunction(f)");
let n = 0;
function probe() {
  // Several modules, each new to V8. With lazy compilation every function is uncompiled until it is called. With
  // liftoff a function is baseline code after its first call — unless V8 threw that code away in between, which a
  // collection of garbage at that very moment can do; so one module that shows it is enough.
  const seen = [1, 2, 3, 4, 5].map(() => {
    const { f } = new WebAssembly.Instance(new WebAssembly.Module(module(++n))).exports;
    const lazy = uncompiled(f);
    f();
    return { lazy, liftoff: baseline(f) };
  });
  return { lazy: seen.every((one) => one.lazy), liftoff: seen.some((one) => one.liftoff) };
}

const before = probe();
const emulator = await startServer({ port, dataDir });
const running = probe();
await emulator.stop();
console.log(JSON.stringify({ before, running, after: probe() }));
