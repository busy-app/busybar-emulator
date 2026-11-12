import assert from "node:assert/strict";
import { test } from "node:test";

import { createRestartPolicy } from "../../src/restart-policy.mjs";

test("the third death within a minute is the last", () => {
  let t = 0;
  const policy = createRestartPolicy({ now: () => t });
  assert.equal(policy.died(), true);
  t += 20_000;
  assert.equal(policy.died(), true);
  t += 20_000;
  assert.equal(policy.died(), false);
});

test("deaths more than a minute apart never stop the restarts", () => {
  let t = 0;
  const policy = createRestartPolicy({ now: () => t });
  for (let i = 0; i < 20; i++) {
    assert.equal(policy.died(), true, `death ${i + 1}`);
    t += 31_000;
  }
});

test("a death leaves the window after exactly a minute", () => {
  let t = 0;
  const policy = createRestartPolicy({ now: () => t });
  policy.died();
  t = 59_999;
  policy.died();
  t = 60_000; // the first one is a minute old now
  assert.equal(policy.died(), true);
  t = 60_001;
  assert.equal(policy.died(), false);
});

test("reset starts the count over", () => {
  const policy = createRestartPolicy({ now: () => 0 });
  policy.died();
  policy.died();
  policy.reset();
  assert.equal(policy.died(), true);
  assert.equal(policy.died(), true);
  assert.equal(policy.died(), false);
});
