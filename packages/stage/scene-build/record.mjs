#!/usr/bin/env node
// Writes packages/stage/versions.json: which player and which scene the 3D view ships, with the checksum of every
// file of them. Run after the player's files or the scene change; test/files.test.mjs compares the folder with it.
//
//   node scene-build/record.mjs [--model <busy-bar.fbx>] [--glb <bar.glb>] [--delivery <folder>] [--install]
//
// --delivery names a folder handed over by the Tride agent (bar.trd, bar.json, scene.json): its files' checksums must be
// those in frame/scene, and its provenance (editor, format, delivery id, glb) is recorded. With --install the delivery's
// bar.trd, bar.json and scene.json are copied into frame/scene first. --model and --glb name the files the model was
// made from; without them their checksums are kept as recorded.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(stage, "versions.json");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const filesUnder = (folder, prefix = "") =>
  readdirSync(folder, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(path.join(folder, e.name), `${prefix}${e.name}/`) : e.name.startsWith(".") ? [] : [`${prefix}${e.name}`]))
    .sort();
const usage = "Usage: node scene-build/record.mjs [--model <busy-bar.fbx>] [--glb <bar.glb>] [--delivery <folder> [--install]]";
const words = process.argv.slice(2);
const flags = new Set(["--install"]);
const valued = new Set(["--model", "--glb", "--delivery"]);
const given = {};
for (let i = 0; i < words.length; i++) {
  if (flags.has(words[i])) given[words[i]] = true;
  else if (valued.has(words[i]) && words[i + 1] !== undefined && !words[i + 1].startsWith("--")) given[words[i]] = words[++i];
  else {
    console.error(`record.mjs: unknown option or option without its value: ${words[i]}. ${usage}`);
    process.exit(2);
  }
}
if (given["--install"] && !given["--delivery"]) {
  console.error(`record.mjs: --install needs --delivery. ${usage}`);
  process.exit(2);
}
const option = (name) => given[name] ?? null;

let delivery = null;
if (option("--delivery")) {
  const folder = path.resolve(option("--delivery"));
  const contract = JSON.parse(readFileSync(path.join(folder, "scene.json"), "utf8"));
  for (const name of ["bar.trd", "bar.json"]) {
    const have = sha256(path.join(folder, name));
    if (have !== contract.files?.[name]) { console.error(`record.mjs: ${name} of the delivery does not match the checksum in its scene.json`); process.exit(1); }
  }
  if (given["--install"]) for (const name of ["bar.trd", "bar.json", "scene.json"]) copyFileSync(path.join(folder, name), path.join(stage, "frame", "scene", name));
  for (const name of ["bar.trd", "bar.json"]) {
    if (sha256(path.join(stage, "frame", "scene", name)) !== contract.files[name]) { console.error(`record.mjs: frame/scene/${name} is not the delivery's; use --install`); process.exit(1); }
  }
  if (!existsSync(path.join(stage, "frame", "scene", "scene.json")) || sha256(path.join(stage, "frame", "scene", "scene.json")) !== sha256(path.join(folder, "scene.json"))) {
    console.error("record.mjs: frame/scene/scene.json is not the delivery's; use --install");
    process.exit(1);
  }
  delivery = { id: contract.handoff, editor: contract.editor, glb: contract.source?.glb };
}

const before = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
const source = { ...(before.scene?.source ?? {}) };
if (delivery?.glb) source.glb = delivery.glb;
if (option("--model")) source.model = { name: path.basename(option("--model")), sha256: sha256(option("--model")) };
if (option("--glb")) source.glb = { name: path.basename(option("--glb")), sha256: sha256(option("--glb")) };
const record = {
  $comment: "What the 3D view ships (ADR-0004 section 5): the player's release and the checksum of each of its files, which are the release's own files, unmodified; the scene (owned by the Tride agent) and what it comes from. Written by scene-build/record.mjs; test/files.test.mjs compares packages/stage/frame with it.",
  player: {
    ...(before.player ?? {}),
    files: Object.fromEntries(filesUnder(path.join(stage, "frame", "player")).map((f) => [f, sha256(path.join(stage, "frame", "player", f))])),
  },
  scene: {
    ...Object.fromEntries(Object.entries(before.scene ?? {}).filter(([k]) => k !== "built by")),
    ...(delivery ? { owner: "the Tride agent: the master copy is a .trideproject kept outside this repository; changes come as deliveries, installed with scene-build/record.mjs --delivery <folder> --install", delivery: delivery.id, editor: delivery.editor } : {}),
    source,
    files: Object.fromEntries(filesUnder(path.join(stage, "frame", "scene")).map((f) => [f, sha256(path.join(stage, "frame", "scene", f))])),
  },
};
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
console.log(`versions.json: ${Object.keys(record.player.files).length} files of the player, ${Object.keys(record.scene.files).length} of the scene`);
