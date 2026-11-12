// What the tests of the project's tools share: a person's environment without a Node of their own.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const windows = process.platform === "win32";

/**
 * A folder with a node, npm and npx that fail and leave a mark (`mark`): whatever ran one of them is not the bundled
 * Node. Put first on PATH, it stands for the Node a person may have installed, which must never be used.
 */
export function poisonedFolder(parent) {
  const dir = path.join(parent, "poison");
  mkdirSync(dir, { recursive: true });
  const mark = path.join(dir, "ran");
  for (const name of ["node", "npm", "npx"]) {
    if (windows) writeFileSync(path.join(dir, `${name}.cmd`), `@echo poison>>"${mark}"\r\n@exit /b 97\r\n`);
    else {
      writeFileSync(path.join(dir, name), `#!/bin/sh\necho poison >> '${mark}'\nexit 97\n`);
      chmodSync(path.join(dir, name), 0o755);
    }
  }
  return { dir, mark };
}

/**
 * The environment of a person without a Node: a home of the test's (npm reads its .npmrc from there; nothing may be
 * written there), the system's folders on PATH behind the poisoned one, and on Windows the system's own variables.
 */
export function personEnvironment(home, poison, env = process.env) {
  const systemRoot = env.SystemRoot || "C:\\Windows";
  const system = windows ? [path.join(systemRoot, "System32"), systemRoot, path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")] : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const kept = windows ? Object.fromEntries(Object.entries(env).filter(([name]) => /^(systemroot|systemdrive|windir|comspec|pathext|temp|tmp|os|processor_architecture|number_of_processors|programdata)$/i.test(name))) : { TMPDIR: env.TMPDIR };
  return {
    ...kept,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    PATH: [poison.dir, ...system].join(path.delimiter),
  };
}

/** Whether a process of this id is there. */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
export async function gone(pid, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) if (!alive(pid)) return true;
  return !alive(pid);
}

/**
 * A tool that hangs, with a grandchild that hangs too and holds the tool's output pipes (as a bundler's worker or an
 * npm script does): it writes both their process ids to `pids` and never ends by itself. Returns its script.
 */
export function hangingTool(folder, pids) {
  const script = path.join(folder, `hang-${path.basename(pids, ".json")}.mjs`);
  const programs = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "engine", "programs.mjs")).href;
  writeFileSync(
    script,
    [
      `import { spawnProgram } from ${JSON.stringify(programs)};`,
      "import { writeFileSync } from 'node:fs';",
      "const grandchild = spawnProgram(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
      `writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));`,
      "console.log('hanging');",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  return script;
}
export async function pidsIn(file) {
  for (let n = 0; n < 200; n++) {
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        // half written
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the hanging tool never started");
}
