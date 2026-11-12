// The server's key and its file (ADR-0012 section 3), without a server.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { authorizationFor, createServerKey, keyAuthorizes, readServerKey, removeServerKey, writeServerKey } from "../server-key.mjs";

const windows = process.platform === "win32";
function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "busybar-emulator-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("every key is new: 32 random bytes, in characters that need no quoting anywhere", () => {
  const keys = new Set(Array.from({ length: 100 }, createServerKey));
  assert.equal(keys.size, 100);
  for (const key of keys) assert.match(key, /^[A-Za-z0-9_-]{43}$/);
});

test("the key file is the user's alone, holds the key and nothing else, and is read back", (t) => {
  const dir = folder(t);
  const key = createServerKey();
  assert.equal(writeServerKey(dir, key), true);
  assert.equal(readFileSync(join(dir, "key"), "utf8"), `${key}\n`);
  if (!windows) assert.equal(statSync(join(dir, "key")).mode & 0o777, 0o600);
  assert.equal(readServerKey(dir), key);
  // A new start writes a new key over the old one.
  const next = createServerKey();
  writeServerKey(dir, next);
  assert.equal(readServerKey(dir), next);
});

test("a link where the key file goes is replaced, not followed, and never read as a key", { skip: windows && "links need a privilege on Windows" }, (t) => {
  const dir = folder(t);
  const elsewhere = join(dir, "elsewhere");
  writeFileSync(elsewhere, "someone else's\n");
  symlinkSync(elsewhere, join(dir, "key"));
  assert.equal(readServerKey(dir), null, "a link is not read");
  const key = createServerKey();
  writeServerKey(dir, key);
  assert.equal(readFileSync(elsewhere, "utf8"), "someone else's\n", "the file the link named is untouched");
  assert.equal(readServerKey(dir), key);
});

test("no file, a folder or text that is not a key: no key", (t) => {
  const dir = folder(t);
  assert.equal(readServerKey(dir), null);
  writeFileSync(join(dir, "key"), "not a key\n");
  assert.equal(readServerKey(dir), null);
  rmSync(join(dir, "key"));
  mkdirSync(join(dir, "key"));
  assert.equal(readServerKey(dir), null);
});

test("a stop removes its own key, and leaves one a newer server wrote", (t) => {
  const dir = folder(t);
  const old = createServerKey();
  writeServerKey(dir, old);
  const newer = createServerKey();
  writeServerKey(dir, newer);
  removeServerKey(dir, old);
  assert.equal(readServerKey(dir), newer);
  removeServerKey(dir, newer);
  assert.equal(readServerKey(dir), null);
  removeServerKey(dir, newer); // gone already: nothing happens
});

test("the check: the key as a bearer token, nothing more, nothing less", () => {
  const key = createServerKey();
  assert.equal(keyAuthorizes(authorizationFor(key), key), true);
  assert.equal(keyAuthorizes(`bearer ${key}`, key), true, "the scheme's name is not case-sensitive");
  assert.equal(keyAuthorizes(`  Bearer ${key}  `, key), true);
  const wrong = [
    undefined,
    "",
    key,
    `Basic ${key}`,
    `Bearer ${key}x`,
    `Bearer ${key.slice(0, -1)}`,
    `Bearer ${key.slice(0, -1)}${key.at(-1) === "A" ? "B" : "A"}`,
    `Bearer ${key} ${key}`,
    `Bearer  ${key}`,
    `Bearer ${createServerKey()}`,
    ["Bearer", key],
  ];
  for (const header of wrong) assert.equal(keyAuthorizes(header, key), false, JSON.stringify(header));
  // A server without a key answers nobody.
  assert.equal(keyAuthorizes("Bearer null", null), false);
  assert.equal(keyAuthorizes("Bearer ", ""), false);
});
