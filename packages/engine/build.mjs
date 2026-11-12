// Builds the emulator's two wasm modules for each firmware version in firmware.json:
//
//   build/<version>/runtime.mjs + runtime.wasm — the BUSY Bar JS runtime, one instance per running app;
//   build/<version>/screen.mjs + screen.wasm   — the displays: LVGL and the firmware's GUI, canvas and display/draw API;
//   build/<version>/web                        — that firmware's local web, as it ships it (assets/frontend-build/public);
//   build/<version>/docs                       — the bar's API documentation as the firmware's build makes it: the
//                                                OpenAPI description (openapi.yaml, merged by its scripts/openapi_merge.py)
//                                                and the Swagger UI page around it (scripts/swagger.py, from the Swagger
//                                                UI archive in assets/swagger), with Swagger UI's LICENSE and NOTICE;
//   build/<version>/build-info.json            — the firmware commit all of the above came from, its API version, the
//                                                compiler's version and what the server needs to know about the modules;
//   build/apps-assets                          — what the GUI and the system apps read from /ext/apps_assets. The build
//                                                does not write it; it checks it against apps-assets.json, which
//                                                says where each file comes from and what its bytes are.
//
//   node emulator/packages/engine/build.mjs [runtime] [screen] [--firmware <version>|all] [--emsdk <path>] [--work <dir>]
//                                           [--firmware-repo <path>] [--assets-from <dir>] [--debug]
//
// build/ is all the server reads: it runs with no firmware checkout around. The build is the only step that needs one —
// the busybar-firmware submodule beside emulator/, or --firmware-repo <path> (EMU_FIRMWARE_REPO).
//
// Each version's sources are the firmware commit from firmware.json, exported with `git archive` from the firmware
// checkout into build/src/<version>. The firmware's own submodules (JerryScript, LVGL, mongoose, ...) are linked in from
// that checkout, after checking it has the commits that version pins.
//
// The output does not depend on where or when it is built: paths the compiler would put into the modules (__FILE__ in
// the firmware's asserts) are mapped to paths inside the firmware, the date and time macros are errors (the build date
// the emulated bar reports is the firmware commit's, as the firmware's own build script would set it), sources are
// compiled and linked in sorted order, and a file in build/ is rewritten only when its bytes change, so a second run
// with nothing changed touches nothing.
// It does depend on the compiler: the committed modules are built on macOS with the Emscripten version firmware.json
// names, and the build says so when another one is installed.
//
// --assets-from <dir> takes the app assets that come from a firmware build again from <dir>, the
// resources/apps_assets folder of the firmware's own build (fbt), and records their new bytes in apps-assets.json.
//
// runtime, compiled unchanged:
//   - JerryScript (lib/jerryscript amalgam) with the defines from lib/jerryscript.scons;
//   - the app globals, applications/services/js_runner/*.c (all but js_runner.c);
//   - the libraries they use: FuriString, toolbox url/slice/path/tls_config, http headers/response, cJSON.
// screen, compiled unchanged:
//   - LVGL (lib/lvgl, the sources lib/lvgl.scons lists) with the firmware's lv_conf.h, and lib/lvgl_addons
//     (fonts, themes, file system);
//   - the GUI service and its widgets, the canvas service, the font registry, the back display's status bar;
//   - the system around the apps: the desktop, the apps menu and the JS app launcher (with lib/js_app), which the
//     selector, the launch and quit API and an app's exit go through;
//   - web_server/http_api/api_display.c with mongoose: request parsing, validation and errors as on the bar;
//   - lib/anim_file and lib/xpm for animations and XPM bitmaps.
// Replaced by emulator code in native/: the Furi OS layer, storage and the network, js_runner.c (emu_runner.c),
// GUI input for the runtime, the display drivers and the services the GUI asks about (emu_screen.c), the services the
// status bar shows (emu_status.c), all driven by the JS host. Furi's headers are copied to build/gen with the ARM
// inline assembly in check.h swapped for a call into the emulator.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { assetsProblems, dirtyEntries, emscriptenVersion, filesIn, manifestText, readManifest, refreshAssets } from "./checks.mjs";
import { patches } from "./patches.mjs";
import { execProgram, findProgram, ProgramNotFound, spawnProgram } from "./programs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const native = join(here, "native");
const out = join(here, "build");

const args = process.argv.slice(2);
// Every word is checked before anything is built: an option the build does not know is a wrong call (exit code 2),
// not one it passes over. The rules are those of packages/server/arguments.mjs, which the engine does not import.
for (let i = 0; i < args.length; i++) {
  const word = args[i];
  let problem = null;
  if (word === "--help" || word === "-h") {
    writeSync(1, `${readFileSync(fileURLToPath(import.meta.url), "utf8").split("\nimport ")[0].replace(/^\/\/ ?/gm, "")}\n`);
    process.exit(0);
  } else if (["--firmware", "--emsdk", "--work", "--firmware-repo", "--assets-from"].includes(word)) {
    if (args[i + 1] === undefined || args[i + 1].startsWith("--")) problem = `${word} needs a value`;
    i++;
  } else if (!["--debug", "runtime", "screen"].includes(word)) {
    problem = word.startsWith("-") ? `unknown option ${word}` : `unknown argument ${word} (it takes runtime, screen)`;
  }
  if (problem) {
    writeSync(2, `build.mjs: ${problem}. node ${relative(process.cwd(), fileURLToPath(import.meta.url))} --help lists what it takes.\n`);
    process.exit(2);
  }
}
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
// The firmware checkout the sources come from: the submodule beside emulator/ unless told otherwise.
const firmwareRepo = resolve(option("--firmware-repo", process.env.EMU_FIRMWARE_REPO ?? join(repo, "busybar-firmware")));
const assetsFrom = option("--assets-from", null);
const debug = args.includes("--debug");
const emsdk = resolve(option("--emsdk", process.env.EMSDK ?? join(repo, "..", "emsdk")));
// Where the source trees, generated headers and objects go: build/src, build/gen and build/obj by default. On a disk
// without symbolic links (exFAT) the source trees cannot be made, so there the work goes elsewhere: --work <dir> or
// EMU_BUILD_WORK. The modules are linked there too (<work>/out/<version>) and then installed into build/<version>.
const work = resolve(option("--work", process.env.EMU_BUILD_WORK ?? out));
const targets = ["runtime", "screen"].filter((t) => args.includes(t));
if (targets.length === 0) targets.push("runtime", "screen");

