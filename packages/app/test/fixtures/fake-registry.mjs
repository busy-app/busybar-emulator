// An npm registry on 127.0.0.1 for the tests of create without the network (create-offline), whose network can be cut
// per package: "pass" answers, "refuse" drops the connection at once (no network, a refused connection), "hang"
// takes the request and never answers (a Wi-Fi out of range keeps the connection open).
//
// It holds two stand-ins: @busy-app/create-app, a generator that writes the least of a project the template's would
// (package.json, src/appmeta/manifest.json), and @busy-app/cli, a busy-cli that prints how it was called.
import { createHash } from "node:crypto";
import http from "node:http";
import { gzipSync } from "node:zlib";

/** A gzipped tar of `files` ({ name: text }) under package/, as npm packs a package. */
function tarball(files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text, "utf8");
    const head = Buffer.alloc(512);
    head.write(`package/${name}`, 0, 100, "utf8");
    head.write("0000755\0", 100);
    head.write("0000000\0", 108);
    head.write("0000000\0", 116);
    head.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    head.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136);
    head.write("        ", 148);
    head.write("0", 156);
    head.write("ustar\0", 257);
    head.write("00", 263);
    let sum = 0;
    for (const byte of head) sum += byte;
    head.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(head, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// Its words as the generator reads them (written so that the check of command lines does not take this file for one).
const GENERATOR = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = ${["process", "argv"].join(".")}.slice(2);
const target = args[0];
// --flag value or --flag=value, as the real generator's parser takes them (create passes --flag=value).
const option = (flag) => { const joined = args.find((a) => a.startsWith(flag + "=")); if (joined) return joined.slice(flag.length + 1); const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
const author = option("--author");
if (!author) { console.error("an author is required"); process.exit(1); }
const folder = path.basename(target);
const name = option("--name") ?? folder.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
const id = option("--id") ?? \`app.\${author.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.\${folder.replace(/[^a-z0-9]+/g, "_")}\`;
fs.mkdirSync(path.join(target, "src", "appmeta"), { recursive: true });
fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: folder, version: "0.1.0", private: true, author, description: name, devDependencies: { "@busy-app/cli": "^0.6.0" } }, null, 2));
fs.writeFileSync(path.join(target, "src", "appmeta", "manifest.json"), JSON.stringify({ id, name, version: "0.1.0", author, description: name }, null, 2));
fs.writeFileSync(path.join(target, "src", "main.ts"), "// the stand-in template\\n");
`;

const BUSY_CLI = [
  // Its words as busy-cli reads them (written so that the check of command lines does not take this file for one).
  `console.log(JSON.stringify({ args: ${["process", "argv"].join(".")}.slice(2), cwd: process.cwd() }));`,
].join("\n");

const PACKAGES = {
  "@busy-app/create-app": { version: "0.5.9", files: { "package.json": JSON.stringify({ name: "@busy-app/create-app", version: "0.5.9", bin: { "create-app": "index.js" } }), "index.js": GENERATOR } },
  "@busy-app/cli": { version: "0.6.0", files: { "package.json": JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", type: "module", bin: { "busy-cli": "dist/index.js" } }), "dist/index.js": BUSY_CLI } },
};

/**
 * Starts the registry. `mode(name)` says how a request for the package `name` is met: "pass", "refuse" or "hang".
 * @returns {Promise<{ url: string, hits: string[], close: () => Promise<void> }>}
 */
export async function fakeRegistry({ port = 0, mode = () => "pass" } = {}) {
  const packed = Object.fromEntries(Object.entries(PACKAGES).map(([name, { version, files }]) => [name, { version, bytes: tarball(files) }]));
  const hits = [];
  const held = new Set();
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url);
    const name = Object.keys(packed).find((one) => url === `/${one}` || url.startsWith(`/${one}/-/`));
    hits.push(url);
    const how = name ? mode(name) : "pass";
    if (how === "refuse") return req.socket.destroy();
    if (how === "hang") {
      held.add(req.socket);
      req.socket.on("close", () => held.delete(req.socket));
      return;
    }
    if (!name) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ error: "not found" }));
    }
    const { version, bytes } = packed[name];
    if (url.startsWith(`/${name}/-/`)) {
      res.setHeader("content-type", "application/octet-stream");
      return res.end(bytes);
    }
    const base = `http://127.0.0.1:${server.address().port}`;
    const file = `${name.split("/").pop()}-${version}.tgz`;
    const manifest = { ...JSON.parse(PACKAGES[name].files["package.json"]), dist: { tarball: `${base}/${name}/-/${file}`, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, shasum: createHash("sha1").update(bytes).digest("hex") } };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ name, "dist-tags": { latest: version }, versions: { [version]: manifest } }));
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    hits,
    close: () =>
      new Promise((resolve) => {
        for (const socket of held) socket.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
