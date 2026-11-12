// The id and the name create gives a new app (the release dry run): a folder name in Cyrillic, Greek or with accents
// gives an id of its own in Latin letters, not the generator's app.<author>.app for every one of them; an id taken by
// another project or an app on the bar gets _2; the files the generator wrote are rewritten.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { idProblem, nameProblem } from "../../readiness/rules.mjs";
import { freeId, ID_MAX, latin, latinName, nameFromId, settleIdentity, suggestId, takenIds } from "../app-identity.mjs";
import { rememberProject } from "../registry.mjs";

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-identity-")));
after(() => rmSync(root, { recursive: true, force: true }));

test("a folder name in Cyrillic or Greek gives an id of its own in Latin letters, each a valid one", () => {
  const cases = [
    ["Привет мир", "jane", "app.jane.privet_mir"],
    ["Мой таймер", "jane", "app.jane.moy_taymer"],
    ["Щука и ёж", "jane", "app.jane.shchuka_i_ezh"],
    ["Їжак Ґава", "jane", "app.jane.yizhak_gava"],
    ["Γειά σου Κόσμε", "jane", "app.jane.geia_sou_kosme"],
    ["Café Ölçü", "jane", "app.jane.cafe_olcu"],
    ["Pomodoro таймер 2", "jane", "app.jane.pomodoro_taymer_2"],
    ["Привет, мир!", "jane", "app.jane.privet_mir"],
    // The generator's own ids for Latin names stay as they were.
    ["foo bar", "jane", "app.jane.foo_bar"],
    ["My-App 2", "Jane Doe", "app.jane_doe.my-app_2"],
    ["com.jane.clock", "x", "com.jane.clock"],
    // An author in Cyrillic is a namespace too, not the placeholder.
    ["clock", "Иван Петров", "app.ivan_petrov.clock"],
    ["clock", "日本", "app.example.clock"],
  ];
  for (const [folder, author, id] of cases) {
    assert.equal(suggestId(folder, author), id, folder);
    assert.equal(idProblem(id), null, id);
  }
  // Two names, two ids: the dry run's pair.
  assert.notEqual(suggestId("Привет мир", "jane"), suggestId("Мой таймер", "jane"));
});

test("an emoji-only name gives app_ and a mark of the name; a very long one is cut to 32 characters", () => {
  const party = suggestId("🎉🎉", "jane");
  assert.match(party, /^app\.jane\.app_[0-9a-f]{4}$/);
  assert.notEqual(party, suggestId("🚀", "jane"), "another emoji, another id");
  assert.equal(party, suggestId("🎉🎉", "jane"), "the same name, the same id");
  const long = suggestId("Привет мир Привет мир Привет мир Привет мир", "jane");
  assert.equal(long, "app.jane.privet_mir_privet_mir_p");
  assert.ok(long.length <= ID_MAX);
  // An author that leaves too little room gives way to the placeholder, as in the generator.
  assert.equal(suggestId("clock", "a-very-long-author-name-here-yes"), "app.example.clock");
  for (const id of [party, long]) assert.equal(idProblem(id), null, id);
});

test("the name is the generator's, from the id; a name with letters the catalog does not take is put into Latin", () => {
  assert.equal(nameFromId("app.jane.privet_mir"), "Privet mir");
  assert.equal(nameFromId("app.jane.privet_mir_2"), "Privet mir 2");
  assert.equal(latin("Мой Таймер"), "Moy Taymer");
  assert.equal(latin("Щука"), "Shchuka");
  assert.equal(latinName("Мой Таймер"), "Moy Taymer");
  assert.equal(latinName("Таймер 🎉 мир"), "Taymer mir");
  assert.equal(latinName("🎉"), null);
  const long = latinName("Привет мир Привет мир Привет мир Привет мир");
  assert.ok([...long].length <= 32 && nameProblem(long) === null, long);
});

test("an id taken by another project or an app on the bar gets _2, _3, cut to fit", () => {
  const taken = new Map([["app.jane.privet_mir", { by: "bar" }], ["app.jane.privet_mir_2", { by: "project", folder: "/x" }]]);
  assert.deepEqual(freeId("app.jane.privet_mir", taken), { id: "app.jane.privet_mir_3", passed: [{ id: "app.jane.privet_mir", by: "bar" }, { id: "app.jane.privet_mir_2", by: "project", folder: "/x" }] });
  assert.deepEqual(freeId("app.jane.clock", taken), { id: "app.jane.clock", passed: [] });
  const full = "app.jane.ochen_dlinnoe_nazvanie1";
  assert.equal(full.length, ID_MAX);
  assert.equal(freeId(full, new Map([[full, { by: "bar" }]])).id, "app.jane.ochen_dlinnoe_nazvani_2");
});