const config = JSON.parse(readFileSync(join(here, "firmware.json"), "utf8"));
const wanted = option("--firmware", "all");
const versions = wanted === "all" ? Object.keys(config.versions) : [wanted];
for (const v of versions) {
  if (!config.versions[v]) {
    console.error(`Unknown firmware "${v}". Versions in emulator/packages/engine/firmware.json: ${Object.keys(config.versions).join(", ")}`);
    process.exit(1);
  }
}

// The firmware's submodules the build compiles or includes. They are linked into each version's source tree.
const SUBMODULES = ["lib/jerryscript", "lib/lvgl", "lib/mongoose", "lib/cjson", "lib/stb/stb_repo", "lib/heatshrink", "fbt_layers/core_libs", "fbt_layers/fbtng"];
// The firmware's local web as it ships it, and where its API version is written.
const WEB = "assets/frontend-build/public";
const OPENAPI = "applications/services/web_server/openapi/openapi.yaml";
const OPENAPI_DIR = "applications/services/web_server/openapi";
// The firmware's own scripts that make its API documentation (bsb_assets.scons), and the Swagger UI they take.
const DOCS_SCRIPTS = ["scripts/openapi_merge.py", "scripts/swagger.py", "scripts/flipper"];
const SWAGGER = "assets/swagger";
const HTTP_API_H = "applications/services/web_server/http_api/http_api.h";
// What the build needs from the firmware itself, exported per version.
const EXPORTED = ["lib", "applications/services", ...DOCS_SCRIPTS, SWAGGER, "applications/main/apps_menu", "applications/main/busy", "applications/main/settings_menu", "applications/main/soft_off", "applications/settings", "applications/system/updater", "applications/system/js_app_launcher", "targets/f21/config", "targets/f21/furi_hal", WEB];

// ---------------------------------------------------------------- common flags

const common = [
  // newlib's attribute macro, which the firmware's headers use and Emscripten's libc doesn't define.
  "-D_ATTRIBUTE(attrs)=__attribute__(attrs)",
  debug ? "-O0" : "-O2",
  debug ? "-g" : "-g0",
  "-std=gnu17",
  "-Wno-everything",
  // The one warning that stays, as an error: __DATE__, __TIME__ and __TIMESTAMP__ would put the moment of the build
  // into a module, and the same sources would give other bytes the next day.
  "-Wdate-time",
  "-Werror=date-time",
];
// __FILE__ in the firmware's asserts would put this machine's paths into the modules, and make them differ from one
// build directory to the next. So the compiler is told to write a firmware source as its path in the firmware, a
// generated one as gen/..., the emulator's own as native/... and a system header as emsdk/....
// A debug build keeps the real paths, for the debugger to find the sources by; it is not what gets committed.
const pathMaps = () => (debug ? [] : [[fw, ""], [gen, "gen/"], [native, "native/"], [emsdk, "emsdk/"]].map(([from, to]) => `-ffile-prefix-map=${from}${sep}=${to}`));
const linkFlags = (exported) => [
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sENVIRONMENT=node,web",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sINITIAL_MEMORY=16MB",
  "-sSTACK_SIZE=1MB",
  `-sEXPORTED_FUNCTIONS=${exported.map((f) => `_${f}`).join(",")}`,
  "-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToNewUTF8,HEAPU8,HEAPU32",
  "-Wl,--error-limit=0",
];

// Files in build/ this run wrote or removed; everything else was already as built.
const changed = [];

// The app assets first, before anything is compiled or written: the folder has to be what apps-assets.json says.
if (assetsFrom) refreshAppsAssets(resolve(assetsFrom));
checkAppsAssets();

const emcc = findEmcc();
// The compiler the modules are built with. Another version gives other bytes: allowed, and said aloud.
const emscripten = installedEmscripten();
const otherCompiler = emscripten === config.emscripten ? null : `Emscripten ${emscripten} is installed, firmware.json names ${config.emscripten}: the modules will not be byte for byte the committed ones.`;
if (otherCompiler) console.warn(`Warning: ${otherCompiler}`);
const patchedFrom = new Map(); // patched copy → directory of the original
// Firmware libraries whose working tree was found clean.
const clean = new Set();

// Per version: the source tree, generated headers, the directory the modules are linked in and the one they are
// installed into.
let fw, gen, staging, dest;
// build-info.json: about the firmware and the build, then about the runtime module, then about the screen module.
const INFO_KEYS = ["version", "firmware", "commit", "buildDate", "emscripten", "optimized", "api", "web", "docs", "jerryscript", "firmwareDefines", "emulatorDefines", "consoleSeverities", "lvgl", "screenDefines"];

