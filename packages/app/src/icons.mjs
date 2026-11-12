// The icons of the bar's local web, answered inside the app (EMU-209).
//
// The firmware's local web takes its Lucide icons from Iconify's API while the page runs: api.iconify.design, and
// when that does not answer, api.simplesvg.com and api.unisvg.com. A window of the app reaches the server's address
// and nothing else (ADR-0016), so the app carries those icons (icons/lucide.json, made by tools/local-web-icons.mjs)
// and answers the page's requests for them itself, in the format the API answers in. No request is passed on: what
// this file does not answer is refused, and the proxy of the session, which sends every other address nowhere, is
// left as it is.
import { readFileSync } from "node:fs";

/** The hosts the Iconify client in the local web asks, in its order. */
export const ICON_HOSTS = Object.freeze(["api.iconify.design", "api.simplesvg.com", "api.unisvg.com"]);

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ICONS = 200;

/**
 * What a request to Iconify's API asks for: { prefix, names } for "https://<an Iconify host>/<prefix>.json?icons=a,b",
 * null for anything else — another host, port or scheme, another path, names that are not icon names.
 */
export function iconRequest(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password || !ICON_HOSTS.includes(url.hostname)) return null;
  const prefix = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/.exec(url.pathname)?.[1];
  const names = (url.searchParams.get("icons") ?? "").split(",");
  if (!prefix || names.length > MAX_ICONS || !names.every((name) => NAME.test(name))) return null;
  return { prefix, names };
}

/** The API's answer for these names from a set: the icons it has, and "not_found" for the rest. */
export function iconAnswer(set, names) {
  const answer = { prefix: set.prefix, lastModified: set.lastModified, icons: {}, width: set.width, height: set.height };
  const missing = [];
  const take = (name, depth = 0) => {
    if (Object.hasOwn(set.icons, name)) answer.icons[name] = set.icons[name];
    else if (Object.hasOwn(set.aliases ?? {}, name) && depth < 5) {
      (answer.aliases ??= {})[name] = set.aliases[name];
      take(set.aliases[name].parent, depth + 1);
    } else if (depth === 0) missing.push(name);
  };
  for (const name of names) take(name);
  if (missing.length) answer.not_found = missing;
  return answer;
}

/** True for the addresses the handler below answers: the rule on requests lets exactly these through to it. */
export const isIconRequest = (address) => iconRequest(address) !== null;

// Any page may read the answer, as with the API itself: the page asks from another origin.
const HEADERS = Object.freeze({ "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" });

/**
 * The handler of https: in the local web's session (session.protocol.handle): { status, headers, body } for a request.
 * It answers Iconify's API from the app's own file and refuses everything else; it never asks the network.
 * @param {string} file  icons/lucide.json
 */
export function createIconAnswers(file) {
  let set = null;
  return ({ method, url }) => {
    const asked = iconRequest(url);
    if (!asked || (method !== "GET" && method !== "HEAD")) return { status: 403, headers: { "content-type": "text/plain" }, body: "Not an address this window reaches." };
    set ??= JSON.parse(readFileSync(file, "utf8"));
    // The API answers 404 for a set it does not have; the app has one set.
    if (asked.prefix !== set.prefix) return { status: 404, headers: { ...HEADERS, "content-type": "text/plain" }, body: "404" };
    return { status: 200, headers: { ...HEADERS }, body: JSON.stringify(iconAnswer(set, asked.names)) };
  };
}
