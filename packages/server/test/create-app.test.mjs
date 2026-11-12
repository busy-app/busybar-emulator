// Create app's pop-up (legacy-window/create-app.js): the names, ids and folders it makes, the catalog's rules it checks
// as the person types, the icons it sends (what the icon block, icon-block.js, took), and the pop-up's states on a
// small stand-in for the browser's DOM: the four ways as one row of tabs, Create there to be pressed only when the form
// passes, the request it sends, a refusal said in it, the icon block in place of a configurator, Open existing (what was found, Open, the
// trust dialog's no), Escape and the keyboard. No browser and no emulator:
// node --test emulator/packages/server/test/create-app.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import * as catalogRules from "../readiness/rules.mjs";
import * as catalogTexts from "../readiness/texts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "legacy-window", "create-app.js"), "utf8");

/** create-app.js on its own, without a page: its rules and drawings. */
function pure() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "create-app.js" });
  const api = sandbox.emulatorCreateApp;
  api.useRules({ rules: catalogRules, texts: catalogTexts });
  return api;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------- names, ids, folders

test("the folder and the id are made from the app's name", () => {
  const app = pure();
  assert.equal(app.folderFor("Focus Timer"), "focus-timer");
  assert.equal(app.folderFor("  Café  au lait!! "), "cafe-au-lait");
  assert.equal(app.folderFor("!!!"), "my-app");
  assert.ok(app.folderFor("x".repeat(80)).length <= 48);
  assert.equal(app.idPart("My  Timer.v2"), "my_timer_v2");
  assert.equal(app.suggestId("Focus Timer", "jane"), "app.jane.focus_timer");
  assert.equal(app.suggestId("Focus Timer", ""), "app.example.focus_timer", "no author: the generator's placeholder");
  assert.equal(app.suggestId("Focus Timer", "jane", ["app.jane.focus_timer", "app.jane.focus_timer_2"]), "app.jane.focus_timer_3", "a taken id gets the next number");
  const long = app.suggestId("A really long name for an app", "someone");
  assert.ok(long.length <= 32 && !catalogRules.idProblem(long), long);
  assert.equal(app.suggestId("Weather", "a very long author name indeed"), "app.example.weather", "a namespace that leaves no room gives way");
});

test("no icon configurator: no letters, drawn icons or colors; the icons are the icon block's", () => {
  const app = pure();
  for (const gone of ["initials", "letterIcon", "iconPixels", "PIXEL_ICONS", "COLORS", "GLYPHS"]) assert.equal(app[gone], undefined, gone);
});

// ---------------------------------------------------------------- the catalog's rules, as typed

const PLACE = { parent: "/Users/you/BUSY Bar projects", folder: "focus-timer", path: "/Users/you/BUSY Bar projects/focus-timer", shownPath: "~/BUSY Bar projects/focus-timer", namespace: "you" };
const icons = ({ front = null, back = null } = {}) => ({ front: { saved: null, draft: front, rejected: null }, back: { saved: null, draft: back, rejected: null, fromFront: false } });
const form = (more = {}) => ({ name: "Focus Timer", id: "", idEdited: false, short_description: "", category: "", icons: icons(), ...more });

test("the empty app's form: each field by the catalog's rule, with a sentence that says what is wrong", () => {
  const app = pure();
  const ok = app.problemsOf(form(), { place: PLACE });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const said = (more, context = {}) => plain(app.problemsOf(form(more), { place: PLACE, ...context }));
  assert.equal(said({ name: "" }).name, "Write the app's name.");
  assert.match(said({ name: "x".repeat(33) }).name, /^It is 33 characters long, the limit is 32\.$/);
  assert.match(said({ name: String.fromCodePoint(0x41c, 0x43e, 0x439, 0x20, 0x442, 0x430, 0x439, 0x43c, 0x435, 0x440) }).name, /Latin letters/);
  assert.match(said({ name: "Two  spaces" }).name, /two in a row/);
  assert.match(said({ idEdited: true, id: "App.My.Clock" }).id, /upper-case/);
  assert.match(said({ idEdited: true, id: "app.one" }).id, /two/);
  assert.equal(said({ idEdited: true, id: "app.you.clock" }, { taken: ["app.you.clock"] }).id, "Another app of the emulator has this id.");
  assert.equal(said({ idEdited: true, id: `app.you.${"a".repeat(30)}` }).id, "It is 38 characters long; the BUSY Bar takes 32.");
  assert.equal(said({}, { taken: ["app.you.focus_timer"] }).id, null, "a made id passes a taken one by");
  assert.match(said({ short_description: "Short" }).short_description, /5 characters: the short description needs at least 10/);
  assert.equal(said({ short_description: "" }).short_description, null, "the short description can wait for Publish");
  assert.equal(said({ category: "weather" }).category, "Not one of the catalog's categories.");
  assert.equal(said({ category: "productivity" }).category, null);
  // The icons never keep Create away: without an upload the app gets the default icon; an upload that breaks a rule
  // is never taken.
  assert.equal(said({ icons: { ...icons(), front: { saved: null, draft: null, rejected: { name: "x.png" } } } }).ok, true);
  assert.equal(said({}, { place: null }).place, "Finding a place for the folder");
  assert.equal(said({}, { place: { problem: "Choose the location with Change." } }).place, "Choose the location with Change.");
  // A template asks for the name, the id and the place only.
  assert.equal(app.problemsOf(form({ short_description: "Short" }), { place: PLACE, way: "templates" }).ok, true);
});