for (const version of versions) {
  const { commit } = config.versions[version];
  fw = prepareSource(version, commit);
  gen = join(work, "gen", version);
  staging = join(work, "out", version);
  dest = join(out, version);
  mkdirSync(staging, { recursive: true });
  console.log(`== firmware ${version} (${commit.slice(0, 8)})`);
  generateHeaders();
  const info = { version, firmware: commit.slice(0, 8), commit, buildDate: buildDate(commit), emscripten, optimized: !debug, api: apiVersion(), web: webRecord(commit), docs: buildDocs() };
  if (targets.includes("runtime")) Object.assign(info, buildRuntime());
  if (targets.includes("screen")) Object.assign(info, await buildScreen(version, info.buildDate));
  // Everything is built: only now is build/<version> touched, so a build that fails leaves it whole.
  for (const target of targets) for (const ext of ["mjs", "wasm"]) install(readFileSync(join(staging, `${target}.${ext}`)), join(dest, `${target}.${ext}`));
  syncDir(join(fw, WEB), join(dest, "web"));
  syncDir(join(staging, "www", "docs"), join(dest, "docs"));
  // A build of one module keeps what build-info.json says about the other. The keys go in a fixed order, so that the
  // file does not depend on what was built first.
  const infoPath = join(dest, "build-info.json");
  const merged = { ...(existsSync(infoPath) ? JSON.parse(readFileSync(infoPath, "utf8")) : {}), ...info };
  const unknown = Object.keys(info).filter((key) => !INFO_KEYS.includes(key));
  if (unknown.length) throw new Error(`build-info.json: add ${unknown.join(", ")} to INFO_KEYS`);
  const ordered = Object.fromEntries(INFO_KEYS.filter((key) => key in merged).map((key) => [key, merged[key]]));
  install(Buffer.from(JSON.stringify(ordered, null, 2) + "\n"), infoPath);
}

console.log(`built ${targets.join(", ")} for ${versions.join(", ")}`);
console.log(changed.length ? `changed in build/:\n${summary(changed).map((line) => `  ${line}`).join("\n")}` : "nothing in build/ changed");
if (otherCompiler) console.warn(`Warning: ${otherCompiler}`);

// ---------------------------------------------------------------- source trees

function prepareSource(version, commit) {
  if (!existsSync(join(firmwareRepo, ".git"))) {
    console.error(`No firmware checkout at ${firmwareRepo}. Check out the busybar-firmware submodule or pass --firmware-repo <path>.`);
    process.exit(1);
  }
  const src = join(work, "src", version);
  const stamp = join(src, ".commit");
  const wanted = [commit, ...EXPORTED].join(" ");
  if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== wanted) {
    unlinkSubmodules(src);
    rmSync(src, { recursive: true, force: true });
    mkdirSync(src, { recursive: true });
    const tar = git(["-C", firmwareRepo, "archive", "--format=tar", commit, ...EXPORTED], { maxBuffer: 1 << 30 });
    execProgram("tar", ["-xf", "-"], { cwd: src, input: tar, maxBuffer: 1 << 30 });
    writeFileSync(stamp, wanted);
  }
  for (const sub of SUBMODULES) {
    const pinned = git(["-C", firmwareRepo, "ls-tree", commit, sub]).toString().split(/\s+/)[2];
    const checkedOut = existsSync(join(firmwareRepo, sub)) ? git(["-C", join(firmwareRepo, sub), "rev-parse", "HEAD"]).toString().trim() : "missing";
    if (pinned !== checkedOut) {
      console.error(`Firmware ${version} pins ${sub} at ${pinned}, busybar-firmware has ${checkedOut}.`);
      console.error(`Run: git -C busybar-firmware/${sub} checkout ${pinned}  (or git -C busybar-firmware submodule update --init ${sub})`);
      process.exit(1);
    }
    // The library is compiled from its working tree, so the tree has to be the commit: no edits, no stray files.
    if (!clean.has(sub)) {
      const dirty = dirtyEntries(join(firmwareRepo, sub));
      if (dirty.length) {
        console.error(`The firmware's ${sub} has ${dirty.length} local change${dirty.length === 1 ? "" : "s"}, so the modules would not be built from commit ${pinned.slice(0, 8)} as build-info.json would say:`);
        for (const line of dirty.slice(0, 10)) console.error(`  ${line}`);
        if (dirty.length > 10) console.error(`  and ${dirty.length - 10} more`);
        console.error(`Put the changes aside (git -C ${join(firmwareRepo, sub)} stash --include-untracked) and build again.`);
        process.exit(1);
      }
      // A library's own submodules are compiled too (core_libs holds M*LIB and utz): they must be checked out.
      const absent = git(["-C", join(firmwareRepo, sub), "submodule", "status", "--recursive"]).toString().split("\n").filter((line) => line.startsWith("-"));
      if (absent.length) {
        console.error(`The firmware's ${sub} has ${absent.length} submodule${absent.length === 1 ? "" : "s"} not checked out: ${absent.map((line) => line.slice(1).split(/\s+/)[1]).join(", ")}.`);
        console.error(`Run: git -C ${firmwareRepo} submodule update --init --recursive ${sub}`);
        process.exit(1);
      }
      clean.add(sub);
    }
    const link = join(src, sub);
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) continue;
    if (existsSync(link)) rmdirSync(link); // git archive leaves an empty directory for a submodule
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(firmwareRepo, sub), link, "junction");
  }
  return src;
}

// Removes the links to the firmware's submodules first, so that deleting a source tree never reaches into them.
function unlinkSubmodules(src) {
  for (const sub of SUBMODULES) {
    const link = join(src, sub);
    try {
      if (lstatSync(link).isSymbolicLink()) rmdirSync(link);
    } catch {
      // Not there.
    }
  }
}

// ---------------------------------------------------------------- generated headers

