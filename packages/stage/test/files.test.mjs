// What the 3D view ships (packages/stage/frame) against its record (versions.json): the player's files are the
// release's own, unmodified (the player's license lets a public repository hold them only so), and the scene is the
// one the frame's page was written for.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const stage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frame = path.join(stage, "frame");
const versions = JSON.parse(readFileSync(path.join(stage, "versions.json"), "utf8"));
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const filesUnder = (folder, prefix = "") =>
  readdirSync(folder, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(path.join(folder, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();

/** One file of a zip archive (a .trd is one): found in the central directory, stored or deflated. */
function unzip(archive, name) {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "a zip archive");
  let at = archive.readUInt32LE(end + 16);
  for (let i = archive.readUInt16LE(end + 10); i > 0; i--) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    const method = archive.readUInt16LE(at + 10);
    const size = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    if (archive.toString("utf8", at + 46, at + 46 + nameLength) === name) {
      const data = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      const bytes = archive.subarray(data, data + size);
      return method === 0 ? bytes : inflateRawSync(bytes);
    }
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  throw new Error(`${name} is not in the archive`);
}

test("the player's files are the recorded release's, byte for byte, with its license and notices beside them", () => {
  const have = filesUnder(path.join(frame, "player"));
  assert.deepEqual(have, Object.keys(versions.player.files).sort(), "the files of frame/player are the recorded ones, no more and no fewer");
  for (const file of have) assert.equal(sha256(path.join(frame, "player", file)), versions.player.files[file], `frame/player/${file} is not the release's file: the player's files are not edited`);
  assert.ok(have.includes("LICENSE") && have.includes("THIRD_PARTY_NOTICES.md"));
  assert.match(readFileSync(path.join(frame, "player", "LICENSE"), "utf8"), /^TRIDE PLAYERS LICENCE 1\.2/);
  // The license summary prints the same text.
  assert.equal(readFileSync(path.join(stage, "..", "app", "tools", "notices", "app-texts", "tride-players.txt"), "utf8"), readFileSync(path.join(frame, "player", "LICENSE"), "utf8"));
});

test("the scene's files are the recorded ones", () => {
  const have = filesUnder(path.join(frame, "scene"));
  assert.deepEqual(have, Object.keys(versions.scene.files).sort());
  for (const file of have) assert.equal(sha256(path.join(frame, "scene", file)), versions.scene.files[file], `frame/scene/${file}: install a delivery: node scene-build/record.mjs --delivery <folder> --install`);
});

test("the scene is of the format the player reads and has every input the frame's page writes", () => {
  const manifest = JSON.parse(unzip(readFileSync(path.join(frame, "scene", "bar.trd")), "manifest.json").toString("utf8"));
  assert.equal(manifest.trideRuntimeVersion, versions.player.sceneFormat, "a scene of a newer format than the player's does not open");
  const inputs = Object.fromEntries(manifest.bindings.map((b) => [b.id, b.kind]));
  for (const picture of ["front", "back"]) assert.equal(inputs[picture], "image", picture);
  for (const number of ["turn", "tilt", "distance", "lift", "shift", "wheel", "wheel_step", "switch", "press_start", "press_back", "press_wheel"]) assert.equal(inputs[number], "number", number);
  // Every name the page gives the scene is one of them.
  const page = readFileSync(path.join(frame, "stage.js"), "utf8");
  const written = new Set([...page.matchAll(/set(?:Input|ImagePixels)\("([a-z_]+)"/g), ...page.matchAll(/"(press_[a-z]+)"/g), ...page.matchAll(/name === "([a-z_]+)"/g)].map((m) => m[1]));
  for (const name of [...written, "turn", "tilt", "distance", "lift", "shift"]) assert.ok(name in inputs, `the page writes or reads ${name}, which the scene does not have`);
  assert.deepEqual([...written].sort(), ["back", "front", "press_back", "press_start", "press_wheel", "switch", "wheel", "wheel_step"]);

  // The camera: a long lens (about 190 mm on full frame), so the bar is not bent out of shape.
  assert.ok(manifest.cameras.length === 1 && manifest.cameras[0].yfov > 0.11 && manifest.cameras[0].yfov < 0.14, `the lens: ${JSON.stringify(manifest.cameras)}`);
  assert.match(page, new RegExp(`fov: ${manifest.cameras[0].yfov},`), "the page frames the bar with the scene's lens");

  // The wheel and the switch are turned by a drag; the wheel's plane goes through the grip point on its axis at the height of its top (wheel_grip, an empty node), where a finger takes it.
  const names = new Map(manifest.nodes.map((n) => [n.uid, n.name]));
  const drags = Object.fromEntries(manifest.listeners.map((l) => [l.action.binding_id, { on: names.get(l.targetNodePath.replace("/node/", "")), through: names.get(l.action.plane.through.replace("/node/", "")), kind: l.action.kind, min: l.action.min, max: l.action.max }]));
  assert.deepEqual(drags.wheel, { on: "scroll_wheel", through: "wheel_grip", kind: "dragAngle", min: undefined, max: undefined });
  assert.equal(drags.switch.on, "5_position_switch");
  assert.equal(drags.switch.through, "posselector_cap");

  // The page's table of the controls names nodes of this scene, and the switch stops at its two ends.
  const info = JSON.parse(readFileSync(path.join(frame, "scene", "bar.json"), "utf8"));
  assert.deepEqual([...new Set(Object.values(info.controls))].sort(), ["back", "start", "switch", "wheel"]);
  for (const uid of Object.keys(info.controls)) assert.ok(names.has(uid), `bar.json names node ${uid}, which the scene does not have`);
  assert.ok(Math.abs(drags.switch.max - 2 * info.switchStep) < 1e-6 && Math.abs(drags.switch.min + 2 * info.switchStep) < 1e-6);
  assert.equal(info.wheelDetents, 24);
});

test("everything the page reads of the scene is in the scene's contract, marked readByStage", () => {
  const contract = JSON.parse(readFileSync(path.join(frame, "scene", "scene.json"), "utf8"));
  const page = readFileSync(path.join(frame, "stage.js"), "utf8");
  const written = new Set([...page.matchAll(/set(?:Input|ImagePixels)\("([a-z_]+)"/g), ...page.matchAll(/"(press_[a-z]+)"/g), ...page.matchAll(/name === "([a-z_]+)"/g)].map((m) => m[1]));
  const inputs = Object.fromEntries(contract.inputs.map((i) => [i.id, i]));
  for (const name of [...written, "turn", "tilt", "distance", "lift", "shift"]) assert.equal(inputs[name]?.readByStage, true, `input ${name}: the page uses it, the contract must say readByStage`);
  const info = JSON.parse(readFileSync(path.join(frame, "scene", "bar.json"), "utf8"));
  for (const [uid, control] of Object.entries(info.controls)) {
    assert.equal(contract.barJson.controls[uid]?.readByStage, true, `bar.json uid ${uid} is not in the contract as readByStage`);
    assert.equal(contract.barJson.controls[uid].control, control);
  }
  assert.deepEqual(Object.keys(contract.barJson.controls).sort(), Object.keys(info.controls).sort());
  assert.equal(contract.barJson.switchStep.value, info.switchStep);
  assert.equal(contract.barJson.switchStep.readByStage, true);
  assert.equal(contract.barJson.wheelDetents.value, info.wheelDetents);
  assert.equal(contract.barJson.wheelDetents.readByStage, true);
  assert.match(page, new RegExp(`fov: ${contract.camera.front.yfov},`), "the page frames the bar with the contract's lens");
  assert.equal(contract.files["bar.trd"], sha256(path.join(frame, "scene", "bar.trd")));
  assert.equal(contract.files["bar.json"], sha256(path.join(frame, "scene", "bar.json")));
});

test("the frame's page has no code of its own in it and loads only its own files", () => {
  const html = readFileSync(path.join(frame, "stage.html"), "utf8");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|<style|\son[a-z]+=|\sstyle=/i);
  const sources = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sources.sort(), ["stage.css", "stage.js"]);
  for (const file of ["stage.js", "leds.js"]) {
    const code = readFileSync(path.join(frame, file), "utf8");
    assert.doesNotMatch(code, /\beval\(|new Function\(|https?:\/\//, file);
    for (const [, from] of code.matchAll(/^import .* from "([^"]+)";$/gm)) assert.match(from, /^\.\//, `${file} imports ${from}`);
  }
});