test("Create's request: the place by its parent and folder name, the id made from the name, the texts written and the icons uploaded", () => {
  const app = pure();
  assert.deepEqual(plain(app.requestOf("empty", form({ short_description: "Shows the focus time left", category: "productivity" }), { place: PLACE })), {
    example: null,
    name: "Focus Timer",
    id: "app.you.focus_timer",
    place: { parent: PLACE.parent, folder: "focus-timer" },
    texts: { short_description: "Shows the focus time left", category: "productivity" },
  }, "no upload: no icon asked for, create gives the default one");
  const front = "data:image/png;base64,Zg==";
  const back = "data:image/png;base64,Yg==";
  assert.deepEqual(plain(app.requestOf("empty", form({ icons: icons({ front }) }), { place: PLACE })).icon, { front });
  assert.deepEqual(plain(app.requestOf("empty", form({ icons: icons({ back }) }), { place: PLACE })).icon, { back });
  assert.deepEqual(plain(app.requestOf("empty", form({ icons: icons({ front, back }) }), { place: PLACE })).icon, { front, back });
  const rejected = { ...icons(), front: { saved: null, draft: null, rejected: { name: "big.png" } } };
  assert.equal(plain(app.requestOf("empty", form({ icons: rejected }), { place: PLACE })).icon, undefined, "a rejected upload is never sent");
  assert.deepEqual(plain(app.requestOf("templates", form({ name: "Meeting Cost", idEdited: true, id: "app.you.meetings" }), { place: PLACE, example: "meeting-cost" })), { example: "meeting-cost", name: "Meeting Cost", id: "app.you.meetings", place: { parent: PLACE.parent, folder: "focus-timer" } });
});

// ---------------------------------------------------------------- the pop-up on a small stand-in for the page

/** Elements with children, attributes, classes and listeners; enough of a selector for what the pop-up asks. */
function makeDocument() {
  let active = null;
  const docListeners = {};
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parent = null;
      this.attributes = {};
      this.dataset = {};
      this.style = {};
      this.listeners = {};
      this.classes = new Set();
      this.textContent = "";
      this._html = "";
      this.hidden = false;
      this.disabled = false;
      this.value = "";
      this.title = "";
      this.offsetParent = {};
      this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), toggle: (c, on) => (on ?? !this.classes.has(c) ? this.classes.add(c) : this.classes.delete(c)), contains: (c) => this.classes.has(c) };
    }
    get className() {
      return [...this.classes].join(" ");
    }
    set className(v) {
      this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
    }
    set innerHTML(v) {
      this._html = v;
      this.children = [];
    }
    get innerHTML() {
      return this._html;
    }
    get text() {
      return this.children.length ? this.children.map((c) => c.text).join(" ") : this.textContent;
    }
    append(...nodes) {
      for (const node of nodes) {
        if (typeof node === "string") continue;
        node.parent = this;
        this.children.push(node);
      }
    }
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
    getAttribute(name) {
      return this.attributes[name] ?? null;
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    fire(type, event = {}) {
      for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, stopPropagation() {}, target: this, key: "", ...event });
    }
    focus() {
      active = this;
    }
    contains(other) {
      for (let at = other; at; at = at.parent) if (at === this) return true;
      return false;
    }
    all() {
      return this.children.flatMap((child) => [child, ...child.all()]);
    }
    querySelectorAll(selector) {
      return this.all().filter((el) => selector.split(",").some((one) => matches(el, one.trim())));
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }
    getContext() {
      return { clearRect() {}, fillRect() {}, set fillStyle(_v) {} };
    }
    toDataURL() {
      return `data:image/png;base64,${Buffer.from(`${this.width}x${this.height}`).toString("base64")}`;
    }
  }
  function matches(el, selector) {
    const attr = /^\[([a-z-]+)(?:='([^']*)')?\]$/.exec(selector);
    if (attr) return attr[1] === "data-focus" ? el.dataset.focus !== undefined : attr[1] === "tabindex" ? String(el.tabIndex) === attr[2] : el.getAttribute(attr[1]) !== null;
    const [tag, ...classes] = selector.split(".");
    return (!tag || el.tagName === tag.toUpperCase()) && classes.every((c) => el.classes.has(c));
  }
  const body = new Element("body");
  const document = {
    body,
    createElement: (tag) => new Element(tag),
    addEventListener: (type, fn) => (docListeners[type] ??= []).push(fn),
    get activeElement() {
      return active;
    },
    key: (key, more = {}) => {
      const event = { key, defaultPrevented: false, preventDefault() {
        this.defaultPrevented = true;
      }, stopPropagation() {}, ...more };
      for (const fn of docListeners.keydown ?? []) fn(event);
      return event;
    },
  };
  return document;
}