function generateHeaders() {
  rmSync(gen, { recursive: true, force: true });

  // Furi's headers with the ARM bits swapped out.
  // Headers, and state.c, which is built from here so that its own includes find these headers too.
  cpSync(join(fw, "fbt_layers/core_libs/lib/furi"), join(gen, "furi"), { recursive: true, filter: (src) => !src.endsWith(".c") || src.endsWith("state.c") });
  patch(
    join(gen, "furi/core/check.h"),
    (check) =>
      check
        .replace(/register const void\* r12 asm\("r12"\) = \(void\*\)message;/g, "emu_furi_crash((const char*)(message));")
        .replace(/asm volatile\("sukima%=:" : : "r"\(r12\)\);/g, "")
        .replace(/asm volatile\("bkpt 0"\);/g, 'emu_furi_crash("break");')
        .replace('#include "common_defines.h"', '#include "common_defines.h"\n\nFURI_NORETURN void emu_furi_crash(const char* message);'),
    (check) => /asm\s*(volatile)?\s*\(/.test(check),
  );

  // The firmware's lv_conf.h without its OS layer: the emulator runs LVGL on one thread, so locks are no-ops. Nothing
  // that draws depends on it.
  patch(
    join(fw, "targets/f21/config/lv_conf.h"),
    (conf) => conf.replace(/#define LV_USE_OS\s+LV_OS_CUSTOM/, "#define LV_USE_OS   LV_OS_NONE"),
    () => false,
    join(gen, "lv_conf.h"),
  );

  // lib/lvgl.scons builds the bin decoder from a patched copy; the same substitutions here.
  writeFileSync(
    join(gen, "lv_bin_decoder_patched.c"),
    readFileSync(join(fw, "lib/lvgl/src/libs/bin_decoder/lv_bin_decoder.c"), "utf8")
      .replaceAll('"bin"', '"image"')
      .replaceAll("../..", "src")
      .replaceAll('"lv_bin_decoder.h"', '"src/libs/bin_decoder/lv_bin_decoder.h"'),
  );
}

// ---------------------------------------------------------------- runtime

function buildRuntime() {
  const furi = join(fw, "fbt_layers/core_libs/lib/furi");
  const services = join(fw, "applications/services");
  const jsRunner = join(services, "js_runner");
  const amalgam = join(fw, "lib/jerryscript/amalgam");

  const scons = readFileSync(join(fw, "lib/jerryscript.scons"), "utf8");
  const firmwareDefines = [...scons.matchAll(/^\s*"(JERRY_[A-Z0-9_]+=[^"]*)"/gm)].map((m) => m[1]);
  // Deviations from the firmware: memory statistics, to measure the heap; promise events, for the emulator's note of a
  // rejection nobody handles (emu_runner.c). Neither changes what an app does.
  const emulatorDefines = ["JERRY_MEM_STATS=1", "JERRY_PROMISE_CALLBACK=1"];
  // Differences between firmware versions that emu_runner.c follows.
  if (readFileSync(join(jsRunner, "js_runner_i.h"), "utf8").includes("js_runner_defer")) emulatorDefines.push("EMU_JS_RUNNER_DEFER");
  const severities = /typedef enum JsRunnerConsoleSeverity \{([^}]*)\}/.exec(readFileSync(join(jsRunner, "js_runner.h"), "utf8"))[1];
  const consoleSeverities = [...severities.matchAll(/JsRunnerConsoleSeverity(\w+)/g)].map((m) => m[1].toLowerCase());

  const firmwareGlobals = [
    "js_console.c", "js_fetch.c", "js_fetch_body_methods.c", "js_headers.c", "js_input.c", "js_interval.c",
    "js_local_storage.c", "js_readable_stream.c", "js_request.c", "js_response.c", "js_stubs.c", "js_url.c", "js_util.c",
  ].map((f) => join(jsRunner, f));
  const firmwareLibs = [
    join(furi, "core/string.c"),
    join(fw, "lib/toolbox/url.c"),
    join(fw, "lib/toolbox/slice.c"),
    join(fw, "lib/toolbox/path.c"),
    join(fw, "lib/toolbox/tls_config.c"),
    join(fw, "lib/http/http_headers.c"),
    join(fw, "lib/http/http_response.c"),
    join(fw, "lib/cjson/cJSON.c"),
  ];
  const shims = ["host.c", "furi_shim.c", "memmgr_shim.c", "fetch_shim.c", "storage_shim.c", "gui_shim.c", "emu_runner.c"].map((f) => join(native, f));
  // JerryScript counts the instructions it executes (patches.mjs).
  const sources = [patched(join(amalgam, "jerryscript.c")), ...firmwareGlobals, ...firmwareLibs, ...shims];

  const includes = [
    join(native, "runtime-include"), // gui/gui.h with only what the JS runtime uses
    join(native, "include"), // stand-ins: storage/storage.h, furi_hal_resources.h, cmsis_compiler.h
    native,
    join(gen, "furi"),
    gen,
    jsRunner,
    services,
    join(fw, "lib"),
    join(fw, "lib/toolbox"),
    join(fw, "fbt_layers/core_libs/lib/mlib"),
    amalgam,
  ];
  const exported = [
    "malloc", "free", "emu_init", "emu_run_file", "emu_terminate", "emu_heap_stats", "emu_last_error", "emu_cleanup",
    "emu_pump", "emu_timer_fire", "emu_input", "emu_fetch_headers", "emu_fetch_data", "emu_fetch_error", "emu_fetch_finish",
    "emu_vm_ops_count", "emu_alloc_bytes_count", "emu_unhandled_take", "emu_system_heap",
  ];
  const flags = [...[...firmwareDefines, ...emulatorDefines].map((d) => `-D${d}`), ...includes.map((i) => `-I${i}`), ...common, ...pathMaps()];

  console.log(`runtime: ${firmwareGlobals.length} firmware globals, ${firmwareLibs.length} firmware libs, ${shims.length} shims, ${firmwareDefines.length} JerryScript defines`);
  execProgram(emcc.cmd, [...emcc.prefix, ...sources, ...flags, ...linkFlags(exported), "-o", join(staging, "runtime.mjs")], { stdio: "inherit", env: emcc.env });
  return { jerryscript: rev(join(fw, "lib/jerryscript")), firmwareDefines, emulatorDefines, consoleSeverities };
}

// ---------------------------------------------------------------- screen

async function buildScreen(version, date) {
  const furi = join(fw, "fbt_layers/core_libs/lib/furi");
  const services = join(fw, "applications/services");
  const lvgl = join(fw, "lib/lvgl");
  // The directories lib/lvgl.scons globs.
  const lvglDirs = [
    "src", "src/core", "src/display", "src/draw", "src/draw/sw", "src/draw/sw/blend", "src/draw/dma2d", "src/font",
    "src/indev", "src/layouts", "src/misc", "src/misc/cache", "src/stdlib", "src/stdlib/clib", "src/osal",
    "src/others/sysmon", "src/others/observer", "src/themes", "src/tick", "src/libs/lodepng", "src/libs/qrcode",
    ...subdirs(join(lvgl, "src/layouts")).map((d) => `src/layouts/${d}`),
    ...subdirs(join(lvgl, "src/themes")).map((d) => `src/themes/${d}`),
    ...subdirs(join(lvgl, "src/widgets")).map((d) => `src/widgets/${d}`),
  ];
  const addons = join(fw, "lib/lvgl_addons");
  const gui = join(services, "gui");
  const sources = [
    ...lvglDirs.flatMap((d) => cFiles(join(lvgl, d))),
    join(gen, "lv_bin_decoder_patched.c"),
    ...["extensions", "fonts", "themes", "fs"].flatMap((d) => cFiles(join(addons, d))),
    join(gui, "gui.c"),
    join(gui, "widget.c"),
    join(gui, "scene_manager.c"),
    // All the modules: the themes style every widget class.
    ...cFiles(join(gui, "modules")),
    ...cFiles(join(gui, "modules/private")),
    ...cFiles(join(services, "canvas")),
    ...cFiles(join(services, "canvas/widgets")),
    join(services, "font_registry/font_registry.c"),
    join(services, "status_bar/status_bar.c"),
    join(services, "supervisor/supervisor.c"),
    ...cFiles(join(services, "status_bar/widgets")),
    ...cFiles(join(services, "desktop")),
    ...["", "/scenes", "/settings"].flatMap((d) => cFiles(join(fw, "applications/main/apps_menu" + d))),
    ...["", "/scenes"].flatMap((d) => cFiles(join(fw, "applications/system/js_app_launcher" + d))),
    // The programs of the other positions of the mode selector, and the BUSY timer they show and set.
    ...["", "/scenes", "/helpers", "/widgets"].flatMap((d) => cFiles(join(fw, "applications/main/busy" + d))),
    ...["", "/scenes"].flatMap((d) => cFiles(join(fw, "applications/main/settings_menu" + d))),
    // The settings programs: every folder of applications/settings with its models, scenes and widgets.
    ...subdirs(join(fw, "applications/settings")).flatMap((app) => ["", "/models", "/scenes", "/widgets"].flatMap((d) => (existsSync(join(fw, "applications/settings", app + d)) ? cFiles(join(fw, "applications/settings", app + d)) : []))),
    join(fw, "lib/settings_helpers/app_desc.c"),
    ...["", "/settings"].flatMap((d) => cFiles(join(services, "busy_timer" + d))),
    // The firmware's API handlers the emulator answers with (emu_screen.c lists them), and what they format with.
    ...["busy", "name", "time", "ble", "wifi", "smart_home", "account", "update"].map((f) => join(services, `web_server/http_api/api_${f}.c`)),
    join(services, "wifi/wifi_util.c"),
    join(services, "mqtt/mqtt_config.c"),
    ...cFiles(join(fw, "lib/js_app")),
    ...cFiles(join(fw, "lib/js_app/setting_types")),
    join(fw, "lib/setting_provider/setting_provider.c"),
    ...cFiles(join(fw, "lib/setting_provider/types")),
    join(fw, "lib/storage_utils/dir_walk.c"),
    join(services, "web_server/http_api/api_display.c"),
    join(fw, "lib/mongoose/mongoose.c"),
    ...cFiles(join(fw, "lib/anim_file")),
    ...cFiles(join(fw, "lib/anim_file/components")),
    join(fw, "lib/xpm/xpm.c"),
    join(fw, "lib/stb/stb.c"),
    ...["color", "value_index", "dsp", "bit_queue", "rle_encode", "path", "hex", "semver", "json_helper", "strint", "tzutil"].map((f) => join(fw, `lib/toolbox/${f}.c`)),
    join(furi, "core/string.c"),
    join(gen, "furi/core/state.c"),
    join(fw, "lib/cjson/cJSON.c"),
    join(furi, "../datetime/datetime.c"),
    join(furi, "../utz/utz.c"),
    join(furi, "../utz/zones.c"),
    ...cFiles(join(native, "screen-assets")),
    ...["host.c", "furi_shim.c", "memmgr_shim.c", "storage_shim.c", "emu_screen.c", "emu_status.c", "emu_system.c", "emu_modes.c", "emu_settings.c"].map((f) => join(native, f)),
  ].map(patched);

  const includes = [
    join(native, "screen-include"), // stand-ins for the services and HAL the GUI asks about
    join(native, "include"),
    join(native, "screen-assets"),
    native,
    join(gen, "furi"),
    gen, // lv_conf.h
    services,
    join(fw, "lib"),
    join(fw, "lib/toolbox"),
    join(fw, "lib/lvgl"),
    join(fw, "lib/lvgl/src"),
    join(fw, "lib/lvgl_addons"),
    join(fw, "lib/anim_file"),
    join(fw, "lib/mongoose"),
    join(fw, "fbt_layers/core_libs/lib/mlib"),
    join(fw, "fbt_layers/core_libs/lib"),
    join(fw, "fbt_layers/core_libs/lib/datetime"),
    join(fw, "fbt_layers/fbtng/targets/furi_hal_include"), // furi_hal_rtc.h: the API only, emu_screen.c implements it
    join(fw, "applications/main"),
    join(fw, "applications/system"),
    join(fw, "lib/setting_provider"),
    join(fw, "targets/f21/furi_hal"), // last: furi_hal_nvm.h, which emu_system.c implements; stand-ins come first
    fw, // <applications/system/updater/updater.h>
  ];
  // SRV_INPUT: the GUI takes keys from the input service, as on the bar.
  // EMU_FW_*: the firmware the About program reports, in place of the version.inc.h fbt generates.
  const defines = ["LV_CONF_INCLUDE_SIMPLE", "LV_LVGL_H_INCLUDE_SIMPLE", "MG_ARCH=MG_ARCH_UNIX", "SRV_INPUT", `EMU_FW_VERSION="${version}"`, `EMU_FW_COMMIT="${config.versions[version].commit.slice(0, 8)}"`, `EMU_FW_BUILD_DATE="${date}"`];
  // C23 for the digit separators lib/anim_file uses (0xff'00'00'00), which GCC accepts in C17.
  const flags = [...defines.map((d) => `-D${d}`), ...includes.map((i) => `-I${i}`), ...common, "-std=gnu2x", ...pathMaps()];
  // api_display.c answers a draw from canvas's callback through mongoose's wakeup; the emulator answers the host.
  // The status bar asks the services it shows only when they are in the build (emu_status.c stands in for them), and
  // takes READ_BIT from the STM32 headers.
  const perFile = {
    "api_display.c": ["-Dmg_wakeup=emu_mg_wakeup"],
    "status_bar.c": ["-DSRV_POWER", "-DSRV_AUDIO", "-DSRV_WIFI", "-DSRV_BLE", "-DREAD_BIT(REG,BIT)=((REG)&(BIT))"],
  };

  const objects = await compileAll(sources, join(work, "obj", version), flags, perFile);
  const exported = [
    "malloc", "free", "emu_screen_init", "emu_screen_request", "emu_screen_reply", "emu_screen_reply_size",
    "emu_screen_release", "emu_screen_frame", "emu_screen_input", "emu_screen_launch", "emu_screen_quit", "emu_screen_script_event",
    "emu_screen_status", "emu_tick", "emu_gui_draw_time", "emu_gui_lead", "emu_timer_fire", "emu_pump", "emu_web_server_poll", "emu_screen_js_fatal", "emu_screen_asleep", "emu_wait_probe",
    "emu_screen_restart_timers", "emu_screen_running_timers", "emu_screen_drawing", "emu_screen_drawn",
    "emu_screen_rtc_follow", "emu_screen_rtc_now",
  ];
  console.log(`screen: linking ${objects.length} objects`);
  // The object list goes in a response file: on the command line it outgrows Windows' limit.
  const objectList = join(work, "obj", version, "objects.rsp");
  writeFileSync(objectList, objects.map((o) => `"${o.replaceAll("\\", "/")}"`).join("\n"));
  execProgram(emcc.cmd, [...emcc.prefix, `@${objectList}`, ...common, ...linkFlags(exported), "-o", join(staging, "screen.mjs")], { stdio: "inherit", env: emcc.env });
  return { lvgl: rev(lvgl), screenDefines: defines };
}

// ---------------------------------------------------------------- what the server reads besides the modules

// The firmware's API version, which the bar reports in /api/version and checks apps' manifests against. The firmware
// has it twice — in the header the handlers are compiled with (so it is already in the screen module) and in the API
// description — and the two must agree.
function apiVersion() {
  const header = /#define\s+API_VERSION\s*\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/.exec(readFileSync(join(fw, HTTP_API_H), "utf8"))?.slice(1).join(".");
  const described = /^\s+version:\s*([\d.]+)\s*$/m.exec(readFileSync(join(fw, OPENAPI), "utf8"))?.[1];
  if (!header || header !== described) {
    console.error(`Cannot tell the firmware's API version: ${HTTP_API_H} says ${header ?? "nothing"}, ${OPENAPI} says ${described ?? "nothing"}.`);
    process.exit(1);
  }
  return header;
}

// The bar's API documentation, made as the firmware's build makes it (scripts/fbt_env_modules/fwenv/bsb_assets.scons):
// openapi_merge.py joins the per-tag descriptions of applications/services/web_server/openapi into one openapi.yaml,
// which the bar serves at /openapi.yaml, and swagger.py writes the Swagger UI page /docs/ shows it with, its scripts
// and styles gzipped, from the Swagger UI archive the firmware keeps. Both are the firmware's own scripts, run with
// Python 3 and its packages PyYAML and colorlog, as the firmware's build runs them; their output does not depend on
// the machine. Swagger UI's LICENSE and NOTICE (Apache-2.0) go beside it. Written to <work>/out/<version>/www/docs and
// installed into build/<version>/docs.
function buildDocs() {
  // The firmware's files are named with fromFirmware(), not joined to fw: they go into no module, so the license summary's
  // reading of what the modules are compiled from (packages/app/tools/notices/build-paths.mjs) leaves them out; their
  // licenses are recorded on their own (tools/export/licenses.json, app-libraries.json: Swagger UI).
  const fromFirmware = (...parts) => resolve(fw, ...parts);
  const www = join(staging, "www");
  rmSync(www, { recursive: true, force: true });
  const docs = resolve(www, "docs");
  mkdirSync(docs, { recursive: true });
  const python = findPython();
  const segments = readdirSync(fromFirmware(OPENAPI_DIR)).filter((f) => f.endsWith(".yaml") && !f.startsWith("._")).sort().map((f) => fromFirmware(OPENAPI_DIR, f));
  const spec = resolve(docs, "openapi.yaml");
  const quiet = { stdio: ["ignore", "pipe", "pipe"] };
  const runScript = (script, argv) => {
    try {
      execProgram(python, [fromFirmware(script), ...argv], { cwd: fromFirmware("scripts"), ...quiet });
    } catch (error) {
      console.error(`${script} failed: ${String(error.stderr ?? error.message).trim().split("\n").slice(-3).join(" ")}`);
      console.error("It runs with Python 3 and the packages PyYAML and colorlog: python3 -m pip install pyyaml colorlog");
      process.exit(1);
    }
  };
  runScript("scripts/openapi_merge.py", ["merge", spec, ...segments]);
  // The one change to the bar's description: its example serial number (a real bar's, in system.yaml) becomes the
  // serial number the emulated bar reports, EMULATOR, so that no bar's serial is published with the emulator and the
  // example is what "Try it out" answers here.
  const serials = /^(\s+example: )'[0-9a-fA-F]{24}'$/gm;
  const merged0 = readFileSync(spec, "utf8");
  const serialExamples = (merged0.match(serials) ?? []).length;
  writeFileSync(spec, merged0.replace(serials, "$1'EMULATOR'"));
  // swagger.py writes the page into the folder it is given (--clean empties it first) and a redirect page into
  // ../api, which the emulator does not serve: /api/ is the bar's API.
  const merged = readFileSync(spec);
  runScript("scripts/swagger.py", [spec, "-o", docs, "--dist-dir", fromFirmware(SWAGGER), "-q"]);
  writeFileSync(spec, merged);
  const version = /swagger-ui-([\d.]+)\.zip$/.exec(readdirSync(fromFirmware(SWAGGER)).find((f) => /^swagger-ui-[\d.]+\.zip$/.test(f)) ?? "")?.[1];
  const swagger = /default="([\d.]+)"/.exec(readFileSync(fromFirmware("scripts/swagger.py"), "utf8"))?.[1];
  if (!version || version !== swagger) {
    console.error(`Cannot tell which Swagger UI the firmware's docs take: ${SWAGGER} has ${version ?? "no archive"}, scripts/swagger.py names ${swagger ?? "none"}.`);
    process.exit(1);
  }
  const archive = fromFirmware(SWAGGER, `swagger-ui-${version}.zip`);
  for (const name of ["LICENSE", "NOTICE"]) writeFileSync(resolve(docs, name), execProgram("tar", ["-xOf", archive, `swagger-ui-${version}/${name}`], { maxBuffer: 1 << 24 }));
  const files = filesIn(docs);
  return { from: [OPENAPI_DIR, SWAGGER], swaggerUi: version, serialExamples, files: files.length, bytes: files.reduce((sum, f) => sum + statSync(resolve(docs, f)).size, 0) };
}

// Python 3, for the firmware's scripts: python3, or python on Windows.
function findPython() {
  for (const name of process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
    try {
      return findProgram(name);
    } catch (error) {
      if (!(error instanceof ProgramNotFound)) throw error;
    }
  }
  console.error("Cannot find Python 3, which runs the firmware's scripts for its API documentation. Install it with the packages PyYAML and colorlog.");
  process.exit(1);
}

// The build date the emulated bar reports (About, /api/status/firmware). It is derived, not observed: the firmware's
// fbtng/scripts/version.py gives a build of a clean HEAD the committer date of that commit, as the commit records it,
// %Y-%m-%d, and this takes the same date. It has not been checked on a bar: there is no recording of a bar's
// build_date. What matters to the build is that the modules do not depend on the day they are built.
function buildDate(commit) {
  const date = git(["-C", firmwareRepo, "log", "-1", "--format=%cs", commit]).toString().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`Cannot tell the date of firmware commit ${commit}: git says "${date}".`);
    process.exit(1);
  }
  return date;
}

