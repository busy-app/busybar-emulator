// GitHub's REST API for Publish stage 2: the person's public repository, one commit of the project's files, a fork
// of the apps catalog and a pull request to it.
//
// Every request goes through GitHub CLI (gh.mjs ghTransport: `gh api <path> --method <M> --include`, JSON on its
// standard input): gh holds the token and sends it, this module never sees one. gh's answer, status line and headers
// included, is read here as GitHub gave it, so the rules below are the same as for a request of the app's own.
//
// No git and no git program: the files go up through the Git Data API — a blob for each file, a tree, a commit, the
// branch moved to it — and the branch is read back afterwards, so that "done" is never said of a push that did not
// land (Glitch and v0 are the examples of what not to do). A new repository is made with auto_init: the Git Data API
// answers 409 on an empty one. The pull request is opened from the person's own fork with maintainer_can_modify, so
// the catalog's maintainers can fix it.
//
// GitHub's limits (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api): 5000 requests an
// hour for a token; at most 80 requests that create content a minute and 500 an hour; between two of them at least a
// second, GitHub asks. So every request that writes waits a second after the one before, a push refuses more than
// MAX_FILES files, and the store of what was written in the last hour refuses the 501st. An answer that says the limit
// is reached (403 or 429 with x-ratelimit-remaining: 0, retry-after, or the "secondary rate limit" text) is waited out
// when the wait is short, and is a GithubApiError "rate_limited" with the time to try again when it is not.
//
// Nothing here runs on its own: the caller (publish-flow.mjs) gives the transport and calls.
import { createHash } from "node:crypto";

/** Between two requests that write, as GitHub asks. */
export const WRITE_GAP_MS = 1000;
/** GitHub's limit of requests that create content in an hour. */
export const WRITES_PER_HOUR = 500;
/** A push makes a blob for each changed file, a tree, a commit and a move of the branch: well under the hour's limit. */
export const MAX_FILES = 400;
/** The longest wait for a limit that is waited out; a longer one is the caller's to tell the person. */
export const MAX_WAIT_MS = 90_000;
const RETRIES = 3;
/** The first wait before a request GitHub failed (5xx) is asked again; it doubles each time. */
export const SERVER_RETRY_MS = 2000;