/** The pop-up in a page of its own, with a stand-in for the desktop app's actions. */
function openPopUp({ examples = [], taken = [], more = {}, create, finds = async () => null, github = null, place = (asked) => ({ ...PLACE, folder: asked.folder, path: `${PLACE.parent}/${asked.folder}`, shownPath: `~/BUSY Bar projects/${asked.folder}` }) } = {}) {
  const document = makeDocument();
  const calls = [];
  const jobListeners = [];
  const emulatorActions = {
    on: (_name, listener) => (jobListeners.push(listener), () => {}),
    projects: {
      place: async (asked) => (calls.push(["place", plain(asked)]), place(asked)),
      choosePlace: async () => (calls.push(["choosePlace"]), { parent: "/Users/you/elsewhere", shown: "/Users/you/elsewhere" }),
      find: async (asked) => (calls.push(["find", plain(asked)]), finds(asked)),
    },
    ...(github ? { github } : {}),
  };
  // A stand-in for the icon block (icon-block.js, tested in the app): its Upload front takes UPLOADED as a draft.
  const blocks = [];
  const emulatorIconBlock = {
    emptyModel: () => ({ front: { saved: null, draft: null, rejected: null }, back: { saved: null, draft: null, rejected: null, fromFront: false } }),
    render: (model, options) => {
      blocks.push(options);
      const block = document.createElement("div");
      block.className = "icon-block";
      const upload = document.createElement("button");
      upload.dataset.part = "upload-front";
      upload.addEventListener("click", () => ((model.front.draft = UPLOADED), options.onChange()));
      block.append(upload);
      return block;
    },
  };
  const sandbox = { document, emulatorActions, emulatorIconBlock, setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout, Event: class {}, dispatchEvent() {}, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "create-app.js" });
  const api = sandbox.emulatorCreateApp;
  api.useRules({ rules: catalogRules, texts: catalogTexts });
  const requests = [];
  api.open({ examples, taken, ...more, create: create ?? (async (request) => (requests.push(plain(request)), { id: request.id, folder: "/made" })) });
  const dialog = document.body.querySelector(".create-app");
  const find = (selector, text = null) => dialog.querySelectorAll(selector).find((el) => text === null || el.text.includes(text)) ?? null;
  const createButton = () => dialog.querySelectorAll("button").find((el) => el.dataset.part === "create");
  return { api, document, dialog, calls, requests, find, createButton, blocks, scrim: document.body.querySelector(".create-app-scrim"), emitJob: (job) => jobListeners.forEach((listener) => listener(job)) };
}
const UPLOADED = "data:image/png;base64,dXBsb2FkZWQ=";
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const EXAMPLES = [
  { name: "focus-timer", title: "Focus Timer", summary: "A tree grows while you work.", icon: "data:image/png;base64,aWNvbg==", front: "data:image/png;base64,ZnJvbnQ=" },
  { name: "meeting-cost", title: "Meeting Cost", summary: "What the meeting costs." },
];

test("the pop-up opens on Templates: the official template and the examples as cards; Create waits for a choice", async () => {
  const { dialog, find, createButton, scrim } = openPopUp({ examples: EXAMPLES });
  await settle();
  assert.equal(scrim.hidden, false);
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  const tabs = dialog.querySelectorAll(".create-app-way");
  assert.deepEqual(tabs.map((tab) => [tab.dataset.way, tab.getAttribute("aria-selected")]), [["templates", "true"], ["empty", "false"], ["open", "false"], ["github", "false"], ["package", "false"]]);
  assert.deepEqual(tabs.map((tab) => tab.text), ["Templates", "Empty app", "Open existing", "Import from GitHub", "Install a package"]);
  // One row of tabs at the top, what the chosen way offers below it.
  const rail = dialog.querySelector(".create-app-rail");
  assert.deepEqual([rail.getAttribute("role"), rail.getAttribute("aria-orientation")], ["tablist", "horizontal"]);
  assert.deepEqual(dialog.children.map((el) => el.className.split(" ")[0]), ["create-app-head", "create-app-rail", "create-app-pane", "create-app-foot"]);
  assert.match(dialog.querySelector(".create-app-lead").textContent, /^A finished app to change into your own/);
  const cards = dialog.querySelectorAll(".create-app-card");
  assert.deepEqual(cards.map((card) => card.querySelector("b").textContent), ["Official template", "Focus Timer", "Meeting Cost"]);
  // An example's own pictures, as the desktop app gave them; text as text.
  assert.equal(cards[1].querySelector("img").src, EXAMPLES[1 - 1].front);
  assert.equal(createButton().ariaDisabled, "true");
  assert.equal(createButton().title, "Choose a template");
  assert.equal(find(".create-app-field"), null, "no name to write before a template is chosen");
});

