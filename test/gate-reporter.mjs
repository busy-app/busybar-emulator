// A reporter for node --test that test/gate.mjs adds beside TAP (--test-reporter=<this file>): for every test file,
// how many tests it registered and how many of them finished. A file that ends its process midway (process.exit(0) in
// it or in a module it imports) leaves its remaining tests registered and never finished; node --test still calls
// the run a success and its TAP shows only the tests that ran, so this is how the gate sees them (gate-lib.mjs,
// tallyEvents). One JSON line per file, at the end of the run; and the lines of progress below.
//
// Every test, suite and subtest is enqueued (test:enqueue) when it is registered and completes (test:complete) when
// it has an outcome: passed, failed, skipped or canceled. The file itself is one of them, at nesting 0, the first the
// runner enqueues for it; it is dequeued when the file starts to run and completes when its process has ended.
//
// As they happen, a line {"running": file} when a file starts and {"ended": file} when it is over: a suite the gate
// stops at its time limit names the files still running (a file that loops synchronously is stopped by nothing else:
// on Node 24 on Windows neither a test's timeout nor --test-timeout ends it).

export default async function* gateReporter(source) {
  const files = new Map(); // file → { registered, finished, open: Map<key, count>, wrapper }
  for await (const { type, data } of source) {
    if (type !== "test:enqueue" && type !== "test:dequeue" && type !== "test:complete") continue;
    const file = data?.file;
    if (!file) continue;
    let f = files.get(file);
    if (!f) files.set(file, (f = { registered: 0, finished: 0, open: new Map(), wrapper: null }));
    const key = `${data.nesting}\u0000${data.name}`;
    if (type === "test:enqueue" && data.nesting === 0 && f.wrapper === null) f.wrapper = key;
    if (type === "test:dequeue") {
      if (key === f.wrapper) yield `${JSON.stringify({ running: file })}\n`;
      continue;
    }
    if (type === "test:complete" && key === f.wrapper) yield `${JSON.stringify({ ended: file })}\n`;
    if (type === "test:enqueue") {
      f.registered++;
      f.open.set(key, (f.open.get(key) ?? 0) + 1);
    } else {
      f.finished++;
      const left = (f.open.get(key) ?? 0) - 1;
      if (left > 0) f.open.set(key, left);
      else f.open.delete(key);
    }
  }
  for (const [file, f] of files) {
    const unfinished = [...f.open.keys()].map((key) => key.split("\u0000")[1]);
    yield `${JSON.stringify({ file, registered: f.registered, finished: f.finished, unfinished })}\n`;
  }
}
