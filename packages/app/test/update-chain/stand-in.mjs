// A stand-in for GitHub's releases of the emulator, on this machine's loopback address, for the update chain
// (EMU-341, update-chain.mjs) and its own test (test/unit/update-chain.test.mjs). It answers what the app asks when it
// looks for and takes an update (update-check.mjs, updater.mjs): the latest release, and for each published version its
// update.json signed with a key of the chain's own, update.json.sig and this system's file. Which release is the
// latest is the chain's to say: publish() makes a version the latest, as a release on GitHub does.
//
// The app of the test variant asks it through BUSY_EMULATOR_UPDATE_URL and BUSY_EMULATOR_UPDATE_RELEASES and checks
// the signature with BUSY_EMULATOR_TEST_UPDATE_KEY (config.mjs): env() gives the three. It never listens on anything
// but 127.0.0.1, and nothing of the person's (their GitHub, their releases) is asked.
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { MANIFEST_FILE, manifestBytes, SIGNATURE_FILE, signManifest } from "../../src/update-manifest.mjs";

export const LATEST_PATH = "/repos/busy-app/busybar-emulator/releases/latest";
export const DOWNLOAD_PATH = "/download";

/**
 * @param {object} o
 * @param {number} o.port        the port on 127.0.0.1 (0: a free one)
 * @param {string} o.keyFile     where the public half of the chain's key is written, for BUSY_EMULATOR_TEST_UPDATE_KEY
 * @returns {Promise<{ port: number, url: string, env: () => object, publish: Function, asked: string[], close: () => Promise<void> }>}
 */
export async function startReleaseStandIn({ port = 0, keyFile }) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyFile, publicKey.export({ type: "spki", format: "pem" }));
  const files = new Map();
  let latest = null;
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url);
    const body = req.method === "GET" ? (req.url === LATEST_PATH ? latest : files.get(req.url)) : null;
    if (!body) {
      res.writeHead(404, { "content-length": "0" });
      return res.end();
    }
    res.writeHead(200, { "content-length": String(body.length), "content-type": req.url === LATEST_PATH || req.url.endsWith(".json") ? "application/json" : "application/octet-stream" });
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const at = server.address().port;
  const url = `http://127.0.0.1:${at}`;
  return {
    port: at,
    url,
    asked,
    /** The variables the test variant reads to look for updates here and to trust this key alone. */
    env: () => ({ BUSY_EMULATOR_UPDATE_URL: `${url}${LATEST_PATH}`, BUSY_EMULATOR_UPDATE_RELEASES: `${url}${DOWNLOAD_PATH}`, BUSY_EMULATOR_TEST_UPDATE_KEY: keyFile }),
    /**
     * Publishes `version` with `asset` (a file: this system's zip or setup.exe) under `name`, its manifest signed, and
     * makes it the latest release. `notes` is the release's text (the update pop-up shows it). Returns the manifest.
     */
    publish({ version, asset, name, notes = `Release ${version} of the update chain.` }) {
      const bytes = readFileSync(asset);
      const entry = { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      const manifest = manifestBytes({ version, assets: [entry] });
      const base = `${DOWNLOAD_PATH}/v${version}`;
      files.set(`${base}/${MANIFEST_FILE}`, manifest);
      files.set(`${base}/${SIGNATURE_FILE}`, Buffer.from(signManifest(manifest, privateKey)));
      files.set(`${base}/${name}`, bytes);
      latest = Buffer.from(JSON.stringify({ tag_name: `v${version}`, name: version, body: notes, html_url: `${url}/releases/tag/v${version}` }));
      return { ...entry, manifest: JSON.parse(manifest.toString("utf8")) };
    },
    /** The requests for one version's files, by file name. */
    askedFor: (version) => asked.filter((p) => p.startsWith(`${DOWNLOAD_PATH}/v${version}/`)).map((p) => path.posix.basename(p)),
    close: () => new Promise((resolve) => (server.close(() => resolve()), server.closeAllConnections())),
  };
}