test("a template chosen: its name is offered, the id and the folder are made from it, Create sends the example", async () => {
  const { dialog, calls, requests, createButton, scrim } = openPopUp({ examples: EXAMPLES, taken: ["app.you.focus_timer"] });
  await settle();
  dialog.querySelectorAll(".create-app-card")[1].fire("click");
  await settle();
  const name = dialog.querySelector("input");
  assert.equal(name.value, "Focus Timer");
  assert.equal(dialog.querySelector(".create-app-id").querySelector("code").textContent, "app.you.focus_timer_2", "the id another app has is passed by");
  assert.deepEqual(calls.at(-1), ["place", { parent: null, folder: "focus-timer" }]);
  assert.equal(dialog.querySelector(".create-app-place").querySelector("span").textContent, "~/BUSY Bar projects/focus-timer");
  assert.equal(createButton().ariaDisabled, "false");
  createButton().fire("click");
  await settle();
  assert.deepEqual(requests, [{ example: "focus-timer", name: "Focus Timer", id: "app.you.focus_timer_2", place: { parent: PLACE.parent, folder: "focus-timer" } }]);
  assert.equal(scrim.hidden, true, "created: the pop-up goes");
});

test("Create app ends with the app running: the pop-up says Building… as the Refresh goes, then that the app runs, then goes", async () => {
  let finish;
  const { dialog, createButton, scrim, emitJob } = openPopUp({ examples: EXAMPLES, create: () => new Promise((resolve) => (finish = resolve)) });
  await settle();
  dialog.querySelectorAll(".create-app-card")[1].fire("click");
  await settle();
  createButton().fire("click");
  await settle();
  const said = () => dialog.querySelector(".create-app-said").textContent;
  emitJob({ kind: "create", state: "running", line: "Installing the dependencies (npm install, without install scripts)…" });
  assert.equal(said(), "Installing the dependencies (npm install, without install scripts)");
  emitJob({ kind: "refresh", state: "running", line: "Building" });
  assert.equal(said(), "Building…");
  emitJob({ kind: "refresh", state: "running", line: "Started" });
  assert.equal(said(), "Starting…");
  finish({ id: "app.you.focus_timer", folder: "/made", refreshed: { ok: true, message: "app.you.focus_timer is running." } });
  await settle();
  assert.equal(said(), "app.you.focus_timer is running.");
  assert.equal(scrim.hidden, false, "said for a moment");
  await settle(1300);
  assert.equal(scrim.hidden, true);
});

test("an app of the name typed is there already: the pop-up says where and offers it; another can still be created", async () => {
  const opened = [];
  const existing = [{ id: "app.you.focus_timer", name: "Focus Timer", folder: "/Users/you/BUSY Bar projects/focus-timer", shown: "~/BUSY Bar projects/focus-timer" }];
  const { dialog, createButton, scrim, api } = openPopUp({ examples: EXAMPLES, taken: ["app.you.focus_timer"], more: { existing, openExisting: (id) => opened.push(id) } });
  assert.deepEqual(plain(api.sameName(existing, "  focus timer ")), existing[0]);
  assert.equal(api.sameName(existing, "Focus Timer 2"), null);
  await settle();
  dialog.querySelectorAll(".create-app-card")[1].fire("click");
  await settle();
  const note = dialog.querySelector(".create-app-exists");
  assert.ok(note, "the pop-up says so");
  assert.equal(note.text, "You already have Focus Timer in ~/BUSY Bar projects/focus-timer.  Open it  or create another.");
  assert.equal(createButton().ariaDisabled, "false", "another can be created");
  // Another name: nothing to say.
  const name = dialog.querySelector("input");
  name.value = "Focus Timer Two";
  name.fire("input");
  await settle();
  assert.equal(dialog.querySelector(".create-app-exists"), null);
  name.value = "Focus Timer";
  name.fire("input");
  await settle();
  dialog.querySelector(".create-app-exists").querySelector("button").fire("click");
  await settle();
  assert.deepEqual(opened, ["app.you.focus_timer"]);
  assert.equal(scrim.hidden, true, "the pop-up goes, and the app is chosen in the list");
});