// The firmware's local web, as that commit ships it: what build-info.json says about the copy in build/<version>/web.
// It names the git tree the copy is made from: `git rev-parse <commit>:assets/frontend-build/public` in the firmware
// gives the same id. The server counts the files before it serves them.
function webRecord(commit) {
  const tree = git(["-C", firmwareRepo, "rev-parse", `${commit}:${WEB}`]).toString().trim();
  const files = filesIn(join(fw, WEB));
  return { from: WEB, tree, files: files.length, bytes: files.reduce((sum, f) => sum + statSync(join(fw, WEB, f)).size, 0) };
}

// What the GUI and the system apps read from /ext/apps_assets: the shared fonts, images, animations and sounds, and the
// system apps' own. They are not made here: the firmware's own build (fbt) converts the images and animations from
// PNG and the sounds from WAV, and build/apps-assets holds its output, part of it read from a bar. apps-assets.json
// lists every file with where it came from, the firmware source it is made from and its sha256.

// Stops the build when the folder is not what the list says: a file that is not listed, a listed file that is
// missing, a file with other bytes.
function checkAppsAssets() {
  const problems = assetsProblems(readManifest(join(here, "apps-assets.json")), join(out, "apps-assets"));
  if (problems.length === 0) return;
  for (const problem of problems.slice(0, 40)) console.error(problem);
  if (problems.length > 40) console.error(`and ${problems.length - 40} more`);
  console.error("Nothing was built.");
  process.exit(1);
}

