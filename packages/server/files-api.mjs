// The parts of the bar's API that work on its /ext file system, as the firmware answers them:
//   /api/storage/*      web_server/http_api/api_storage.c
//   /api/assets/upload  web_server/http_api/api_assets.c
//   /api/log_dump       web_server/http_api/api_log.c
// The same paths, checks, status codes and texts. The files are the emulator's data folder (device.mjs).
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmdirSync, rmSync, statSync, statfsSync, truncateSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const json = (status, value) => ({ status, headers: [["Content-Type", "application/json"]], body: new TextEncoder().encode(JSON.stringify(value) + "\n") });
const ok = () => json(200, { result: "OK" });
const badRequest = () => json(400, { error: "Bad Request" });

const FILE_PATH_LEN_MAX = 256;

/** mongoose's mg_path_is_sane(): no "~" at the start and no part that starts with "..". */
function sane(path) {
  return !path.startsWith("~") && !path.startsWith("..") && !/[/\\]\.\./.test(path);
}

/**
 * api_storage_parse_path_parameter(): the query's parameter as a path on /ext, without a trailing slash; null if it
 * is missing, empty, too long, not sane or not on /ext.
 */
function pathParameter(query, name) {
  let path = query.get(name);
  if (!path || Buffer.byteLength(path) >= FILE_PATH_LEN_MAX) return null;
  if (path.endsWith("/")) path = path.slice(0, -1);
  return sane(path) && path.startsWith("/ext") ? path : null;
}

// The files that uploads have open for writing right now, by fileKey. The bar's file system does not tell letter
// cases apart (Twin.js and twin.js are one file, checked on a bar), so neither does the key.
const openForWriting = new Set();
const fileKey = (local) => local.toLowerCase();

/**
 * POST /api/storage/write and /api/assets/upload (web_server.c's http_upload_start and the data callbacks after it):
 * the file is opened when the headers have come, and the body goes into it as it comes. Returns { answer } if the file
 * cannot be opened (508, which the bar too answers from the headers), or the upload:
 *   write(bytes)  null, or the answer if the bytes could not be written (the upload is then over and undone)
 *   finish()      the body has come to its end: the answer
 *   abort()       the body will not come to its end: the client went away, went quiet, or the server stops
 * Unlike the bar, an upload that does not come to its end leaves nothing behind: the file it was writing is removed,
 * one it was appending to is cut back to its length before, and the folders it made are removed if they are empty.
 * The bar keeps what it has written (http_upload_close_callback only closes the file). As on the bar, a file that is
 * written anew rather than appended to is gone from the start, and a file that an upload has open cannot be opened by
 * another one until the first is over: that is refused too.
 */
export function openUpload(device, path, append) {
  const local = device.local(path);
  const cannotOpen = { answer: json(508, { error: "Failed to open file for writing" }) };
  // http_upload_start makes the folder and opens the file; a folder in the file's place cannot be opened, nor a file
  // that is open for writing already (storage_processing.c: storage_path_already_open, FSE_ALREADY_OPEN).
  if (!local || (existsSync(local) && statSync(local).isDirectory()) || openForWriting.has(fileKey(local))) return cannotOpen;
  let fd;
  // The folders on the way to the file that are not there yet, the deepest first. (Not what mkdirSync returns: on
  // Windows that is the path in its long form, \\?\C:\...)
  const made = [];
  for (let folder = dirname(local); !existsSync(folder) && dirname(folder) !== folder; folder = dirname(folder)) made.push(folder);
  let before = null; // the length of the file appended to, if there was one
  try {
    mkdirSync(dirname(local), { recursive: true });
    if (append && existsSync(local)) before = statSync(local).size;
    fd = openSync(local, append ? "a" : "w");
  } catch {
    return cannotOpen;
  }
  openForWriting.add(fileKey(local));
  const close = () => {
    if (fd === null) return false;
    try {
      closeSync(fd);
    } catch {}
    fd = null;
    openForWriting.delete(fileKey(local));
    return true;
  };
  const undo = () => {
    if (!close()) return;
    try {
      if (before === null) rmSync(local, { force: true });
      else truncateSync(local, before);
      // The folders this upload made, from the deepest up, as long as nothing else has come into them.
      for (const folder of made) rmdirSync(folder);
    } catch {
      // A folder that is not empty, or a file in use elsewhere (Windows): left as it is.
    }
  };
  return {
    write(bytes) {
      if (fd === null) return null;
      try {
        for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
        return null;
      } catch {
        undo();
        return json(508, { error: "Failed to write file chunk" });
      }
    },
    finish() {
      return close() ? ok() : json(508, { error: "Failed to write file chunk" });
    },
    abort: undo,
  };
}

/** The same with the whole body at once. */
function upload(device, path, body, append) {
  const file = openUpload(device, path, append);
  if (file.answer) return file.answer;
  return file.write(body ?? new Uint8Array()) ?? file.finish();
}

/**
 * Where the body of POST /api/storage/write or /api/assets/upload (`route`) goes, from the query alone, as the bar's
 * on_headers callbacks find it (api_storage_write_headers_callback, api_assets_upload_headers_callback): { path,
 * append }, or null for a query they answer 400.
 */