test("the empty app: valid at once with letters made from the name; a wrong name keeps Create away and says why", async () => {
  const { dialog, find, requests, createButton } = openPopUp();
  await settle();
  find(".create-app-way", "Empty app").fire("click");
  await settle();
  assert.equal(find(".create-app-way", "Empty app").getAttribute("aria-selected"), "true");
  const input = (part) => dialog.querySelectorAll("input").find((el) => el.dataset.part === part);
  assert.equal(input("name").value, "My app");
  assert.equal(createButton().ariaDisabled, "false");
  // A name the catalog does not take.
  input("name").value = String.fromCodePoint(0x41c, 0x43e, 0x439, 0x20, 0x442, 0x430, 0x439, 0x43c, 0x435, 0x440);
  input("name").fire("input");
  await settle(200);
  assert.equal(createButton().ariaDisabled, "true");
  assert.match(createButton().title, /Latin letters/);
  assert.match(find(".create-app-field.bad").text, /Latin letters/);
  // Put right: a name, a short description that is too short, then one that passes, a category; an icon uploaded.
  input("name").value = "Focus Timer";
  input("name").fire("input");
  input("short").value = "Short";
  input("short").fire("input");
  assert.equal(createButton().ariaDisabled, "true");
  assert.match(createButton().title, /at least 10/);
  input("short").value = "Shows the focus time left";
  input("short").fire("input");
  const category = dialog.querySelector("select");
  assert.deepEqual(category.children.map((option) => option.value), ["", ...catalogRules.CATEGORIES.map((one) => one.id)]);
  category.value = "productivity";
  category.fire("change");
  dialog.querySelectorAll("button").find((el) => el.dataset.part === "upload-front").fire("click");
  await settle(200);
  assert.equal(createButton().ariaDisabled, "false");
  createButton().fire("click");
  await settle();
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.deepEqual(request, { example: null, name: "Focus Timer", id: "app.you.focus_timer", place: { parent: PLACE.parent, folder: "focus-timer" }, texts: { short_description: "Shows the focus time left", category: "productivity" }, icon: { front: UPLOADED } });
});

test("no author known (no GitHub login, only a name many computers share): the form asks for one, the id is made from it, a generic one keeps Create away", async () => {
  // The rules on their own.
  const app = pure();
  const asking = { ...PLACE, author: null };
  assert.equal(app.asksAuthor(asking), true);
  assert.equal(app.asksAuthor(PLACE), false, "an older desktop app says nothing of the author: nothing is asked");
  assert.equal(app.asksAuthor({ ...PLACE, author: { name: "jane-dev", from: "github" } }), false);
  const f = (author) => ({ name: "Focus Timer", author, id: "", idEdited: false });
  assert.match(app.problemsOf(f(""), { place: asking }).author, /Write your GitHub login or your name/);
  assert.match(app.problemsOf(f("User"), { place: asking }).author, /"User" is a name many computers share/);
  assert.match(app.problemsOf(f("Administrator"), { place: asking }).author, /many computers share/);
  assert.equal(app.problemsOf(f("Jane Dev"), { place: asking }).author, null);
  assert.equal(app.problemsOf(f(""), { place: PLACE }).author, null);
  assert.equal(app.idOf(f("Jane Dev"), { namespace: app.namespaceFor(f("Jane Dev"), asking) }), "app.jane_dev.focus_timer");
  assert.equal(plain(app.requestOf("templates", f(" jane-dev "), { place: asking, example: "focus-timer" })).author, "jane-dev");
  assert.equal(plain(app.requestOf("templates", f("x"), { place: PLACE, example: "focus-timer" })).author, undefined);

  // In the pop-up.
  const { dialog, requests, createButton } = openPopUp({ place: (asked) => ({ ...PLACE, author: null, namespace: "example", folder: asked.folder, path: `${PLACE.parent}/${asked.folder}`, shownPath: `~/BUSY Bar projects/${asked.folder}` }) });
  await settle();
  dialog.querySelectorAll(".create-app-way").find((el) => el.text.includes("Empty app")).fire("click");
  await settle();
  const input = (part) => dialog.querySelectorAll("input").find((el) => el.dataset.part === part);
  assert.ok(input("author"), "an Author field");
  assert.equal(createButton().ariaDisabled, "true");
  assert.match(createButton().title, /Write your GitHub login or your name/);
  input("author").value = "user";
  input("author").fire("input");
  await settle(200);
  assert.equal(createButton().ariaDisabled, "true");
  assert.match(createButton().title, /many computers share/);
  input("author").value = "jane-dev";
  input("author").fire("input");
  await settle(200);
  assert.equal(createButton().ariaDisabled, "false");
  assert.ok(dialog.querySelectorAll("code").some((el) => el.text === "app.jane-dev.my_app"), "the id shown is made from the author");
  createButton().fire("click");
  await settle();
  assert.deepEqual([requests[0].author, requests[0].id], ["jane-dev", "app.jane-dev.my_app"]);
});

