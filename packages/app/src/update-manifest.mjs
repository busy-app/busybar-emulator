// The signed manifest of a release (EMU-221): what the app's updater trusts, and the one thing it trusts.
//
// At release, tools/release writes update.json (the version and, for each file of the release, its name, size and
// SHA-256) and signs its exact bytes with the release's Ed25519 key: update.json.sig, the signature in base64. Both
// are files of the GitHub release. The app checks the signature with the public key below, which is part of its code,
// before it reads anything in the manifest; then the version, then each file it downloads against the manifest's size
// and sum. A release made without the private key cannot be installed by the updater, whatever GitHub serves.
//
// The private key lives only on the release machine (docs/release.md, "The update key"). If it is lost, the apps out
// there cannot be updated by themselves any more: a release with a new key has to be installed by hand once.
//
// Pure: no file, no network. The release tool and the app both use it.
import { createPrivateKey, createPublicKey, KeyObject, sign, verify } from "node:crypto";

import { isNewer, versionText } from "./update-check.mjs";

/** The public half of the release's update key (Ed25519, SPKI). Changing it means one manual reinstall for everyone. */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAPmw3UxDOmmyZF5J3i33s6+O9X3BoAstd4WnutFEDBRg=
-----END PUBLIC KEY-----
`;

export const MANIFEST_FILE = "update.json";
export const SIGNATURE_FILE = "update.json.sig";
/** What the manifest is of: the app's id, so that a manifest of another program signed with the same key is refused. */
export const MANIFEST_APP = "app.busy.emulator";
export const MANIFEST_FORMAT = 1;
/** The most a manifest or its signature may be: they are a few hundred bytes. */
export const MANIFEST_MAX_BYTES = 64 * 1024;
/** The most a file of a release may be (they are 150 to 250 MB): a larger one is refused before and while it downloads. */
export const ASSET_MAX_BYTES = 1024 * 1024 * 1024;

/** The file of a release the updater installs on each system (ADR-0002 §3: names that never change). */
export const UPDATE_ASSETS = Object.freeze({
  "darwin-arm64": "busybar-emulator-mac-arm64.zip",
  "darwin-x64": "busybar-emulator-mac-x64.zip",
  "win32-x64": "busybar-emulator-win-x64-setup.exe",
});

/** The asset this system installs, or null where there is none (Linux, Windows on Arm). */
export const updateAssetFor = (platform, arch) => UPDATE_ASSETS[`${platform}-${arch}`] ?? null;

export class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The manifest's bytes: one object, keys in a fixed order, two-space indent, a final newline. The signature is over
 * exactly these bytes, so nothing ever re-serializes a manifest before checking it.
 * @param {{ version: string, assets: { name: string, size: number, sha256: string }[], released?: string }} o
 */
export function manifestBytes({ version, assets, released = new Date().toISOString() }) {
  const v = versionText(version);
  if (!v || v !== version) throw new UpdateError("bad_manifest", `Not a version: ${version}`);
  const list = assets.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
  for (const a of list) assetProblem(a, (problem) => {
    throw new UpdateError("bad_manifest", problem);
  });
  return Buffer.from(`${JSON.stringify({ app: MANIFEST_APP, format: MANIFEST_FORMAT, version: v, released, assets: list }, null, 2)}\n`, "utf8");
}

function assetProblem(a, fail) {
  if (!a || typeof a !== "object") return fail("an asset of the manifest is not an object");
  if (typeof a.name !== "string" || !NAME.test(a.name)) return fail(`an asset's name is not a plain file name: ${JSON.stringify(a.name)}`);
  if (!Number.isSafeInteger(a.size) || a.size <= 0 || a.size > ASSET_MAX_BYTES) return fail(`${a.name}: the size ${a.size} is not between 1 byte and ${ASSET_MAX_BYTES} bytes`);
  if (typeof a.sha256 !== "string" || !SHA256.test(a.sha256)) return fail(`${a.name}: the SHA-256 is not 64 hex digits`);
  return null;
}

/** The signature of a manifest's bytes with the release's private key (a PEM, or a KeyObject): base64 and a newline. */
export function signManifest(bytes, privateKey) {
  const key = typeof privateKey === "string" || Buffer.isBuffer(privateKey) ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== "ed25519") throw new UpdateError("bad_key", "The update key is not an Ed25519 key");
  return `${sign(null, bytes, key).toString("base64")}\n`;
}

/** The public key (SPKI PEM) of a private one: what the release compares with UPDATE_PUBLIC_KEY. */
export function publicKeyOf(privateKey) {
  return createPublicKey(privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey)).export({ type: "spki", format: "pem" }).toString();
}

/** True when two PEMs are the same public key. */
export function samePublicKey(a, b) {
  try {
    return createPublicKey(a).export({ type: "spki", format: "der" }).equals(createPublicKey(b).export({ type: "spki", format: "der" }));
  } catch {
    return false;
  }
}

/**
 * Checks a manifest and what it says, in this order: the signature over the exact bytes (nothing is parsed before),
 * the form, the app, then the version against the one the app was told of (`expected`) and its own (`current`).
 * Returns the manifest; throws an UpdateError with a code the app turns into plain words:
 * no_signature, bad_signature, bad_manifest, other_app, other_version, not_newer.
 * @param {Buffer} bytes          update.json as downloaded
 * @param {Buffer | string | null} signature  update.json.sig as downloaded
 * @param {{ publicKey?: string, expected?: string | null, current: string }} o
 */
export function verifyManifest(bytes, signature, { publicKey = UPDATE_PUBLIC_KEY, expected = null, current }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MANIFEST_MAX_BYTES) throw new UpdateError("bad_manifest", "The update's manifest is empty or too long");
  const text = signature === null || signature === undefined ? "" : String(signature).trim();
  if (!text) throw new UpdateError("no_signature", "The update's manifest has no signature");
  if (text.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new UpdateError("bad_signature", "The update's signature is not a signature");
  const raw = Buffer.from(text, "base64");
  let good = false;
  try {
    good = raw.length === 64 && verify(null, bytes, createPublicKey(publicKey), raw);
  } catch {
    good = false;
  }
  if (!good) throw new UpdateError("bad_signature", "The update's signature does not match: it was not made with the release's key");
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new UpdateError("bad_manifest", "The update's manifest is not JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.format !== MANIFEST_FORMAT || !Array.isArray(manifest.assets)) throw new UpdateError("bad_manifest", "The update's manifest is not of a form this app reads");
  if (manifest.app !== MANIFEST_APP) throw new UpdateError("other_app", "The update's manifest is of another program");
  for (const a of manifest.assets) assetProblem(a, (problem) => {
    throw new UpdateError("bad_manifest", problem);
  });
  if (new Set(manifest.assets.map((a) => a.name)).size !== manifest.assets.length) throw new UpdateError("bad_manifest", "The update's manifest names a file twice");
  const version = versionText(manifest.version);
  if (!version || version !== manifest.version) throw new UpdateError("bad_manifest", "The update's manifest has no version");
  if (expected !== null && version !== versionText(expected)) throw new UpdateError("other_version", `The manifest is of ${version}, not of ${expected}`);
  if (!isNewer(version, current)) throw new UpdateError("not_newer", `${version} is not newer than this version, ${current}`);
  return manifest;
}