test("taken ids: the apps on every firmware's bar in the data folder and the projects in its list, but not the project being made", () => {
  const data = path.join(root, "taken-data");
  mkdirSync(path.join(data, "bar", "1.3.1", "ext", "user_assets", "app.jane.on_bar"), { recursive: true });
  mkdirSync(path.join(data, "bar", "1.4.0", "ext", "user_assets", "app.jane.newer"), { recursive: true });
  const projectDir = (name, id) => {
    const dir = path.join(root, name);
    mkdirSync(path.join(dir, "src", "appmeta"), { recursive: true });
    writeFileSync(path.join(dir, "src", "appmeta", "manifest.json"), JSON.stringify({ id }));
    rememberProject(data, dir);
    return realpathSync(dir);
  };
  const other = projectDir("other", "app.jane.other");
  const self = projectDir("self", "app.jane.self");
  const taken = takenIds(data, self);
  assert.deepEqual(Object.fromEntries(taken), { "app.jane.on_bar": { by: "bar" }, "app.jane.newer": { by: "bar" }, "app.jane.other": { by: "project", folder: other } });
  assert.deepEqual([...takenIds(path.join(root, "no-data"))], []);
});

/** What create-app 0.5.0 writes, the parts with the id and the name, for a folder whose name it cannot use. */
function generated(name, { id = "app.jane.app", appName = "App", description = appName } = {}) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(dir, "src", "appmeta", "manifest.json"), `${JSON.stringify({ format_version: 1, id, name: appName, version: "0.1.0", api_version: "27.12.0", description, author: "jane" }, null, 2)}\n`);
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "app", private: true, description, author: "jane" }, null, 2)}\n`);
  writeFileSync(path.join(dir, "README.md"), `# ${appName}\n\n${description}\n\nnpm run build         # build the app into dist/${id}.tgz\n\nIf yours still says \`app.example\`, change it.\n`);
  writeFileSync(path.join(dir, "AGENTS.md"), `# AGENTS.md\n\nInstructions for AI coding agents working on \`${appName}\` (\`${id}\`), a JavaScript application.\n`);
  return dir;
}

test("the generator's files are rewritten with the id and the name; its README's own text stays", () => {
  const dir = generated("Привет мир");
  const naming = settleIdentity(dir, { folderName: "Привет мир", given: {}, taken: new Map() });
  assert.deepEqual(
    { id: naming.id, name: naming.name, latin: naming.latin, latinFrom: naming.latinFrom, mark: naming.mark, rewritten: naming.rewritten, generator: naming.generator },
    { id: "app.jane.privet_mir", name: "Privet mir", latin: true, latinFrom: ["Привет мир"], mark: false, rewritten: true, generator: { id: "app.jane.app", name: "App" } },
  );
  const manifest = JSON.parse(readFileSync(path.join(dir, "src", "appmeta", "manifest.json"), "utf8"));
  assert.deepEqual([manifest.id, manifest.name, manifest.description, manifest.author, manifest.version], ["app.jane.privet_mir", "Privet mir", "Privet mir", "jane", "0.1.0"]);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).description, "Privet mir");
  assert.equal(readFileSync(path.join(dir, "README.md"), "utf8"), "# Privet mir\n\nPrivet mir\n\nnpm run build         # build the app into dist/app.jane.privet_mir.tgz\n\nIf yours still says `app.example`, change it.\n");
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /working on `Privet mir` \(`app\.jane\.privet_mir`\), a JavaScript/);
});

test("a given --id is kept, a given --name in Cyrillic is put into Latin letters, a given description stays", () => {
  const dir = generated("given", { id: "com.jane.clock", appName: "Часы", description: "Shows the time" });
  const naming = settleIdentity(dir, { folderName: "given", given: { id: "com.jane.clock", name: "Часы", description: "Shows the time" }, taken: new Map([["com.jane.clock", { by: "bar" }]]) });
  assert.deepEqual([naming.id, naming.name, naming.latin, naming.latinFrom, naming.passed], ["com.jane.clock", "Chasy", true, ["Часы"], []]);
  const manifest = JSON.parse(readFileSync(path.join(dir, "src", "appmeta", "manifest.json"), "utf8"));
  assert.deepEqual([manifest.id, manifest.name, manifest.description], ["com.jane.clock", "Chasy", "Shows the time"]);
});

test("a generator that gave the same id already leaves the project as it is; no manifest, nothing to do", () => {
  const dir = generated("clock", { id: "app.jane.clock", appName: "Clock" });
  const before = readFileSync(path.join(dir, "README.md"), "utf8");
  const naming = settleIdentity(dir, { folderName: "clock", given: {}, taken: new Map() });
  assert.deepEqual([naming.id, naming.latin, naming.rewritten], ["app.jane.clock", false, false]);
  assert.equal(readFileSync(path.join(dir, "README.md"), "utf8"), before);
  const bare = path.join(root, "bare");
  mkdirSync(bare);
  assert.equal(settleIdentity(bare, { folderName: "bare" }), null);
});
