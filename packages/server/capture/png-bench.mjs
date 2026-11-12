// How long encoding a frame takes, against the bar's tick of 8 ms (quality.md, "Budgets"). Not a test: the numbers
// depend on the machine. Frames are random, which is the worst case for deflate; the bar's real frames compress better.
// Wall time counts whatever else the computer did meanwhile; CPU time (this process, all threads) is the work itself.
//
//   node emulator/packages/server/capture/png-bench.mjs [--runs 1000]
//
// The catalog's check is timed too where catalog-png.mjs is there.
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { deflateSync } from "node:zlib";

import { commandLine } from "../arguments.mjs";
import { encodeScaledScreenPng, encodeScreenPng, scanlines, SCREENS } from "./png.mjs";

await commandLine(process.argv, { values: ["--runs"] });

const checker = new URL("./catalog-png.mjs", import.meta.url);
const checkCatalogPng = existsSync(checker) ? (await import(checker.href)).checkCatalogPng : null;

const at = process.argv.indexOf("--runs");
const runs = at >= 0 ? Number(process.argv[at + 1]) : 1000;
if (!Number.isInteger(runs) || runs < 1) {
  console.error("--runs takes a whole number of runs, 1 or more.");
  process.exit(2);
}

// A fixed pseudo-random frame, the same on every run.
function noise(bytes, seed) {
  const out = new Uint8Array(bytes);
  let s = seed;
  for (let i = 0; i < bytes; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

function measure(fn) {
  for (let i = 0; i < 50; i++) fn(); // warm up
  const wall = [];
  const cpu = [];
  for (let i = 0; i < runs; i++) {
    const startCpu = process.cpuUsage();
    const start = performance.now();
    fn();
    wall.push(performance.now() - start);
    const used = process.cpuUsage(startCpu);
    cpu.push((used.user + used.system) / 1000);
  }
  const ms = (v) => `${v.toFixed(3)} ms`;
  const sum = (t) => {
    t.sort((a, b) => a - b);
    return `median ${ms(t[Math.floor(runs / 2)])}, p99 ${ms(t[Math.floor(runs * 0.99)])}, worst ${ms(t[runs - 1])}`;
  };
  return `wall ${sum(wall)}; CPU ${sum(cpu)}`;
}

console.log(`Node ${process.version}, ${process.platform} ${process.arch}, ${runs} runs each`);
for (const name of ["front", "back"]) {
  const { width, height, frameBytes } = SCREENS[name];
  for (const [kind, frame] of [["random", noise(frameBytes, 7)], ["black", new Uint8Array(frameBytes)]]) {
    const png = encodeScreenPng(name, frame);
    console.log(`${name} ${width}×${height}, ${kind} frame: ${png.length} bytes`);
    console.log(`  encode (level 9)  ${measure(() => encodeScreenPng(name, frame))}`);
    const raw = scanlines(name, frame);
    for (const level of [1, 6]) console.log(`  deflate level ${level}   ${measure(() => deflateSync(raw, { level }))}`);
    console.log(`  deflate level 9   ${measure(() => deflateSync(raw, { level: 9 }))}`);
    console.log(`  enlarged ×8       ${measure(() => encodeScaledScreenPng(name, frame, 8))}`);
    if (checkCatalogPng) console.log(`  catalog check     ${measure(() => checkCatalogPng(png, name))}`);
  }
}
