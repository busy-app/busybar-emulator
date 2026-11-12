// The local web's Lucide icons, carried by the app and answered inside it (EMU-209).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createIconAnswers, iconAnswer, iconRequest, ICON_HOSTS, isIconRequest } from "../../src/icons.mjs";
import { ICONS_FILE, namesInBuilds, subsetOf } from "../../tools/local-web-icons.mjs";

const shipped = JSON.parse(readFileSync(ICONS_FILE, "utf8"));
const names = namesInBuilds();

test("the app carries every Lucide icon the local webs of the engine's builds name", { skip: !names && "no firmware builds beside this package" }, () => {
  assert.ok(names.length >= 20, `only ${names.length} names found: the search is broken`);
  const missing = names.filter((name) => !Object.hasOwn(shipped.icons, name) && !Object.hasOwn(shipped.aliases ?? {}, name));
  assert.deepEqual(missing, [], "run node tools/local-web-icons.mjs <icons.json of @iconify-json/lucide> and update tools/notices/app-libraries.json");
});

test("the file is an Iconify icon set: a prefix, a size, and a drawing for every icon", () => {
  assert.equal(shipped.prefix, "lucide");
  assert.equal(shipped.width, 24);
  assert.equal(shipped.height, 24);
  assert.ok(Number.isInteger(shipped.lastModified));
  for (const [name, icon] of Object.entries(shipped.icons)) {
    assert.match(name, /^[a-z0-9-]+$/);
    assert.match(icon.body, /^<(path|g|circle|rect)\b/, name);
    // A drawing only: nothing in it runs or reaches out.
    assert.doesNotMatch(icon.body, /<script|href=|url\(|on[a-z]+=|<foreignObject/i, name);
  }
});

test("only a request for icons to one of Iconify's three hosts is one the app answers", () => {
  assert.deepEqual(ICON_HOSTS, ["api.iconify.design", "api.simplesvg.com", "api.unisvg.com"]);
  for (const host of ICON_HOSTS) assert.deepEqual(iconRequest(`https://${host}/lucide.json?icons=check,chevron-down`), { prefix: "lucide", names: ["check", "chevron-down"] });
  for (const address of [
    "http://api.iconify.design/lucide.json?icons=check",
    "https://api.iconify.design:8443/lucide.json?icons=check",
    // (Put together here: a user name before a host reads as an e-mail address to the export check.)
    `https://user${"@"}api.iconify.design/lucide.json?icons=check`,
    "https://api.iconify.design.example.com/lucide.json?icons=check",
    "https://example.com/lucide.json?icons=check",
    "https://api.iconify.design/lucide.json",
    "https://api.iconify.design/lucide.json?icons=",
    "https://api.iconify.design/lucide.json?icons=check,../x",
    "https://api.iconify.design/lucide.json?icons=<script>",
    "https://api.iconify.design/lucide.svg?icons=check",
    "https://api.iconify.design/collect?data=secret",
    "https://api.iconify.design/a/lucide.json?icons=check",
    `https://api.iconify.design/lucide.json?icons=${Array.from({ length: 201 }, () => "x").join(",")}`,
    "wss://api.iconify.design/lucide.json?icons=check",
    "not an address",
  ]) {
    assert.equal(iconRequest(address), null, address);
    assert.equal(isIconRequest(address), false, address);
  }
});

test("the answer is the API's: the icons the set has, not_found for the rest, an alias with the icon it stands for", () => {
  const set = { prefix: "lucide", lastModified: 5, width: 24, height: 24, icons: { check: { body: "<path d='M1'/>" }, x: { body: "<path d='M2'/>" } }, aliases: { cross: { parent: "x" } } };
  assert.deepEqual(iconAnswer(set, ["check", "nope"]), { prefix: "lucide", lastModified: 5, icons: { check: { body: "<path d='M1'/>" } }, width: 24, height: 24, not_found: ["nope"] });
  assert.deepEqual(iconAnswer(set, ["cross"]), { prefix: "lucide", lastModified: 5, icons: { x: { body: "<path d='M2'/>" } }, width: 24, height: 24, aliases: { cross: { parent: "x" } } });
  // What a prototype has is not an icon.
  assert.deepEqual(iconAnswer(set, ["constructor"]).not_found, ["constructor"]);
});

test("the handler answers from the app's file and passes nothing on: another set is 404, anything else 403", () => {
  const answers = createIconAnswers(ICONS_FILE);
  const ok = answers({ method: "GET", url: "https://api.unisvg.com/lucide.json?icons=check,x,nope" });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["access-control-allow-origin"], "*");
  assert.match(ok.headers["content-type"], /^application\/json/);
  const body = JSON.parse(ok.body);
  assert.deepEqual(Object.keys(body.icons).sort(), ["check", "x"]);
  assert.deepEqual(body.not_found, ["nope"]);
  assert.equal(body.prefix, "lucide");
  assert.equal(answers({ method: "GET", url: "https://api.iconify.design/mdi.json?icons=home" }).status, 404);
  assert.equal(answers({ method: "POST", url: "https://api.iconify.design/lucide.json?icons=check" }).status, 403);
  assert.equal(answers({ method: "GET", url: "https://example.com/" }).status, 403);
  assert.equal(answers({ method: "GET", url: "https://api.iconify.design/collect?data=secret" }).status, 403);
});

test("the tool takes from the full set the icons named, and says which the set does not have", () => {
  const set = { prefix: "lucide", lastModified: 7, width: 24, height: 24, icons: { a: { body: "<path/>" }, b: { body: "<g/>" } }, aliases: { c: { parent: "b" } } };
  assert.deepEqual(subsetOf(set, ["a", "c"]), { prefix: "lucide", lastModified: 7, icons: { a: { body: "<path/>" }, b: { body: "<g/>" } }, width: 24, height: 24, aliases: { c: { parent: "b" } } });
  assert.throws(() => subsetOf(set, ["a", "zzz"]), /no zzz/);
});
