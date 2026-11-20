// node:test for the window's tests (test/app/*.test.mjs), with a time limit for every test and every hook: a test that
// hangs (an app that stopped answering, a wait for a line that never comes) fails at its own limit, its file goes on
// with the next test, and the file ends in minutes, not at the gate's limit for the whole suite (EMU-330).
//
// The limit is given to each test here, not by --test-timeout: Node 22, the Mac's, applies that option to a test
// file as a whole (its test processes never see it), and Node 24 to each test. A test that needs longer says so with
// its own { timeout }. test/unit/window-tests.test.mjs checks that every window test file takes its test and hooks
// from here.
import * as nodeTest from "node:test";
import vm from "node:vm";

/**
 * Longer than the longest window test there is on a loaded machine (the card at every width: 3.5 min on Windows),
 * shorter than a third of the suite's limit.
 */
export const TEST_TIMEOUT_MS = 5 * 60_000;
/** A hook starts or ends an app: a minute on a loaded machine. */
export const HOOK_TIMEOUT_MS = 3 * 60_000;

/**
 * node:test names a test's place (TAP's location, the file the reporters are told, which the gate's list of known
 * flakes and gate:repeat go by) by the caller of its test(): called from here, every test would be named here. So the
 * one call is made from a function compiled at the caller's own file, line and column (vm.compileFunction), and the
 * test keeps its place in every report. One such function for each place a test is written.
 */
const calls = new Map();
const CALL = "return test(name, options, fn);";
const CALL_COLUMN = CALL.indexOf("test(");
function callFrom(site) {
  const file = site.getFileName();
  const line = site.getLineNumber();
  const column = site.getColumnNumber();
  const key = `${file}:${line}:${column}`;
  let call = calls.get(key);
  if (!call) {
    // The call to test() at the caller's line and column: the offsets apply to the first line, where it is (a negative
    // column offset is allowed: "return " comes before it).
    call = vm.compileFunction(CALL, ["test", "name", "options", "fn"], { filename: file, lineOffset: line - 1, columnOffset: column - 1 - CALL_COLUMN });
    calls.set(key, call);
  }
  return call;
}

/** Where `fn` was called from: the V8 call site of its caller. */
function callerOf(fn) {
  const keep = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_error, sites) => sites;
    const holder = {};
    Error.captureStackTrace(holder, fn);
    return holder.stack[0];
  } finally {
    Error.prepareStackTrace = keep;
  }
}

const HOOKS = ["before", "after", "beforeEach", "afterEach"];

/**
 * The test's context with the same limits for what is made from it: a hook it adds (t.after, t.before, …) gets
 * HOOK_TIMEOUT_MS, a subtest (t.test) TEST_TIMEOUT_MS, unless they give their own (EMU-330 review: a t.after that hung
 * held its file past the test's own limit). Exported for the tests.
 */
export function limitedContext(t) {
  return new Proxy(t, {
    get(target, prop) {
      if (HOOKS.includes(prop)) return (fn, options = {}) => target[prop](fn, { timeout: HOOK_TIMEOUT_MS, ...options });
      if (prop === "test") {
        return (name, options, fn) => {
          if (typeof options === "function") [options, fn] = [{}, options];
          return target.test(name, { timeout: TEST_TIMEOUT_MS, ...options }, limited(fn));
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** `fn` given the limited context; a function that takes node:test's `done` keeps it (node:test goes by its length). */
function limited(fn) {
  if (typeof fn !== "function") return fn;
  return fn.length >= 2 ? (t, done) => fn(limitedContext(t), done) : (t) => fn(limitedContext(t));
}

function normalized(options, fn) {
  return typeof options === "function" ? [{}, options] : [options ?? {}, fn];
}

/** test(name, [options], fn), with TEST_TIMEOUT_MS unless the options give a timeout of their own. */
export function test(name, options, fn) {
  [options, fn] = normalized(options, fn);
  return callFrom(callerOf(test))(nodeTest.test, name, { timeout: TEST_TIMEOUT_MS, ...options }, limited(fn));
}
// test.skip, test.todo and test.only, as node:test has them, each with its place.
for (const flag of ["skip", "todo", "only"]) {
  const variant = (name, options, fn) => {
    [options, fn] = normalized(options, fn);
    return callFrom(callerOf(variant))(nodeTest.test, name, { timeout: TEST_TIMEOUT_MS, [flag]: true, ...options }, limited(fn));
  };
  test[flag] = variant;
}

/** Not here: a window test file's tests are at its top level, each with test() (each its own limit and place). */
export function describe() {
  throw new Error("node-test.mjs has no describe or suite: write the window test file's tests at its top level, each with test()");
}
export const suite = describe;
export const it = describe;

const hook = (which) => (fn, options = {}) => nodeTest[which](fn, { timeout: HOOK_TIMEOUT_MS, ...options });
export const before = hook("before");
export const after = hook("after");
export const beforeEach = hook("beforeEach");
export const afterEach = hook("afterEach");