// --assets-from: the files that came from a firmware build are taken from one again, and the list records their bytes.
// The files read from a bar stay as they are.
function refreshAppsAssets(from) {
  const manifestFile = join(here, "apps-assets.json");
  const manifest = readManifest(manifestFile);
  const { problems, changed: refreshed } = refreshAssets(manifest, from, join(out, "apps-assets"), install);
  if (problems.length) {
    for (const problem of problems.slice(0, 40)) console.error(problem);
    console.error("Nothing was changed.");
    process.exit(1);
  }
  if (refreshed.length) writeFileSync(manifestFile, manifestText(manifest));
  console.log(`app assets from ${from}: ${refreshed.length} of the firmware build's files changed${refreshed.length ? "; their sha256 in apps-assets.json is updated — commit both" : ""}`);
}

// ---------------------------------------------------------------- helpers

/** Writes `edit(file)` to `to` (the file itself by default); stops the build if the patch no longer applies. */
function patch(file, edit, broken, to = file) {
  const before = readFileSync(file, "utf8");
  const after = edit(before);
  if (after === before || broken(after)) {
    console.error(`${relative(fw, file)} changed upstream: update the patch in emulator/packages/engine/build.mjs`);
    process.exit(1);
  }
  writeFileSync(to, after);
}

// The source itself, or its patched copy in build/gen/<version>/patched; the copy finds its neighbours through -iquote.
function patched(src) {
  const rel = relative(fw, src).replaceAll("\\", "/");
  if (!patches[rel]) return src;
  let text = readFileSync(src, "utf8").replaceAll("\r\n", "\n");
  for (const [find, replace] of patches[rel]) {
    if (!text.includes(find)) {
      console.error(`${rel} changed upstream: update emulator/packages/engine/patches.mjs`);
      process.exit(1);
    }
    text = text.replace(find, () => replace);
  }
  const copy = join(gen, "patched", rel);
  mkdirSync(dirname(copy), { recursive: true });
  writeFileSync(copy, `#line 1 "${rel}"\n` + text);
  patchedFrom.set(copy, dirname(src));
  return copy;
}