/** Whether a request may be sent again after GitHub's own failure without doing anything twice. */
export function sameIfRepeated(method, path) {
  if (method === "GET" || method === "PATCH") return true;
  return method === "POST" && /^\/repos\/[^/]+\/[^/]+\/(git\/(blobs|trees|commits)|forks)$/.test(path);
}
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * What went wrong, for the window's text and for what to do next. `code`:
 *   unauthorized   401, or gh has no token: the sign-in is gone (revoked, expired) — sign in again
 *   forbidden      403 that is not a limit: no right to it (a missing scope names itself in `details.accepted`)
 *   not_found      404
 *   conflict       409 (an empty repository, a branch moved meanwhile)
 *   name_taken     422 on a new repository: the person has one of that name
 *   unprocessable  422 of another kind (`details.errors`)
 *   rate_limited   a limit, with `retryAt` (ms since the epoch)
 *   too_many_files a push larger than MAX_FILES files
 *   not_landed     after a push the branch is not at the new commit, or its files are not the ones sent
 *   moved          a redirect gh did not follow
 *   fork_pending   the fork was not ready within the wait
 *   bad_path       a file's path that is not a plain relative path
 *   catalog_closed the catalog cannot be seen (private, or not there yet)
 *   fork_not_allowed  the catalog may not be forked
 *   catalog_empty  the catalog has no commit yet
 *   network        GitHub could not be reached (gh said so, or did not answer in time)
 *   canceled      the person stopped it (a push's Cancel)
 *   no_account     GitHub CLI has no sign-in for the account the calls go as (signed out of it elsewhere)
 *   server, bad_answer
 */
export class GithubApiError extends Error {
  constructor(code, message, { status = null, retryAt = null, details = null } = {}) {
    super(message);
    this.name = "GithubApiError";
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
    this.details = details;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The id git gives the content of a file: SHA-1 of "blob <size>\0" and the bytes. GitHub's blob sha is the same. */
export function blobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** A path in a repository: relative, with forward slashes, no empty, "." or ".." part, nothing inside .git. */
export function checkRepoPath(file) {
  const parts = String(file ?? "").split("/");
  const plain = file && file.length <= 4096 && !file.includes("\\") && !file.includes("\0") && parts.every((part) => part && part !== "." && part !== "..") && parts[0].toLowerCase() !== ".git";
  if (!plain) throw new GithubApiError("bad_path", `not a path for a repository: ${JSON.stringify(String(file).slice(0, 200))}`);
  return file;
}

const segment = (value) => encodeURIComponent(String(value));
/** A branch's name in an address: its slashes stay ("bob/app_1.0" is refs/heads/bob/app_1.0). */
const branchPath = (branch) => String(branch).split("/").map(segment).join("/");

/**
 * @param {object} o
 * @param {{ request: (method: string, path: string, body?: object) => Promise<object> }} o.transport  gh.mjs ghTransport
 * @param {() => number} [o.now]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {number} [o.writeGapMs]
 * @param {number} [o.maxWaitMs]
 */
export function createGithubApi({ transport, now = Date.now, sleep = defaultSleep, writeGapMs = WRITE_GAP_MS, maxWaitMs = MAX_WAIT_MS }) {
  if (typeof transport?.request !== "function") throw new TypeError("no transport");
  let lastWrite = -Infinity;
  /** The times of the writes in the last hour. */
  const writes = [];

  async function paceWrite() {
    const hourAgo = now() - 3_600_000;
    while (writes.length && writes[0] <= hourAgo) writes.shift();
    if (writes.length >= WRITES_PER_HOUR) {
      const retryAt = writes[0] + 3_600_000;
      throw new GithubApiError("rate_limited", "GitHub allows 500 writes an hour: this one would be over", { retryAt });
    }
    const wait = lastWrite + writeGapMs - now();
    if (wait > 0) await sleep(wait);
    lastWrite = now();
    writes.push(lastWrite);
  }

  /** How long to wait before a limited request is tried again, in ms; null when the answer is not about a limit. */
  function limitWait(res, body, attempt) {
    if (res.status !== 403 && res.status !== 429) return null;
    const retryAfter = Number(res.headers.get("retry-after"));
    if (res.headers.get("retry-after") !== null && Number.isFinite(retryAfter)) return Math.max(0, retryAfter * 1000);
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      return Number.isFinite(reset) ? Math.max(0, reset * 1000 - now()) + 1000 : 60_000;
    }
    // A secondary limit without headers: at least a minute, longer each time.
    if (res.status === 429 || /secondary rate limit/i.test(String(body?.message ?? ""))) return 60_000 * 2 ** attempt;
    return null;
  }

  function failure(res, body, method, path) {
    const message = `${method} ${path}: ${res.status}${body?.message ? ` ${String(body.message).slice(0, 200)}` : ""}`;
    const status = res.status;
    if (status >= 300 && status < 400) return new GithubApiError("moved", message, { status });
    if (status === 401) return new GithubApiError("unauthorized", message, { status });
    if (status === 403) return new GithubApiError("forbidden", message, { status, details: { accepted: res.headers.get("x-accepted-oauth-scopes"), granted: res.headers.get("x-oauth-scopes") } });
    if (status === 404) return new GithubApiError("not_found", message, { status });
    if (status === 409) return new GithubApiError("conflict", message, { status });
    if (status === 422) {
      const errors = Array.isArray(body?.errors) ? body.errors : [];
      const taken = errors.some((e) => /already exists/i.test(String(e?.message ?? "")) && (e?.field === "name" || !e?.field));
      return new GithubApiError(taken ? "name_taken" : "unprocessable", message, { status, details: { errors } });
    }
    if (status >= 500) return new GithubApiError("server", message, { status });
    return new GithubApiError("bad_answer", message, { status });
  }

  /**
   * One call: JSON in and out. Resolves with the parsed body (null for 204), rejects with a GithubApiError. `signal`
   * stops it (the call under way is ended, none is asked again).
   */
  async function request(method, path, body, { signal = null } = {}) {
    const writing = method !== "GET" && method !== "HEAD";
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new GithubApiError("canceled", `${method} ${path}: stopped`);
      if (writing) await paceWrite();
      let res;
      try {
        res = await transport.request(method, path, body, signal ? { signal } : undefined);
      } catch (e) {
        throw new GithubApiError("network", `${method} ${path}: GitHub could not be reached: ${e.code ?? e.name}`);
      }
      if (res?.failure === "canceled") throw new GithubApiError("canceled", `${method} ${path}: stopped`);
      if (res?.failure === "no_account") throw new GithubApiError("no_account", `${method} ${path}: GitHub CLI has no sign-in for the account: ${String(res.detail ?? "").slice(0, 200)}`);
      if (res?.failure === "auth") throw new GithubApiError("unauthorized", `${method} ${path}: GitHub CLI has no sign-in`, { status: 401 });
      if (res?.failure) throw new GithubApiError("network", `${method} ${path}: GitHub could not be reached: ${String(res.detail ?? res.failure).slice(0, 200)}`);
      const ok = res.status >= 200 && res.status < 300;
      let parsed = null;
      try {
        parsed = res.text ? JSON.parse(res.text) : null;
      } catch {
        if (ok) throw new GithubApiError("bad_answer", `${method} ${path}: the answer is not JSON`, { status: res.status });
      }
      if (ok) return parsed;
      // GitHub's own failure (5xx): asked again a little later, when asking again cannot do a thing twice — a read, a
      // move of a branch to a given commit, a blob, a tree or a commit (named by their content), a fork (GitHub answers
      // with the one there is). A new repository, a branch or a pull request are not: the caller looks what is there.
      if (res.status >= 500 && attempt < RETRIES && sameIfRepeated(method, path)) {
        await sleep(SERVER_RETRY_MS * 2 ** attempt);
        continue;
      }
      const wait = limitWait(res, parsed, attempt);
      if (wait !== null) {
        if (wait <= maxWaitMs && attempt < RETRIES) {
          await sleep(wait);
          continue;
        }
        throw new GithubApiError("rate_limited", `${method} ${path}: GitHub's rate limit`, { status: res.status, retryAt: now() + wait });
      }
      throw failure(res, parsed, method, path);
    }
  }

  /** The body, or null for a 404: for "is it there?". */
  async function orNull(promise) {
    try {
      return await promise;
    } catch (e) {
      if (e.code === "not_found") return null;
      throw e;
    }
  }

  const api = {
    request,

    /** The person gh is signed in as: { login }. */
    async user() {
      const me = await request("GET", "/user");
      if (typeof me?.login !== "string") throw new GithubApiError("bad_answer", "GET /user: no login");
      return { login: me.login };
    },

    /** A repository, or null when there is none of that name (or the token may not see it). */
    repo: (owner, name) => orNull(request("GET", `/repos/${segment(owner)}/${segment(name)}`)),

    /** A new public repository of the person's, with a first commit (auto_init), so that commits can follow. */
    async createRepo({ name, description = "" }) {
      const made = await request("POST", "/user/repos", { name, description, private: false, auto_init: true });
      return { owner: made.owner.login, name: made.name, defaultBranch: made.default_branch, url: made.html_url };
    },

    /** The commit a branch is at, or null when there is no such branch. */
    async branchHead(owner, name, branch, options) {
      const ref = await orNull(request("GET", `/repos/${segment(owner)}/${segment(name)}/git/ref/heads/${branchPath(branch)}`, undefined, options));
      return ref?.object?.sha ?? null;
    },

    commit: (owner, name, sha, options) => request("GET", `/repos/${segment(owner)}/${segment(name)}/git/commits/${segment(sha)}`, undefined, options),

    /** Every file of a tree: [{ path, mode, sha }]. */
    async files(owner, name, treeSha, options) {
      const tree = await request("GET", `/repos/${segment(owner)}/${segment(name)}/git/trees/${segment(treeSha)}?recursive=1`, undefined, options);
      if (tree?.truncated) throw new GithubApiError("bad_answer", "the tree is too large to read back in one answer");
      return (tree?.tree ?? []).filter((one) => one.type === "blob").map(({ path, mode, sha }) => ({ path, mode, sha }));
    },

    async createBlob(owner, name, bytes, options) {
      const made = await request("POST", `/repos/${segment(owner)}/${segment(name)}/git/blobs`, { content: Buffer.from(bytes).toString("base64"), encoding: "base64" }, options);
      return made.sha;
    },

    /**
     * A tree of these entries ({ path, mode, sha }), on top of `baseTree` when one is given. An entry whose sha is null
     * takes that path out of the base tree (GitHub's way to delete a file in a tree).
     */
    async createTree(owner, name, entries, baseTree = null, options) {
      const made = await request(
        "POST",
        `/repos/${segment(owner)}/${segment(name)}/git/trees`,
        {
          ...(baseTree ? { base_tree: baseTree } : {}),
          tree: entries.map(({ path, mode, sha }) => ({ path, mode, type: "blob", sha })),
        },
        options,
      );
      return made.sha;
    },

    /** A file's bytes by its blob sha, checked against it. (catalog-update) */
    async blob(owner, name, sha, options) {
      const got = await request("GET", `/repos/${segment(owner)}/${segment(name)}/git/blobs/${segment(sha)}`, undefined, options);
      if (got?.encoding !== "base64" || typeof got.content !== "string") throw new GithubApiError("bad_answer", `GET blob ${sha}: not base64`);
      const bytes = Buffer.from(got.content, "base64");
      if (blobSha(bytes) !== sha) throw new GithubApiError("bad_answer", `GET blob ${sha}: the bytes are not that blob`);
      return bytes;
    },

    /**
     * How `head` stands to `base` in a repository: { status: "identical" | "ahead" | "behind" | "diverged", ahead,
     * behind } (`ahead`: commits of head that base has not), or null when GitHub does not know one of them. (catalog-update)
     */
    async compare(owner, name, base, head) {
      const got = await orNull(request("GET", `/repos/${segment(owner)}/${segment(name)}/compare/${segment(base)}...${segment(head)}`));
      if (!got) return null;
      if (!["identical", "ahead", "behind", "diverged"].includes(got.status)) throw new GithubApiError("bad_answer", "compare: no status");
      return { status: got.status, ahead: Number(got.ahead_by) || 0, behind: Number(got.behind_by) || 0 };
    },

    async createCommit(owner, name, { message, tree, parents }, options) {
      const made = await request("POST", `/repos/${segment(owner)}/${segment(name)}/git/commits`, { message, tree, parents }, options);
      return made.sha;
    },

    /** Moves a branch forward to `sha` (never by force: a branch moved meanwhile is a conflict). */
    moveBranch: (owner, name, branch, sha) => request("PATCH", `/repos/${segment(owner)}/${segment(name)}/git/refs/heads/${branchPath(branch)}`, { sha, force: false }),

    createBranch: (owner, name, branch, sha) => request("POST", `/repos/${segment(owner)}/${segment(name)}/git/refs`, { ref: `refs/heads/${branch}`, sha }),

    /**
     * One commit with these files on `branch`, read back afterwards.
     *   mode "replace": the branch holds exactly these files (the person's repository mirrors the project)
     *   mode "add":     these files on top of what the branch holds (the manifest in a fork of the catalog)
     * A file whose content GitHub already has at that path is not uploaded again. Resolves with { commit, uploaded },
     * or with { commit: <the head>, uploaded: 0, unchanged: true } when nothing would change.
     *
     * `onProgress` hears where it is: { phase: "compare" | "upload" | "commit" | "check", done, total, bytes,
     * totalBytes, file, known } — `done` of `total` files to upload (`known`: the others, which GitHub has already),
     * `bytes` of `totalBytes` of theirs, `file` the one going up now. `signal` stops it before the branch is moved
     * (GitHub keeps blobs and trees no branch names: the repository's files stay as they were); once the branch is moved,
     * it goes to its end.
     * @param {{ owner: string, name: string, branch: string, files: { path: string, bytes: Uint8Array, executable?: boolean }[], message: string, mode?: "replace" | "add", onProgress?: Function, signal?: AbortSignal }} o
     */
    async pushFiles({ owner, name, branch, files, message, mode = "replace", remove = [], onProgress = () => {}, signal = null }) {
      const tell = (fact) => {
        try {
          onProgress(fact);
        } catch {
          // A listener's failure is not the push's.
        }
      };
      const stoppable = signal ? { signal } : undefined;
      if (!Array.isArray(files) || !files.length) throw new GithubApiError("bad_path", "no files to push");
      if (files.length > MAX_FILES) throw new GithubApiError("too_many_files", `${files.length} files: a push takes at most ${MAX_FILES}`);
      const seen = new Set();
      const wanted = files.map(({ path, bytes, executable = false }) => {
        checkRepoPath(path);
        if (seen.has(path)) throw new GithubApiError("bad_path", `the path ${path} is given twice`);
        seen.add(path);
        if (bytes.length > MAX_FILE_BYTES) throw new GithubApiError("bad_path", `${path} is larger than 50 MB`);
        return { path, bytes, mode: executable ? "100755" : "100644", sha: blobSha(bytes) };
      });
      // mode "add" may take files out as well (`remove`: paths the branch has and the person agreed to delete).
      const removing = mode === "add" ? [...new Set(remove.map((one) => checkRepoPath(one)))].filter((one) => !seen.has(one)) : [];
      tell({ phase: "compare", done: 0, total: wanted.length, bytes: 0, totalBytes: 0, file: null, known: 0 });
      const head = await api.branchHead(owner, name, branch, stoppable);
      if (!head) throw new GithubApiError("conflict", `${owner}/${name} has no branch ${branch}`);
      const parent = await api.commit(owner, name, head, stoppable);
      const before = await api.files(owner, name, parent.tree.sha, stoppable);
      const had = new Map(before.map((one) => [one.path, one]));
      const gone = removing.filter((one) => had.has(one));
      const same = mode === "replace" ? before.length === wanted.length && wanted.every((w) => had.get(w.path)?.sha === w.sha && had.get(w.path)?.mode === w.mode) : !gone.length && wanted.every((w) => had.get(w.path)?.sha === w.sha && had.get(w.path)?.mode === w.mode);
      if (same) return { commit: head, uploaded: 0, unchanged: true };
      // GitHub has these contents already where it has the same sha (any path of the tree): no upload.
      const known = new Set(before.map((one) => one.sha));
      // What goes up: each content once.
      const going = [];
      const seenSha = new Set(known);
      for (const w of wanted) {
        if (seenSha.has(w.sha)) continue;
        seenSha.add(w.sha);
        going.push(w);
      }
      const totalBytes = going.reduce((sum, w) => sum + w.bytes.length, 0);
      const progress = { phase: "upload", done: 0, total: going.length, bytes: 0, totalBytes, file: null, known: wanted.length - going.length };
      tell({ ...progress });
      let uploaded = 0;
      for (const w of going) {
        tell({ ...progress, file: w.path });
        const sha = await api.createBlob(owner, name, w.bytes, stoppable);
        if (sha !== w.sha) throw new GithubApiError("not_landed", `GitHub keeps ${w.path} as ${sha}, not ${w.sha}`);
        uploaded += 1;
        progress.done = uploaded;
        progress.bytes += w.bytes.length;
        tell({ ...progress, file: w.path });
      }
      tell({ ...progress, phase: "commit", file: null });
      const tree = await api.createTree(owner, name, [...wanted, ...gone.map((one) => ({ path: one, mode: had.get(one).mode, sha: null }))], mode === "add" ? parent.tree.sha : null, stoppable);
      const commit = await api.createCommit(owner, name, { message, tree, parents: [head] }, stoppable);
      if (signal?.aborted) throw new GithubApiError("canceled", "stopped before the branch was moved");
      // From here on it goes to its end: the branch moved is the push done.
      await api.moveBranch(owner, name, branch, commit);
      tell({ ...progress, phase: "check", file: null });
      // Read back: the branch is at the commit, and its files are the ones sent.
      const landed = await api.branchHead(owner, name, branch);
      if (landed !== commit) throw new GithubApiError("not_landed", `${branch} is at ${landed}, not at the new commit ${commit}`);
      const after = new Map((await api.files(owner, name, (await api.commit(owner, name, commit)).tree.sha)).map((one) => [one.path, one]));
      const missing = wanted.filter((w) => after.get(w.path)?.sha !== w.sha);
      if (missing.length || (mode === "replace" && after.size !== wanted.length) || gone.some((one) => after.has(one))) {
        throw new GithubApiError("not_landed", `the files on GitHub are not the ones sent (${missing.map((w) => w.path).slice(0, 5).join(", ") || "others are there too"})`);
      }
      return { commit, uploaded, removed: gone.length };
    },

    /** The person's fork of a repository (made if there is none; GitHub answers with the one there is). */
    async fork(owner, name) {
      const made = await request("POST", `/repos/${segment(owner)}/${segment(name)}/forks`, { default_branch_only: true });
      return { owner: made.owner.login, name: made.name, defaultBranch: made.default_branch };
    },

    /** Waits until a fork's default branch can be read: GitHub makes a fork in the background. */
    async waitForFork({ owner, name, defaultBranch }, { tries = 30, gapMs = 2000 } = {}) {
      for (let i = 0; i < tries; i++) {
        try {
          const head = await api.branchHead(owner, name, defaultBranch);
          if (head) return head;
        } catch (e) {
          // An empty fork answers 409 for a moment.
          if (e.code !== "conflict") throw e;
        }
        await sleep(gapMs);
      }
      throw new GithubApiError("fork_pending", `the fork ${owner}/${name} is not ready yet`);
    },

    /** The open pull request from `head` ("user:branch"), or null. */
    async openPull(owner, name, head) {
      const pulls = await request("GET", `/repos/${segment(owner)}/${segment(name)}/pulls?state=open&head=${encodeURIComponent(head)}&per_page=10`);
      const one = Array.isArray(pulls) ? pulls[0] : null;
      return one ? { number: one.number, url: one.html_url } : null;
    },

    /**
     * The person's open pull request to a repository that changes `file`: opened by them, with its head in a repository
     * of theirs (their fork) or in the repository itself. Found by who and what, not by the branch's name.
     * Resolves with { number, url, owner, name, branch } (where its head is), or null.
     */
    async openPullChanging(owner, name, { login, file }) {
      // Opened by the person (anyone may open a request from a branch of their public fork), with its head in their
      // own repository or in the catalog itself.
      const mine = (pull) => {
        const headOwner = String(pull?.head?.repo?.owner?.login ?? "").toLowerCase();
        const inBase = headOwner === owner.toLowerCase() && String(pull?.head?.repo?.name ?? "").toLowerCase() === name.toLowerCase();
        return String(pull?.user?.login ?? "").toLowerCase() === login.toLowerCase() && (headOwner === login.toLowerCase() || inBase);
      };
      for (let page = 1; page <= 5; page++) {
        const pulls = await request("GET", `/repos/${segment(owner)}/${segment(name)}/pulls?state=open&per_page=100&page=${page}`);
        if (!Array.isArray(pulls) || !pulls.length) break;
        for (const pull of pulls.filter(mine)) {
          const files = await request("GET", `/repos/${segment(owner)}/${segment(name)}/pulls/${segment(pull.number)}/files?per_page=100`);
          if (Array.isArray(files) && files.some((one) => one?.filename === file && one?.status !== "removed")) {
            return { number: pull.number, url: pull.html_url, owner: pull.head.repo.owner.login, name: pull.head.repo.name, branch: pull.head.ref };
          }
        }
        if (pulls.length < 100) break;
      }
      return null;
    },

    updatePull: (owner, name, number, { title, body }) => request("PATCH", `/repos/${segment(owner)}/${segment(name)}/pulls/${segment(number)}`, { title, body }),

    /** A pull request from the person's fork, which the base repository's maintainers may change. */
    async createPull(owner, name, { title, body, head, base }) {
      const made = await request("POST", `/repos/${segment(owner)}/${segment(name)}/pulls`, { title, body, head, base, maintainer_can_modify: true });
      return { number: made.number, url: made.html_url };
    },

    /** A text file of a repository's default branch (or of the commit `ref`), or null when there is none. */
    async textFile(owner, name, file, { ref = null } = {}) {
      const at = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const got = await orNull(request("GET", `/repos/${segment(owner)}/${segment(name)}/contents/${String(checkRepoPath(file)).split("/").map(segment).join("/")}${at}`));
      if (!got || got.type !== "file" || got.encoding !== "base64" || typeof got.content !== "string") return null;
      return Buffer.from(got.content, "base64").toString("utf8");
    },

    /**
     * The submission to the catalog: a branch from the catalog's own branch, these files on top, and a pull request.
     * When the person has an open pull request that changes the same file (`file`, the app's manifest: an earlier
     * version not merged yet), the new commit goes into it instead, and its title and description become the new
     * ones: one request per app. The branch is in the catalog itself when the person may push there (a test catalog
     * of their own, which GitHub does not let them fork), otherwise in their fork.
     * @param {{ catalog: { owner: string, name: string }, login: string, branch: string, files: object[], message: string, title: string, body: string }} o
     */
    async proposeToCatalog({ catalog, login, branch, files, message, title, body, file = files[0]?.path }) {
      const upstreamRepo = await api.repo(catalog.owner, catalog.name);
      if (!upstreamRepo) throw new GithubApiError("catalog_closed", `${catalog.owner}/${catalog.name} cannot be seen: it is private or not there`);
      const earlier = await api.openPullChanging(catalog.owner, catalog.name, { login, file });
      if (earlier) {
        const pushed = await api.pushFiles({ owner: earlier.owner, name: earlier.name, branch: earlier.branch, files, message, mode: "add" });
        await api.updatePull(catalog.owner, catalog.name, earlier.number, { title, body });
        const direct = earlier.owner.toLowerCase() === catalog.owner.toLowerCase() && earlier.name.toLowerCase() === catalog.name.toLowerCase();
        return { number: earlier.number, url: earlier.url, commit: pushed.commit, created: false, direct, branch: earlier.branch, base: upstreamRepo.default_branch };
      }
      const base = upstreamRepo.default_branch;
      // A catalog with no commit yet answers 409 for its branch: there is nothing to branch from.
      const upstream = await api.branchHead(catalog.owner, catalog.name, base).catch((e) => {
        if (e.code === "conflict") return null;
        throw e;
      });
      if (!upstream) throw new GithubApiError("catalog_empty", `${catalog.owner}/${catalog.name} has no commit on ${base} yet`);
      let target;
      if (upstreamRepo.permissions?.push === true) {
        target = { owner: upstreamRepo.owner?.login ?? catalog.owner, name: upstreamRepo.name ?? catalog.name, direct: true };
      } else {
        if (upstreamRepo.allow_forking === false) throw new GithubApiError("fork_not_allowed", `${catalog.owner}/${catalog.name} does not allow forks`);
        let fork;
        try {
          fork = await api.fork(catalog.owner, catalog.name);
        } catch (e) {
          if (e.code === "forbidden" || e.code === "unprocessable" || e.code === "not_found") throw new GithubApiError("fork_not_allowed", `${catalog.owner}/${catalog.name} cannot be forked: ${e.message}`, { status: e.status });
          throw e;
        }
        if (fork.owner.toLowerCase() !== login.toLowerCase()) throw new GithubApiError("bad_answer", `the fork is ${fork.owner}'s, not ${login}'s`);
        await api.waitForFork(fork);
        target = { owner: fork.owner, name: fork.name, direct: false };
      }
      if (!(await api.branchHead(target.owner, target.name, branch))) await api.createBranch(target.owner, target.name, branch, upstream);
      const pushed = await api.pushFiles({ owner: target.owner, name: target.name, branch, files, message, mode: "add" });
      const head = `${target.owner}:${branch}`;
      const made = await api.createPull(catalog.owner, catalog.name, { title, body, head, base });
      return { ...made, commit: pushed.commit, created: true, direct: target.direct, branch, base };
    },
  };
  return api;
}
