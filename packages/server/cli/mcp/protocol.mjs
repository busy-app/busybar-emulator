// The Model Context Protocol, the part this server needs: JSON-RPC 2.0 messages, one per line (the stdio transport),
// tools and resources. Written here, without the SDK: the command line runs on the Node inside the app, with no
// node_modules of its own (ADR-0010, EMU-202).
//
// Both eras of the protocol (https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning):
//
// - legacy, with the `initialize` handshake: 2025-11-25, which this server prefers, and 2025-06-18, 2025-03-26 and
//   2024-11-05, the version the client asks for when it is one of these. The clients of 11.11.2026 (Claude Desktop,
//   Claude Code, Cursor) open this way.
// - modern, 2026-07-28: every request names its version in `_meta["io.modelcontextprotocol/protocolVersion"]`, there
//   is no handshake, `server/discover` says what the server is, and every result says `resultType: "complete"`.
//
// The session is transport-free: `receive(line)` takes one line of the client's, `send(message)` is given every
// message to write. Nothing here writes to stdout or reads files.

export const LEGACY_VERSIONS = Object.freeze(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
export const MODERN_VERSIONS = Object.freeze(["2026-07-28"]);
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

/** The codes of JSON-RPC and of MCP this server answers with. */
export const ERRORS = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  resourceNotFound: -32002,
  unsupportedVersion: -32022,
});

export class RpcError extends Error {
  constructor(code, message, data = undefined) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (id) => typeof id === "string" || (typeof id === "number" && Number.isFinite(id));

/**
 * One session of a client: a process of `busy-emulator mcp`, from its start until its stdin ends.
 * @param {object} o
 * @param {{ name: string, title: string, version: string }} o.server
 * @param {string} o.instructions          for the model: how to use the tools
 * @param {() => object[]} o.tools          the tools' definitions (name, title, description, inputSchema, annotations)
 * @param {(name: string, args: object, o: { signal: AbortSignal }) => Promise<object>} o.callTool  a CallToolResult:
 *   content, structuredContent, isError; `signal` aborts when the client cancels the request (the tool is then
 *   stopped, its programs with it, and its answer dropped)
 * @param {() => object[]} o.resources
 * @param {(uri: string) => object|null} o.readResource  { uri, mimeType, text }, or null for none
 * @param {(message: object) => void} o.send
 * @param {(line: string) => void} [o.log]  to stderr
 */
export function createSession({ server, instructions, tools, callTool, resources, readResource, send, log = () => {} }) {
  let initialized = null; // the legacy version agreed in `initialize`
  const canceled = new Set();
  const pending = new Set();
  const controllers = new Map(); // request id → the AbortController of its tools/call

  const capabilities = { tools: { listChanged: false }, resources: { listChanged: false } };
  const reply = (id, result) => {
    if (canceled.delete(id)) return; // a canceled request gets no answer (the specification's MUST NOT)
    send({ jsonrpc: "2.0", id, result });
  };
  const fail = (id, error) => {
    if (id !== null && canceled.delete(id)) return;
    send({ jsonrpc: "2.0", id, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } });
  };