// Sorted, like everything else read from a directory: the order a file system lists names in differs between
// systems, and the order of the sources is the order of the code in the module.
function cFiles(dir) {
  // "._name.c" is what macOS leaves beside name.c on a disk without extended attributes.
  return readdirSync(dir).filter((f) => f.endsWith(".c") && !f.startsWith("._")).sort().map((f) => join(dir, f));
}

function subdirs(dir) {
  return readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory()).sort();
}

/** The changed files, with a folder that has many of them (a version's local web) as one line. */
function summary(files) {
  const folders = new Map();
  for (const f of files) {
    const folder = f.split("/").slice(0, 2).join("/");
    folders.set(folder, [...(folders.get(folder) ?? []), f]);
  }
  return [...folders].flatMap(([folder, inside]) => (inside.length > 8 ? [`${folder}/: ${inside.length} files`] : inside));
}

/** Writes `bytes` to `file` in build/ unless it already holds exactly them. */
function install(bytes, file) {
  if (existsSync(file) && readFileSync(file).equals(bytes)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  changed.push(relative(out, file).replaceAll("\\", "/"));
}

/** Makes `to` hold the same files as `from`: writes what differs, removes what `from` does not have. */
function syncDir(from, to) {
  const wanted = filesIn(from);
  let bytes = 0;
  for (const f of wanted) {
    const content = readFileSync(join(from, f));
    bytes += content.length;
    install(content, join(to, f));
  }
  for (const f of filesIn(to)) {
    if (wanted.includes(f)) continue;
    rmSync(join(to, f));
    changed.push(`${relative(out, join(to, f)).replaceAll("\\", "/")} (removed)`);
  }
  // Folders left empty by the removals.
  if (existsSync(to)) {
    const dirs = readdirSync(to, { recursive: true, withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(e.parentPath, e.name));
    for (const dir of dirs.sort().reverse()) if (readdirSync(dir).length === 0) rmdirSync(dir);
  }
  return { files: wanted.length, bytes };
}

// One object per source, in parallel. Objects are kept between builds; all are rebuilt when the flags or anything in
// native/ change, one when its source does.
async function compileAll(sources, objDir, flags, perFile) {
  const newest = Math.max(...readdirSync(native, { recursive: true }).map((f) => statSync(join(native, f)).mtimeMs));
  const stamp = JSON.stringify({ flags, perFile, newest });
  const stampFile = join(objDir, "stamp.json");
  if (!existsSync(stampFile) || readFileSync(stampFile, "utf8") !== stamp) rmSync(objDir, { recursive: true, force: true });
  mkdirSync(objDir, { recursive: true });

  const jobs = sources.map((src) => ({ src, obj: join(objDir, relative(work, src).replace(/[\\/:]/g, "_").replace(/\.c$/, ".o")) }));
  const todo = jobs.filter((j) => !existsSync(j.obj) || statSync(j.obj).mtimeMs < statSync(j.src).mtimeMs);
  console.log(`screen: compiling ${todo.length} of ${jobs.length} sources`);
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { src, obj } = todo[next++];
      const extra = [...(perFile[basename(src)] ?? []), ...(patchedFrom.has(src) ? ["-iquote", patchedFrom.get(src)] : [])];
      const { code, output } = await run(emcc.cmd, [...emcc.prefix, "-c", src, ...flags, ...extra, "-o", obj], emcc.env);
      if (code !== 0) failures.push(`${relative(work, src)}\n${output}`);
    }
  };
  await Promise.all(Array.from({ length: availableParallelism() }, worker));
  if (failures.length) {
    console.error(failures.slice(0, 40).join("\n"));
    console.error(`${failures.length} sources failed`);
    process.exit(1);
  }
  writeFileSync(stampFile, stamp);
  return jobs.map((j) => j.obj);
}

