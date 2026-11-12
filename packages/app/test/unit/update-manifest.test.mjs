// The signed manifest of the built-in update (EMU-221): what is accepted, and every way it is refused.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import { manifestBytes, publicKeyOf, samePublicKey, signManifest, UPDATE_ASSETS, UPDATE_PUBLIC_KEY, updateAssetFor, verifyManifest } from "../../src/update-manifest.mjs";

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: publicKey.export({ type: "spki", format: "pem" }) };
};
const ours = pair();
const theirs = pair();
const assets = [
  { name: "busybar-emulator-mac-arm64.zip", size: 1000, sha256: "a".repeat(64) },
  { name: "busybar-emulator-win-x64-setup.exe", size: 2000, sha256: "b".repeat(64) },
];
const made = (version = "0.1.0-beta.2", key = ours.privateKey) => {
  const bytes = manifestBytes({ version, assets, released: "2026-11-12T00:00:00.000Z" });
  return { bytes, sig: signManifest(bytes, key) };
};
const check = (bytes, sig, o = {}) => verifyManifest(bytes, sig, { publicKey: ours.publicKey, expected: "0.1.0-beta.2", current: "0.1.0-beta.1", ...o });
const refused = (code) => (e) => e.code === code;

test("a manifest signed with the release's key is taken, with its assets", () => {
  const { bytes, sig } = made();
  const manifest = check(bytes, sig);
  assert.equal(manifest.version, "0.1.0-beta.2");
  assert.equal(manifest.app, "app.busy.emulator");
  assert.deepEqual(manifest.assets, assets);
});

test("no signature, an empty one, a broken one and one of another key are refused", () => {
  const { bytes, sig } = made();
  assert.throws(() => check(bytes, null), refused("no_signature"));
  assert.throws(() => check(bytes, "   \n"), refused("no_signature"));
  assert.throws(() => check(bytes, "not base64 at all!"), refused("bad_signature"));
  assert.throws(() => check(bytes, Buffer.alloc(64).toString("base64")), refused("bad_signature"));
  assert.throws(() => check(bytes, made("0.1.0-beta.2", theirs.privateKey).sig), refused("bad_signature"));
  // The key in the app's code is not the test's: a manifest the test signed does not pass it.
  assert.throws(() => verifyManifest(bytes, sig, { expected: "0.1.0-beta.2", current: "0.1.0-beta.1" }), refused("bad_signature"));
});

test("one changed byte of the manifest breaks its signature", () => {
  const { bytes, sig } = made();
  const text = bytes.toString("utf8").replace('"size": 1000', '"size": 1001');
  assert.throws(() => check(Buffer.from(text), sig), refused("bad_signature"));
  const sha = bytes.toString("utf8").replace("a".repeat(64), "c".repeat(64));
  assert.throws(() => check(Buffer.from(sha), sig), refused("bad_signature"));
});

test("a downgrade, the same version and a manifest of another version than offered are refused", () => {
  const older = made("0.1.0-beta.1");
  assert.throws(() => check(older.bytes, older.sig, { expected: "0.1.0-beta.1" }), refused("not_newer"));
  const same = made("0.1.0-beta.2");
  assert.throws(() => check(same.bytes, same.sig, { current: "0.1.0-beta.2" }), refused("not_newer"));
  assert.throws(() => check(same.bytes, same.sig, { current: "0.1.0" }), refused("not_newer"), "0.1.0-beta.2 is before 0.1.0");
  const other = made("0.1.0-beta.3");
  assert.throws(() => check(other.bytes, other.sig), refused("other_version"));
  assert.equal(check(other.bytes, other.sig, { expected: "0.1.0-beta.3" }).version, "0.1.0-beta.3");
});

test("a signed manifest of another program, or of another form, is refused", () => {
  const sign = (object) => {
    const bytes = Buffer.from(JSON.stringify(object));
    return [bytes, signManifest(bytes, ours.privateKey)];
  };
  assert.throws(() => check(...sign({ app: "app.other", format: 1, version: "0.1.0-beta.2", assets })), refused("other_app"));
  assert.throws(() => check(...sign({ app: "app.busy.emulator", format: 2, version: "0.1.0-beta.2", assets })), refused("bad_manifest"));
  assert.throws(() => check(...sign({ app: "app.busy.emulator", format: 1, version: "0.1.0-beta.2", assets: [{ ...assets[0], name: "../x.zip" }] })), refused("bad_manifest"));
  assert.throws(() => check(...sign({ app: "app.busy.emulator", format: 1, version: "0.1.0-beta.2", assets: [{ ...assets[0], size: 5 * 1024 ** 3 }] })), refused("bad_manifest"));
  assert.throws(() => check(...sign({ app: "app.busy.emulator", format: 1, version: "0.1.0-beta.2", assets: [assets[0], assets[0]] })), refused("bad_manifest"));
  assert.throws(() => check(...sign({ app: "app.busy.emulator", format: 1, version: "v0.1.0-beta.2", assets })), refused("bad_manifest"));
  const [notJson, sig] = [Buffer.from("{not json"), signManifest(Buffer.from("{not json"), ours.privateKey)];
  assert.throws(() => check(notJson, sig), refused("bad_manifest"));
  assert.throws(() => check(Buffer.alloc(70 * 1024, 32), sig), refused("bad_manifest"));
});

test("the manifest's bytes refuse what the app would refuse", () => {
  assert.throws(() => manifestBytes({ version: "beta", assets }), refused("bad_manifest"));
  assert.throws(() => manifestBytes({ version: "0.1.0", assets: [{ name: "a/b.zip", size: 1, sha256: "a".repeat(64) }] }), refused("bad_manifest"));
  assert.throws(() => manifestBytes({ version: "0.1.0", assets: [{ name: "a.zip", size: 1, sha256: "A".repeat(64) }] }), refused("bad_manifest"));
});

test("the app's public key is an Ed25519 key, and the key pair's halves are recognized", () => {
  assert.ok(samePublicKey(UPDATE_PUBLIC_KEY, UPDATE_PUBLIC_KEY));
  assert.ok(samePublicKey(publicKeyOf(ours.privateKey.export({ type: "pkcs8", format: "pem" })), ours.publicKey));
  assert.ok(!samePublicKey(ours.publicKey, theirs.publicKey));
  assert.ok(!samePublicKey(ours.publicKey, "not a key"));
  assert.throws(() => signManifest(Buffer.from("x"), generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey), refused("bad_key"));
});

test("each system installs its own file of the release", () => {
  assert.equal(updateAssetFor("darwin", "arm64"), "busybar-emulator-mac-arm64.zip");
  assert.equal(updateAssetFor("darwin", "x64"), "busybar-emulator-mac-x64.zip");
  assert.equal(updateAssetFor("win32", "x64"), "busybar-emulator-win-x64-setup.exe");
  assert.equal(updateAssetFor("win32", "arm64"), null);
  assert.equal(updateAssetFor("linux", "x64"), null);
  assert.equal(Object.keys(UPDATE_ASSETS).length, 3);
});