export function uploadTarget(route, query) {
  if (route === "storage/write") {
    const path = pathParameter(query, "path");
    // api_storage_parse_append_parameter(): "0" or "1" if it is there at all.
    const append = query.get("append");
    if (!path || (append !== null && append !== "0" && append !== "1")) return null;
    return { path, append: append === "1" };
  }
  const path = assetsFile(query);
  return path ? { path, append: false } : null;
}

/** /api/storage/<what>. Returns the response, or null if the path is not the storage API's. */
export function storageApi(device, method, what, query, body) {
  // The methods each handler takes, as its HttpHandler says; anything else is 405 with them.
  const methods = { write: "POST", read: "GET", remove: "DELETE", mkdir: "POST", rename: "POST", list: "GET", status: "GET" };
  if (!(what in methods)) return null;
  if (method !== methods[what]) {
    return { status: 405, headers: [["Content-Type", "application/json"], ["Allow", methods[what]]], body: new TextEncoder().encode('{"error":"Method Not Allowed"}\n') };
  }

  switch (what) {
    case "write": {
      const target = uploadTarget("storage/write", query);
      return target ? upload(device, target.path, body, target.append) : badRequest();
    }
    case "read": {
      const path = pathParameter(query, "path");
      const data = path && device.readFile(path);
      if (!data) return badRequest();
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (/["\r\n]/.test(name)) return badRequest();
      return { status: 200, headers: [["Content-Type", "application/octet-stream"], ["Content-Disposition", `attachment; filename="${name}"`]], body: data };
    }
    case "remove": {
      // storage_simply_remove_recursive(): what is not there is removed too.
      const path = pathParameter(query, "path");
      if (!path || !device.local(path)) return badRequest();
      device.removePath(path);
      return ok();
    }
    case "mkdir": {
      // storage_simply_mkpath(): every folder on the way; one that is already there is fine.
      const local = device.local(pathParameter(query, "path") ?? "");
      if (!local || (existsSync(local) && !statSync(local).isDirectory())) return badRequest();
      mkdirSync(local, { recursive: true });
      return ok();
    }
    case "rename": {
      const from = device.local(pathParameter(query, "path") ?? "");
      const to = device.local(pathParameter(query, "new_path") ?? "");
      if (!from || !to || !existsSync(from)) return badRequest();
      try {
        // storage_common_rename() replaces what has the new name.
        if (existsSync(to) && to !== from) rmSync(to, { recursive: true, force: true });
        mkdirSync(dirname(to), { recursive: true });
        renameSync(from, to);
      } catch {
        return badRequest();
      }
      return ok();
    }
    case "list": {
      const path = pathParameter(query, "path");
      const local = path && device.local(path);
      const entries = path && device.listDir(path);
      if (!entries) return badRequest();
      const list = entries.map((e) => (e.dir ? { type: "dir", name: e.name } : { type: "file", name: e.name, size: statSync(join(local, e.name)).size }));
      return json(200, { list });
    }
    case "status": {
      // The bar reports its flash; the emulator, the disk its data folder is on.
      const fs = statfsSync(device.local("/ext"));
      const total = fs.blocks * fs.bsize;
      const free = fs.bavail * fs.bsize;
      return json(200, { used_bytes: total - free, free_bytes: free, total_bytes: total });
    }
  }
  return null;
}

// api_assets.c: an app's name is 1..31 letters, digits and "._-"; a file's is 1..64 of those and "/", with no slash at
// either end, no two slashes and no two dots in a row.
function assetsDirectory(query) {
  const app = query.get("application_name");
  if (!app || app.length >= 32 || !/^[A-Za-z0-9._-]+$/.test(app)) return null;
  return `/ext/user_assets/${app}`;
}

function assetsFile(query) {
  const directory = assetsDirectory(query);
  const file = query.get("file");
  if (!directory || !file || file.length > 64 || !/^[A-Za-z0-9._\-/]+$/.test(file)) return null;
  if (file.startsWith("/") || file.endsWith("/") || file.includes("//") || file.includes("..")) return null;
  return `${directory}/${file}`;
}

/** POST and DELETE /api/assets/upload: a file for an app's folder on /ext/user_assets, and the folder's removal. */
export function assetsApi(device, method, query, body) {
  if (method === "POST") {
    const target = uploadTarget("assets/upload", query);
    return target ? upload(device, target.path, body, false) : badRequest();
  }
  if (method === "DELETE") {
    const directory = assetsDirectory(query);
    if (!directory) return badRequest();
    device.removePath(directory);
    return ok();
  }
  return { status: 405, headers: [["Content-Type", "application/json"], ["Allow", "POST, DELETE"]], body: new TextEncoder().encode('{"error":"Method Not Allowed"}\n') };
}

/**
 * POST /api/log_dump[?filename=name]: the device's log into /ext/log.txt, or /ext/<name>.txt for a name of letters,
 * digits, "_" and "-". The emulator's log is what its console shows.
 */
export function logDump(device, query) {
  const name = query.get("filename");
  if (name !== null && (name === "" || name.length >= 64 || !/^[A-Za-z0-9_-]+$/.test(name))) return badRequest();
  const path = name === null ? "/ext/log.txt" : `/ext/${name}.txt`;
  const text = device.logLines.map((l) => `${new Date(l.time).toISOString()} [${l.kind}] ${l.text}\n`).join("");
  if (!device.writeFile(path, new TextEncoder().encode(text))) return json(508, { error: "Failed to dump logs." });
  return json(200, { result: "OK", path });
}
