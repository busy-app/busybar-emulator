// /api/access and /api/access/tokens, as the firmware's api_root.c and its api_tokens service answer them: who may
// use the HTTP API over Wi-Fi, and the tokens given out for it. The emulator listens on this computer only, which
// is the bar's USB side, where the API is always open; so the mode, the key and the tokens are kept and reported,
// and nothing is refused because of them.
import { randomBytes } from "node:crypto";

const json = (status, value, pretty = false) => ({
  status,
  headers: [["Content-Type", "application/json"]],
  body: new TextEncoder().encode((pretty ? JSON.stringify(value, null, "\t") : JSON.stringify(value)) + "\n"),
});
const ok = () => json(200, { result: "OK" });
const badRequest = () => json(400, { error: "Bad Request" });
const methodNotAllowed = (allow) => ({ status: 405, headers: [["Content-Type", "application/json"], ["Allow", allow]], body: new TextEncoder().encode('{"error":"Method Not Allowed"}\n') });

// validate_access_key(): 4 to 10 digits.
const validKey = (key) => /^\d{4,10}$/.test(key);

export class Access {
  constructor() {
    this.mode = "enabled"; // disabled, enabled or key
    this.key = "0000";
    this.tokens = []; // { token, short_id, display_id, name, created_at, last_used_at }
  }

  /** Returns the response, or null if `path` (what follows /api/) is not this API's. */
  request(method, path, query, bodyText, now) {
    if (path === "access") {
      if (method === "GET") return json(200, { mode: this.mode, key_valid: validKey(this.key) });
      if (method === "POST") return this.setMode(query);
      return methodNotAllowed("GET, POST");
    }
    if (!path.startsWith("access/tokens")) return null;
    // What follows the last slash names one token; nothing there means all of them.
    const id = path.slice(path.lastIndexOf("/") + 1);
    const one = path !== "access/tokens" && id !== "";
    if (method === "GET") {
      if (path !== "access/tokens") return json(404, { error: "Not Found" });
      return json(200, { tokens: this.tokens.map((t) => this.entry(t, false)) }, true);
    }
    if (method === "POST") {
      if (path !== "access/tokens") return json(404, { error: "Not Found" });
      let name;
      try {
        name = JSON.parse(bodyText).name;
      } catch {
        name = undefined;
      }
      if (typeof name !== "string") return badRequest();
      // 32 characters of base64; the first 8 are the short id, shown as "<first 8>…<last 6>".
      const token = randomBytes(24).toString("base64url");
      const entry = { token, short_id: token.slice(0, 8), display_id: `${token.slice(0, 8)}…${token.slice(-6)}`, name, created_at: Math.round(now), last_used_at: 0 };
      this.tokens.push(entry);
      return json(200, this.entry(entry, true), true);
    }
    if (method === "DELETE") {
      if (!one) {
        this.tokens = [];
        return ok();
      }
      const i = this.tokens.findIndex((t) => t.short_id === id);
      if (i < 0) return json(404, { error: "Not Found" });
      this.tokens.splice(i, 1);
      return ok();
    }
    return methodNotAllowed("GET, POST, DELETE");
  }

  // http_api_access_set_callback(): ?mode=disabled|enabled|key, and key=<digits>, required for the "key" mode.
  setMode(query) {
    const mode = query.get("mode");
    const key = query.get("key");
    if (!mode || !["disabled", "enabled", "key"].includes(mode)) return badRequest();
    if (mode === "key" && !key) return badRequest();
    if (key) {
      if (!validKey(key)) return badRequest();
      this.key = key;
    }
    this.mode = mode;
    return ok();
  }

  // api_access_tokens_entry_to_json(): the times are strings of Unix ms; the token itself only when it is minted.
  entry(t, full) {
    return { short_id: t.short_id, display_id: t.display_id, name: t.name, created_at: String(t.created_at), last_used_at: String(t.last_used_at), ...(full ? { token: t.token } : {}) };
  }
}