test("the GitHub login known: no Author field, and the id's hint under Advanced names it", async () => {
  const { dialog } = openPopUp({ place: (asked) => ({ ...PLACE, author: { name: "Jane-Dev", from: "github" }, namespace: "jane-dev", folder: asked.folder, path: `${PLACE.parent}/${asked.folder}`, shownPath: `~/BUSY Bar projects/${asked.folder}` }) });
  await settle();
  dialog.querySelectorAll(".create-app-way").find((el) => el.text.includes("Empty app")).fire("click");
  await settle();
  assert.equal(dialog.querySelectorAll("input").find((el) => el.dataset.part === "author"), undefined);
  assert.ok(dialog.querySelectorAll("code").some((el) => el.text === "app.jane-dev.my_app"));
  dialog.querySelectorAll("button").find((el) => el.dataset.focus === "advanced").fire("click");
  await settle();
  assert.ok(dialog.querySelectorAll(".about").some((el) => /^app\.<author>\.<name>: the author is your GitHub login, Jane-Dev\. Unique on the BUSY Bar/.test(el.text)));
});

test("the id under Advanced: written by hand, checked, and made from the name again", async () => {
  const { dialog, find, createButton } = openPopUp({ taken: ["app.you.taken"] });
  await settle();
  find(".create-app-way", "Empty app").fire("click");
  await settle();
  find("button", "Advanced").fire("click");
  const id = () => dialog.querySelectorAll("input").find((el) => el.dataset.part === "id");
  assert.equal(id().value, "app.you.my_app");
  id().value = "app.you.taken";
  id().fire("input");
  assert.equal(createButton().ariaDisabled, "true");
  assert.equal(createButton().title, "Another app of the emulator has this id.");
  id().value = "com.example.timer";
  id().fire("input");
  assert.equal(createButton().ariaDisabled, "false");
  assert.equal(dialog.querySelector(".create-app-id").querySelector("code").textContent, "com.example.timer");
  find("button", "Make it from the name").fire("click");
  assert.equal(dialog.querySelector(".create-app-id").querySelector("code").textContent, "app.you.my_app");
});

test("Import from GitHub: the account it reads as, the repository looked up as it is typed (another host refused), Location named after it; Import sends the repository and the place (catalog-update)", async () => {
  const looked = [];
  const imports = [];
  const github = {
    status: async () => ({ configured: true, signedIn: true, login: "octo", accounts: [] }),
    lookup: async (repo) => (looked.push(repo), /gitlab/.test(repo) ? { ok: false, code: "not_github", message: "Only repositories on github.com can be imported." } : { owner: "octo", name: "pomodoro-timer", branch: "main", private: false, app: { id: "app.octo.pomodoro", name: "Pomodoro", version: "1.2.0" } }),
    importRepo: async (asked) => (imports.push(plain(asked)), { id: "app.octo.pomodoro", folder: "/made" }),
  };
  const { dialog, find, calls, scrim } = openPopUp({ github });
  await settle();
  find(".create-app-way", "Import from GitHub").fire("click");
  await settle();
  const importButton = () => dialog.querySelectorAll("button").find((el) => el.dataset.part === "import");
  assert.match(find(".create-app-account").text, /Reads as octo/);
  assert.deepEqual([importButton().ariaDisabled, importButton().title], ["true", "Name the repository"]);
  const repo = () => dialog.querySelectorAll("input").find((el) => el.dataset.part === "repo");
  repo().value = "https://gitlab.com/a/b";
  repo().fire("input");
  await settle(700);
  assert.match(find(".create-app-field", "Repository").text, /Only repositories on github\.com can be imported\./);
  assert.equal(importButton().title, "Only repositories on github.com can be imported.");
  repo().value = "octo/pomodoro-timer";
  repo().fire("input");
  await settle(700);
  assert.deepEqual(looked, ["https://gitlab.com/a/b", "octo/pomodoro-timer"]);
  assert.match(find(".create-app-field", "Repository").text, /Pomodoro 1\.2\.0, public, from its branch main\./);
  assert.deepEqual(calls.at(-1), ["place", { parent: null, folder: "pomodoro-timer" }], "the folder is named after the repository");
  assert.equal(importButton().ariaDisabled, "false");
  importButton().fire("click");
  await settle();
  assert.deepEqual(imports, [{ repo: "octo/pomodoro-timer", place: { parent: PLACE.parent, folder: "pomodoro-timer" } }]);
  assert.equal(scrim.hidden, true, "opened: the pop-up goes");
});