  /** The answer to one request; `modern` when the request named its version in `_meta`. */
  async function answer(method, params, modern, id) {
    const done = (result) => (modern ? { resultType: "complete", ...result } : result);
    switch (method) {
      case "initialize": {
        if (!isObject(params) || typeof params.protocolVersion !== "string") throw new RpcError(ERRORS.invalidParams, "initialize needs params.protocolVersion, a string.");
        initialized = LEGACY_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : LEGACY_VERSIONS[0];
        log(`initialize: the client ${JSON.stringify(params.clientInfo?.name ?? "?")} asked for ${params.protocolVersion}, answered ${initialized}`);
        return { protocolVersion: initialized, capabilities, serverInfo: server, instructions };
      }
      case "server/discover":
        return { resultType: "complete", supportedVersions: [...MODERN_VERSIONS], capabilities, _meta: { "io.modelcontextprotocol/serverInfo": server }, instructions };
      case "ping":
        return done({});
      case "tools/list":
        return done({ tools: tools() });
      case "tools/call": {
        if (!isObject(params) || typeof params.name !== "string") throw new RpcError(ERRORS.invalidParams, "tools/call needs params.name, the tool's name.");
        if (params.arguments !== undefined && !isObject(params.arguments)) throw new RpcError(ERRORS.invalidParams, "params.arguments of tools/call must be an object.");
        if (!tools().some((tool) => tool.name === params.name)) throw new RpcError(ERRORS.invalidParams, `Unknown tool: ${params.name}`);
        const controller = new AbortController();
        controllers.set(id, controller);
        try {
          // What a long tool says while it works (publish push: the upload), as progress notifications, when the
          // client asked for them with a progress token.
          const token = params._meta?.progressToken;
          let step = 0;
          const progress = typeof token === "string" || Number.isInteger(token) ? (message) => send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++step, message: String(message).slice(0, 500) } }) : null;
          return done(await callTool(params.name, params.arguments ?? {}, { signal: controller.signal, ...(progress ? { progress } : {}) }));
        } finally {
          controllers.delete(id);
        }
      }
      case "resources/list":
        return done({ resources: resources() });
      case "resources/templates/list":
        return done({ resourceTemplates: [] });
      case "resources/read": {
        if (!isObject(params) || typeof params.uri !== "string") throw new RpcError(ERRORS.invalidParams, "resources/read needs params.uri, a string.");
        const content = readResource(params.uri);
        if (!content) throw new RpcError(ERRORS.resourceNotFound, "Resource not found", { uri: params.uri });
        return done({ contents: [content] });
      }
      default:
        throw new RpcError(ERRORS.methodNotFound, `Method not found: ${method}`);
    }
  }

  function notification(method, params) {
    if (method === "notifications/cancelled" && isObject(params) && validId(params.requestId)) {
      // Only a request that is still being worked on: its answer is then dropped, and a tool that runs is stopped.
      if (pending.has(params.requestId)) {
        canceled.add(params.requestId);
        controllers.get(params.requestId)?.abort("canceled");
      }
    }
    // notifications/initialized and every other notification need nothing; a notification is never answered.
  }

  /** One message of the client's: a request, a notification, or (never expected) a response. */
  function message(value) {
    if (!isObject(value)) return fail(null, new RpcError(ERRORS.invalidRequest, Array.isArray(value) ? "Invalid Request: batches are not taken, send one message per line." : "Invalid Request: a message is a JSON object."));
    const id = Object.hasOwn(value, "id") ? value.id : undefined;
    if (value.jsonrpc !== "2.0") return fail(validId(id) ? id : null, new RpcError(ERRORS.invalidRequest, 'Invalid Request: "jsonrpc" must be "2.0".'));
    if (typeof value.method !== "string") {
      // A response to a request of ours: this server sends none, so it is dropped.
      if (Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) return undefined;
      return fail(validId(id) ? id : null, new RpcError(ERRORS.invalidRequest, 'Invalid Request: "method" must be a string.'));
    }
    if (id === undefined) return notification(value.method, value.params);
    if (!validId(id)) return fail(null, new RpcError(ERRORS.invalidRequest, 'Invalid Request: "id" must be a string or a number.'));
    if (value.params !== undefined && !isObject(value.params)) return fail(id, new RpcError(ERRORS.invalidParams, '"params" must be an object.'));

    const requested = value.params?._meta?.[VERSION_KEY];
    const modern = requested !== undefined;
    if (modern && !MODERN_VERSIONS.includes(requested)) {
      return fail(id, new RpcError(ERRORS.unsupportedVersion, "Unsupported protocol version", { supported: [...MODERN_VERSIONS], requested }));
    }
    if (!modern && initialized === null && !["initialize", "ping", "server/discover"].includes(value.method)) {
      return fail(id, new RpcError(ERRORS.invalidRequest, `Send initialize first (protocol ${LEGACY_VERSIONS.join(", ")}), or name the version in params._meta["${VERSION_KEY}"] (${MODERN_VERSIONS.join(", ")}).`));
    }
    pending.add(id);
    const work = answer(value.method, value.params, modern, id).then(
      (result) => reply(id, result),
      (e) => {
        if (e instanceof RpcError) return fail(id, e);
        log(`${value.method} failed: ${e?.stack ?? e}`);
        return fail(id, new RpcError(ERRORS.internal, `Internal error: ${e?.message ?? e}`));
      },
    );
    const tracked = work.finally(() => {
      pending.delete(id);
      canceled.delete(id);
      inFlight.delete(tracked);
    });
    inFlight.add(tracked);
    return undefined;
  }
  const inFlight = new Set();

  return {
    /** One line of the client's input. */
    receive(line) {
      const text = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!text.trim()) return;
      let value;
      try {
        value = JSON.parse(text);
      } catch (e) {
        fail(null, new RpcError(ERRORS.parse, `Parse error: ${e.message}`));
        return;
      }
      message(value);
    },
    /** Resolves when every request taken so far has been answered. */
    async settled() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
    get version() {
      return initialized;
    },
  };
}