function run(cmd, argv, env) {
  return new Promise((done) => {
    const child = spawnProgram(cmd, argv, { env });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => done({ code, output }));
  });
}

// git, found on PATH (programs.mjs); the build stops with one line when it is not there.
function git(args, options) {
  try {
    return execProgram("git", args, options);
  } catch (error) {
    if (!(error instanceof ProgramNotFound)) throw error;
    console.error(`Cannot run git: ${error.message}.`);
    process.exit(1);
  }
}

// The full id: how far git shortens one depends on the clone.
function rev(dir) {
  return git(["-C", dir, "rev-parse", "HEAD"]).toString().trim();
}

function installedEmscripten() {
  try {
    return emscriptenVersion(execProgram(emcc.cmd, [...emcc.prefix, "--version"], { env: emcc.env, stdio: ["ignore", "pipe", "pipe"] }).toString());
  } catch {
    console.error(`Cannot run the Emscripten compiler (${[emcc.cmd, ...emcc.prefix].join(" ")}). Install emsdk and pass --emsdk <path>, or set EMSDK.`);
    process.exit(1);
  }
}

// emsdk's emcc.py run by Python, or emcc on PATH. On Windows that is emcc.exe, Emscripten's launcher, or emcc.bat of
// older versions; programs.mjs finds either and starts a batch file through cmd.exe.
function findEmcc() {
  const local = join(emsdk, "upstream", "emscripten", "emcc.py");
  const [name, prefix, env] = existsSync(local)
    ? [process.platform === "win32" ? "python" : "python3", [local], { ...process.env, EMSDK: emsdk, EM_CONFIG: join(emsdk, ".emscripten") }]
    : ["emcc", [], process.env];
  try {
    return { cmd: findProgram(name, { env }), prefix, env };
  } catch (error) {
    if (!(error instanceof ProgramNotFound)) throw error;
    console.error(`Cannot run the Emscripten compiler (${[name, ...prefix].join(" ")}: ${error.message}). Install emsdk and pass --emsdk <path>, or set EMSDK.`);
    process.exit(1);
  }
}