test("Location: Change asks the desktop app for the system's dialog, and the place it gives is used", async () => {
  const { dialog, find, calls, requests, createButton } = openPopUp({ place: (asked) => ({ ...PLACE, parent: asked.parent ?? PLACE.parent, folder: asked.folder, shownPath: `${asked.parent ?? "~/BUSY Bar projects"}/${asked.folder}` }) });
  await settle();
  find(".create-app-way", "Empty app").fire("click");
  await settle();
  find("button", "Change").fire("click");
  await settle();
  assert.deepEqual(calls.slice(-2), [["choosePlace"], ["place", { parent: "/Users/you/elsewhere", folder: "my-app" }]]);
  assert.equal(dialog.querySelector(".create-app-place").querySelector("span").textContent, "/Users/you/elsewhere/my-app");
  createButton().fire("click");
  await settle();
  assert.deepEqual(requests[0].place, { parent: "/Users/you/elsewhere", folder: "my-app" });
});

test("a place the desktop app refuses, and a Create it refuses, are said in the pop-up, which stays", async () => {
  let refusePlace = true;
  const { dialog, find, createButton, scrim } = openPopUp({
    place: (asked) => (refusePlace ? Promise.reject(new Error("my-app and the next 98 names are taken.")) : { ...PLACE, folder: asked.folder }),
    create: async () => {
      throw Object.assign(new Error("The project was not created."), { code: "network_failed", hint: "Check the connection." });
    },
  });
  await settle();
  find(".create-app-way", "Empty app").fire("click");
  await settle();
  assert.equal(createButton().ariaDisabled, "true");
  assert.match(find(".create-app-field.bad").text, /next 98 names are taken/);
  refusePlace = false;
  find(".create-app-way", "Templates").fire("click");
  find(".create-app-way", "Empty app").fire("click");
  await settle();
  assert.equal(createButton().ariaDisabled, "false");
  createButton().fire("click");
  await settle();
  assert.equal(scrim.hidden, false);
  assert.equal(dialog.querySelector(".create-app-said").textContent, "The project was not created. Check the connection.");
  assert.ok(dialog.querySelector(".create-app-said").classes.has("failed"));
});

test("the keyboard: the arrows move between the ways, Tab stays inside, Escape closes", async () => {
  const { dialog, document, scrim, api } = openPopUp();
  await settle();
  const tab = (way) => dialog.querySelectorAll(".create-app-way").find((el) => el.dataset.way === way);
  assert.equal(document.activeElement, tab("templates"), "the first tab has the focus");
  tab("templates").fire("keydown", { key: "ArrowRight" });
  assert.equal(tab("empty").getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement, tab("empty"));
  tab("empty").fire("keydown", { key: "ArrowLeft" });
  tab("templates").fire("keydown", { key: "ArrowLeft" });
  assert.equal(tab("package").getAttribute("aria-selected"), "true", "round from the first to the last");
  // Tab from the last control goes back to the first.
  const all = dialog.querySelectorAll("button, input, select, textarea");
  all.at(-1).focus();
  assert.equal(document.key("Tab").defaultPrevented, true);
  assert.equal(document.activeElement, all[0]);
  document.key("Tab", { shiftKey: true });
  assert.equal(document.activeElement, all.at(-1));
  document.key("Escape");
  assert.equal(scrim.hidden, true);
  assert.equal(api.isOpen(), false);
});

