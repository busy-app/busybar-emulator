// The server's key (ADR-0012 section 3): what a tool on this computer shows to be let in at the management address.
//
// A server makes a new key every time it starts and writes it to the file `key` in its data folder, for the user
// alone (privateFile in data-folder.mjs: 0600, made anew, never through a link); it removes the file when it stops.
// Whoever may read that file is the user, or acts for them: the command line, the app's shell, a test. The key goes
// in a request as
//
//   Authorization: Bearer <key>
//
// and nowhere else: never in an address, a log line, the output of a command, the server's arguments or its
// environment, and never into a page.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { privateFile } from "./data-folder.mjs";

export const KEY_FILE = "key";
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
// 32 random bytes, base64url: 43 characters of [A-Za-z0-9_-].
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** A new key. */
export const createServerKey = () => randomBytes(32).toString("base64url");

/** The value of the Authorization header that carries a key. */
export const authorizationFor = (key) => `Bearer ${key}`;

/**
 * Writes a server's key into its data folder. Returns whether the file system kept the user-alone rights (see
 * privateFile); false means other users of this computer may read it.
 */
export const writeServerKey = (dataDir, key) => privateFile(join(dataDir, KEY_FILE), `${key}\n`);

/** Reads the key of the server that uses a data folder; null when there is none (no server runs, or it is not a key). */
export function readServerKey(dataDir) {
  let fd;
  try {
    fd = openSync(join(dataDir, KEY_FILE), constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ELOOP") return null;
    throw e;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const key = readFileSync(fd, "utf8").trim();
    return KEY_RE.test(key) ? key : null;
  } finally {
    closeSync(fd);
  }
}

/** Removes a server's key file, if it still holds this key (a server that started since has written its own). */
export function removeServerKey(dataDir, key) {
  try {
    if (readServerKey(dataDir) === key) unlinkSync(join(dataDir, KEY_FILE));
  } catch {
    // Gone already, or cannot be removed: it is a key nobody answers to any more.
  }
}

/**
 * Whether a request's Authorization header carries the key. Compared in constant time, so that how long a refusal
 * takes says nothing about how much of a guess was right. Operations that need the key ask this.
 * @param {string | string[] | undefined} authorization  the request's Authorization header
 * @param {string} key  the server's key
 */
export function keyAuthorizes(authorization, key) {
  if (typeof authorization !== "string" || typeof key !== "string" || !KEY_RE.test(key)) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization.trim());
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const wanted = Buffer.from(key);
  // timingSafeEqual needs two of the same length; a guess of another length is compared with itself, in the same time.
  return timingSafeEqual(given.length === wanted.length ? given : wanted, wanted) && given.length === wanted.length;
}