test("Empty app: the icon block in place of the configurator, drawn with the default icon, its model the form's", async () => {
  const { dialog, find, blocks } = openPopUp();
  await settle();
  find(".create-app-way", "Empty app").fire("click");
  await settle();
  assert.equal(dialog.querySelectorAll(".create-app-icon-pick").length, 0, "no drawn icons");
  assert.equal(dialog.querySelectorAll(".create-app-color").length, 0, "no colors");
  assert.ok(dialog.querySelector(".icon-block"), "the icon block");
  assert.equal(blocks.at(-1).withDefault, true, "the default icon unless something is uploaded");
  assert.match(find(".create-app-icon").text, /Upload none and the app gets the default icon/);
  assert.match(find(".create-app-icon").text, /BUSY Bar's APPS menu/);
});

const FOUND = { found: true, folder: "/Users/you/work/clock", shownFolder: "~/work/clock", id: "app.you.clock", name: "Clock", listed: false, trusted: false, chosen: "/Users/you/work/clock/src/scripts/main.js", shownChosen: "~/work/clock/src/scripts/main.js" };

test("Open existing: Choose asks the desktop app for the system's dialog; what it found is shown, and Open opens that folder", async () => {
  const imported = [];
  const { dialog, find, calls, scrim } = openPopUp({ finds: async () => FOUND, more: { importProject: async (folder) => (imported.push(folder), { id: "app.you.clock", folder, refreshed: { ok: true, message: "app.you.clock is running." } }) } });
  await settle();
  const before = calls.length;
  find(".create-app-way", "Open existing").fire("click");
  await settle();
  assert.equal(calls.length, before, "no place is asked for: nothing is created");
  assert.match(dialog.querySelector(".create-app-lead").textContent, /choose its folder, or any file in it/);
  const open = () => dialog.querySelectorAll("button").find((el) => el.dataset.part === "open");
  assert.equal(dialog.querySelectorAll("button").find((el) => el.dataset.part === "create"), undefined, "Open, not Create");
  assert.deepEqual([open().ariaDisabled, open().title], ["true", "Choose the app's folder first"]);
  assert.equal(dialog.querySelector(".create-app-chosen").querySelector("span").textContent, "Nothing chosen yet");
  // macOS: one Choose, for a folder or a file.
  const choose = dialog.querySelectorAll("button").filter((el) => (el.dataset.part ?? "").startsWith("choose-"));
  assert.deepEqual(choose.map((el) => [el.dataset.part, el.text.trim()]), [["choose-any", "Choose…"]]);
  choose[0].fire("click");
  await settle();
  assert.deepEqual(calls.at(-1), ["find", { pick: "any" }]);
  assert.equal(dialog.querySelector(".create-app-chosen").querySelector("span").textContent, "~/work/clock/src/scripts/main.js");
  const card = dialog.querySelector(".create-app-result");
  assert.ok(card.classes.has("found"));
  assert.match(card.text, /Found an app project/);
  assert.match(card.text, /Clock/);
  assert.match(card.text, /app\.you\.clock/);
  assert.equal(card.querySelector(".create-app-path").textContent, "~/work/clock", "the folder, its last name kept in view");
  assert.match(card.text, /Found in a folder above what you chose/);
  assert.match(find(".create-app-muted", "trust").text, /asks whether you trust this folder/);
  assert.equal(open().ariaDisabled, "false");
  open().fire("click");
  assert.equal(dialog.querySelector(".create-app-said").textContent, "Waiting for your answer in the trust dialog");
  await settle();
  assert.deepEqual(imported, ["/Users/you/work/clock"]);
  assert.equal(dialog.querySelector(".create-app-said").textContent, "app.you.clock is running.");
  await settle(1300);
  assert.equal(scrim.hidden, true, "opened and started: the pop-up goes");
});

test("Open existing: nothing found is said plainly; Don't Trust keeps the pop-up; Windows has a button for a folder and one for a file", async () => {
  let answer = { found: false, message: "No BUSY app found in this folder or above it.", chosen: "/Users/you/Pictures", shownChosen: "~/Pictures" };
  const { dialog, find, calls, scrim } = openPopUp({ finds: async () => answer, more: { platform: "Win32", importProject: async () => null } });
  await settle();
  find(".create-app-way", "Open existing").fire("click");
  await settle();
  const choose = dialog.querySelectorAll("button").filter((el) => (el.dataset.part ?? "").startsWith("choose-"));
  assert.deepEqual(choose.map((el) => [el.dataset.part, el.text.trim()]), [["choose-folder", "Choose Folder…"], ["choose-file", "Choose File…"]]);
  choose[1].fire("click");
  await settle();
  assert.deepEqual(calls.at(-1), ["find", { pick: "file" }]);
  const none = dialog.querySelector(".create-app-result");
  assert.ok(none.classes.has("none"));
  assert.equal(none.text.trim(), "No BUSY app found in this folder or above it.");
  const open = () => dialog.querySelectorAll("button").find((el) => el.dataset.part === "open");
  assert.equal(open().ariaDisabled, "true");
  // Found, trusted already, then Don't Trust (the folder moved on in between): the pop-up says so and stays.
  answer = { ...FOUND, trusted: true, listed: true };
  dialog.querySelectorAll("button").find((el) => el.dataset.part === "choose-folder").fire("click");
  await settle();
  assert.deepEqual(calls.at(-1), ["find", { pick: "folder" }]);
  assert.match(find(".create-app-muted", "Apps").text, /in your Apps already/);
  open().fire("click");
  assert.equal(dialog.querySelector(".create-app-said").textContent, "Opening the app");
  await settle();
  assert.equal(dialog.querySelector(".create-app-said").textContent, "The folder was not trusted, so it was not opened.");
  assert.equal(scrim.hidden, false);
  // The dialog closed without a choice: what was found stays.
  answer = null;
  dialog.querySelectorAll("button").find((el) => el.dataset.part === "choose-folder").fire("click");
  await settle();
  assert.ok(dialog.querySelector(".create-app-result").classes.has("found"));
});
