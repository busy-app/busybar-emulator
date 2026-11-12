// A stand-in for GitHub on 127.0.0.1, for the tests of src/github/ (through the stand-in for gh, fake-gh.mjs): the
// device flow's two addresses and the part of the REST API that Publish stage 2 uses, with repositories, branches, blobs, trees, commits, forks and pull requests
// kept in memory. Nothing here talks to GitHub.
//
// It knows one person, `login`, by one token. A test can put answers in front of the next requests (`stub.next`), to
// play a limit, an error or a misbehaving GitHub, and reads what was asked (`stub.requests`).
import { createHash } from "node:crypto";
import http from "node:http";

const sha1 = (text) => createHash("sha1").update(text).digest("hex");
const blobSha = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export async function startGithubStub({ port, login = "octo-person", token = "dummy-stub-token-0123456789abcdef", others = { "octo-own": "dummy-own-token-0123456789abcdef" } } = {}) {
  /** Who each token is: the person the stand-in keeps repositories for, and other accounts that only answer GET /user. */
  const tokens = new Map([[token, login], ...Object.entries(others).map(([who, t]) => [t, who])]);
  const repos = new Map();
  const objects = new Map();
  const pulls = [];
  /** Answers to give before any real handling: { status, headers, body } or a function (req) => that or null. */
  const next = [];
  const requests = [];
  // fail(req, url): an answer instead of the stand-in's, or null; hold(req, url): a promise the request waits for first
  // (an upload GitHub is slow to take).
  const hooks = { fail: null, hold: null };
  const device = { answers: [] };
  /** Forks that answer 404 for this many more reads. */
  const pending = new Map();
  /** Refs that ignore the next move: a GitHub that says yes and does nothing. */
  const deaf = new Set();
  /** "owner/name" in lower case → its latest release: { tag, assets: [{ name, bytes, size? }] }. */
  const releases = new Map();
  /** The stand-in's own address, for the release files' download addresses. */
  let base = null;

  /**
   * Makes `tag` the latest release of a repository, with these files: { name: bytes }. Each is downloaded from
   * /download/<owner>/<name>/<tag>/<file> after a redirect, as GitHub sends a release's file to another host.
   */
  function addRelease(fullName, tag, files, { sizes = {} } = {}) {
    releases.set(fullName.toLowerCase(), { tag, assets: Object.entries(files).map(([name, bytes]) => ({ name, bytes: Buffer.from(bytes), size: sizes[name] })) });
  }
  const releaseJson = (repo, release) => ({
    tag_name: release.tag,
    name: release.tag,
    html_url: `https://github.com/${repo.owner}/${repo.name}/releases/tag/${release.tag}`,
    assets: release.assets.map((one, i) => ({ id: i + 1, name: one.name, size: one.size ?? one.bytes.length, browser_download_url: `${base}/releases/${repo.owner}/${repo.name}/${release.tag}/${encodeURIComponent(one.name)}` })),
  });

  function put(object) {
    const sha = object.type === "blob" ? blobSha(object.bytes) : sha1(JSON.stringify(object));
    objects.set(sha, object);
    return sha;
  }

  function makeRepo(owner, name, { autoInit = true } = {}) {
    const repo = { owner, name, refs: new Map(), defaultBranch: "main" };
    if (autoInit) {
      const readme = put({ type: "blob", bytes: Buffer.from(`# ${name}\n`) });
      const tree = put({ type: "tree", entries: [{ path: "README.md", mode: "100644", sha: readme }] });
      repo.refs.set("main", put({ type: "commit", message: "Initial commit", tree, parents: [] }));
    }
    repos.set(`${owner}/${name}`.toLowerCase(), repo);
    return repo;
  }

  function isAncestor(older, newer) {
    const queue = [newer];
    while (queue.length) {
      const sha = queue.shift();
      if (sha === older) return true;
      queue.push(...(objects.get(sha)?.parents ?? []));
    }
    return false;
  }

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  // The request's author (who opened it) is apart from its head (whose branch it is): anyone may open a request
  // from a branch of a public fork.
  const pullJson = (p) => ({ number: p.number, html_url: p.url, title: p.title, state: p.state, user: { login: p.author ?? login }, head: { ref: p.headRef, label: p.head, user: { login: p.headRepo.owner }, repo: { name: p.headRepo.name, owner: { login: p.headRepo.owner } } } });
  const repoJson = (repo) => ({ archived: repo.archived === true, description: repo.description ?? null, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, default_branch: repo.defaultBranch, html_url: `https://github.com/${repo.owner}/${repo.name}`, private: false, allow_forking: repo.allowForking !== false, permissions: { admin: repo.owner === login, push: repo.owner === login || Boolean(repo.pushers?.includes(login)), pull: true } });

  /**
   * Puts files on a branch of a repository in one commit: { path: text }. `modes`: { path: mode } for an executable
   * (100755), a link (120000) or a submodule (160000, its text the commit it names).
   */
  function commitFiles(fullName, branch, files, { modes = {} } = {}) {
    const repo = repos.get(fullName.toLowerCase());
    const parent = repo.refs.get(branch) ?? null;
    const entries = new Map(parent ? objects.get(objects.get(parent).tree).entries.map((e) => [e.path, e]) : []);
    for (const [path, text] of Object.entries(files)) {
      const mode = modes[path] ?? "100644";
      entries.set(path, mode === "160000" ? { path, mode, type: "commit", sha: text } : { path, mode, sha: put({ type: "blob", bytes: Buffer.from(text) }) });
    }
    const tree = put({ type: "tree", entries: [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1)) });
    const commit = put({ type: "commit", message: "files", tree, parents: parent ? [parent] : [] });
    repo.refs.set(branch, commit);
    return commit;
  }

  function handleApi(req, res, url, body) {
    // gh sends "token <token>".
    const me = tokens.get(String(req.headers.authorization ?? "").replace(/^(token|Bearer) /, ""));
    if (!me) return json(res, 401, { message: "Bad credentials" });
    const path = decodeURIComponent(url.pathname);
    let m;
    if (req.method === "GET" && path === "/user") return json(res, 200, { login: me });
    if (me !== login) return json(res, 403, { message: "the stand-in keeps repositories for one person only" });
    if (req.method === "POST" && path === "/user/repos") {
      if (repos.has(`${login}/${body.name}`.toLowerCase())) return json(res, 422, { message: "Repository creation failed.", errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }] });
      return json(res, 201, repoJson(makeRepo(login, body.name, { autoInit: body.auto_init })));
    }
    if (!(m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path))) return json(res, 404, { message: "Not Found" });
    const [, owner, name, rest = ""] = m;
    const key = `${owner}/${name}`.toLowerCase();
    if (pending.get(key) > 0) {
      pending.set(key, pending.get(key) - 1);
      return json(res, 404, { message: "Not Found" });
    }
    const repo = repos.get(key);
    if (!repo) return json(res, 404, { message: "Not Found" });
    if (req.method === "GET" && rest === "") return json(res, 200, repoJson(repo));
    if (req.method === "GET" && rest === "/releases/latest") {
      const release = releases.get(key);
      return release ? json(res, 200, releaseJson(repo, release)) : json(res, 404, { message: "Not Found" });
    }
    if (req.method === "GET" && (m = /^\/contents\/(.+)$/.exec(rest))) {
      // ?ref=<commit or branch>: the file as that commit has it.
      const ref = url.searchParams.get("ref");
      const head = ref ? (repo.refs.get(ref) ?? (objects.get(ref)?.type === "commit" ? ref : null)) : repo.refs.get(repo.defaultBranch);
      const entry = head ? objects.get(objects.get(head).tree).entries.find((e) => e.path === m[1]) : null;
      return entry ? json(res, 200, { type: "file", encoding: "base64", path: m[1], content: objects.get(entry.sha).bytes.toString("base64") }) : json(res, 404, { message: "Not Found" });
    }
    if (req.method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      if (!repo.refs.size) return json(res, 409, { message: "Git Repository is empty." });
      const sha = repo.refs.get(m[1]);
      return sha ? json(res, 200, { ref: `refs/heads/${m[1]}`, object: { sha, type: "commit" } }) : json(res, 404, { message: "Not Found" });
    }
    if (req.method === "GET" && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
      const commit = objects.get(m[1]);
      return commit?.type === "commit" ? json(res, 200, { sha: m[1], tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })), message: commit.message }) : json(res, 404, { message: "Not Found" });
    }
    if (req.method === "GET" && (m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
      const tree = objects.get(m[1]);
      return tree?.type === "tree" ? json(res, 200, { sha: m[1], truncated: false, tree: tree.entries.map((e) => (e.type === "commit" ? { ...e } : { ...e, type: "blob", size: objects.get(e.sha)?.bytes?.length ?? 0 })) }) : json(res, 404, { message: "Not Found" });
    }
    if (req.method === "GET" && (m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest))) {
      const blob = objects.get(m[1]);
      return blob?.type === "blob" ? json(res, 200, { sha: m[1], size: blob.bytes.length, encoding: "base64", content: blob.bytes.toString("base64") }) : json(res, 404, { message: "Not Found" });
    }
    if (req.method === "GET" && (m = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest))) {
      const [, base, head] = m;
      if (objects.get(base)?.type !== "commit" || objects.get(head)?.type !== "commit") return json(res, 404, { message: "Not Found" });
      const reach = (from) => {
        const seen = new Set();
        const queue = [from];
        while (queue.length) {
          const sha = queue.shift();
          if (seen.has(sha)) continue;
          seen.add(sha);
          queue.push(...(objects.get(sha)?.parents ?? []));
        }
        return seen;
      };
      const ofBase = reach(base);
      const ofHead = reach(head);
      const ahead = [...ofHead].filter((sha) => !ofBase.has(sha)).length;
      const behind = [...ofBase].filter((sha) => !ofHead.has(sha)).length;
      const status = !ahead && !behind ? "identical" : ahead && behind ? "diverged" : ahead ? "ahead" : "behind";
      return json(res, 200, { status, ahead_by: ahead, behind_by: behind });
    }
    if (req.method === "POST" && rest === "/git/blobs") {
      if (body.encoding !== "base64") return json(res, 422, { message: "encoding" });
      return json(res, 201, { sha: put({ type: "blob", bytes: Buffer.from(body.content, "base64") }) });
    }
    if (req.method === "POST" && rest === "/git/trees") {
      const entries = new Map();
      if (body.base_tree) for (const e of objects.get(body.base_tree)?.entries ?? []) entries.set(e.path, e);
      for (const e of body.tree) {
        // sha null: the path taken out of the base tree.
        if (e.sha === null && body.base_tree) {
          entries.delete(e.path);
          continue;
        }
        if (objects.get(e.sha)?.type !== "blob") return json(res, 422, { message: `no blob ${e.sha}` });
        entries.set(e.path, { path: e.path, mode: e.mode, sha: e.sha });
      }
      return json(res, 201, { sha: put({ type: "tree", entries: [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1)) }) });
    }
    if (req.method === "POST" && rest === "/git/commits") return json(res, 201, { sha: put({ type: "commit", message: body.message, tree: body.tree, parents: body.parents }) });
    if (req.method === "PATCH" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const old = repo.refs.get(m[1]);
      if (!old) return json(res, 422, { message: "Reference does not exist" });
      if (!body.force && !isAncestor(old, body.sha)) return json(res, 422, { message: "Update is not a fast forward" });
      if (deaf.delete(`${key}:${m[1]}`)) return json(res, 200, { object: { sha: body.sha } });
      repo.refs.set(m[1], body.sha);
      return json(res, 200, { ref: `refs/heads/${m[1]}`, object: { sha: body.sha } });
    }
    if (req.method === "POST" && rest === "/git/refs") {
      const branch = String(body.ref).replace(/^refs\/heads\//, "");
      if (repo.refs.has(branch)) return json(res, 422, { message: "Reference already exists" });
      repo.refs.set(branch, body.sha);
      return json(res, 201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (req.method === "POST" && rest === "/forks") {
      if (repo.allowForking === false) return json(res, 403, { message: "Repository forking is disabled." });
      // The person's fork of it, if there is one; else a new one, named as GitHub names it: the repository's name, or
      // with -1, -2 ... when the person has a repository of that name that is not this fork.
      let fork = [...repos.values()].find((one) => one.owner === login && one.forkOf === key);
      if (!fork) {
        let forkName = repo.name;
        for (let n = 1; repos.has(`${login}/${forkName}`.toLowerCase()); n++) forkName = `${repo.name}-${n}`;
        const forkKey = `${login}/${forkName}`.toLowerCase();
        fork = makeRepo(login, forkName, { autoInit: false });
        fork.forkOf = key;
        fork.refs.set(repo.defaultBranch, repo.refs.get(repo.defaultBranch));
        // A new fork is not there for the first reads.
        pending.set(forkKey, 2);
      }
      return json(res, 202, repoJson(fork));
    }
    if (req.method === "GET" && rest === "/pulls") {
      const head = url.searchParams.get("head");
      return json(res, 200, pulls.filter((p) => p.base === key && p.state === "open" && (!head || p.head === head)).map(pullJson));
    }
    if (req.method === "POST" && rest === "/pulls") {
      // The head "owner:branch" is in the base itself or in the owner's fork of it.
      const [headOwner, headRef] = String(body.head).split(":");
      const headRepo = headOwner.toLowerCase() === repo.owner.toLowerCase() ? repo : [...repos.values()].find((one) => one.owner.toLowerCase() === headOwner.toLowerCase() && one.forkOf === key);
      if (!headRepo?.refs.has(headRef)) return json(res, 422, { message: "Validation Failed", errors: [{ field: "head", code: "invalid" }] });
      const pull = { number: pulls.length + 1, author: login, base: key, head: body.head, headRepo, headRef, baseBranch: body.base, title: body.title, body: body.body, maintainerCanModify: body.maintainer_can_modify, state: "open" };
      pull.url = `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      pulls.push(pull);
      return json(res, 201, pullJson(pull));
    }
    if ((m = /^\/pulls\/(\d+)(\/files)?$/.exec(rest))) {
      const pull = pulls.find((p) => p.base === key && p.number === Number(m[1]));
      if (!pull) return json(res, 404, { message: "Not Found" });
      if (req.method === "GET" && m[2]) {
        // The files the head changes against the base's branch.
        const entries = (sha) => new Map(objects.get(objects.get(sha).tree).entries.map((e) => [e.path, e.sha]));
        const head = entries(pull.headRepo.refs.get(pull.headRef));
        const base = entries(repo.refs.get(pull.baseBranch));
        const changed = [...new Set([...head.keys(), ...base.keys()])].filter((path) => head.get(path) !== base.get(path));
        return json(res, 200, changed.map((filename) => ({ filename, status: base.has(filename) ? (head.has(filename) ? "modified" : "removed") : "added" })));
      }
      if (req.method === "PATCH" && !m[2]) {
        if (typeof body.title === "string") pull.title = body.title;
        if (typeof body.body === "string") pull.body = body.body;
        return json(res, 200, pullJson(pull));
      }
    }
    return json(res, 404, { message: "Not Found" });
  }

  function handleDevice(req, res, path, form) {
    const answer = device.answers.shift();
    if (!answer) return json(res, 500, { message: `no answer queued for ${path}` });
    return json(res, answer.status ?? 200, answer.body, answer.headers);
  }

  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (chunk) => parts.push(chunk));
    req.on("end", async () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const raw = Buffer.concat(parts).toString("utf8");
      const form = req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : null;
      let body = null;
      if (!form && raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { message: "Problems parsing JSON" });
        }
      }
      requests.push({ method: req.method, path: url.pathname + url.search, headers: req.headers, body: form ?? body });
      if (hooks.hold) await hooks.hold(req, url);
      // A test's rule for every request (hooks.fail(req, url) => an answer, or null to go on), then the queue.
      const failed = hooks.fail?.(req, url) ?? null;
      if (failed) return json(res, failed.status, failed.body, failed.headers);
      const forced = next.length ? next.shift() : null;
      const answer = typeof forced === "function" ? forced(req) : forced;
      if (answer) return json(res, answer.status, answer.body, answer.headers);
      if (url.pathname.startsWith("/api")) {
        url.pathname = url.pathname.slice(4) || "/";
        return handleApi(req, res, url, body);
      }
      if (url.pathname === "/login/device/code" || url.pathname === "/login/oauth/access_token") return handleDevice(req, res, url.pathname, form);
      // A release's file: its address on "github.com" sends the download on, as GitHub's does, to where the bytes are.
      let m;
      if (req.method === "GET" && (m = /^\/releases\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname))) {
        res.writeHead(302, { location: `/download/${m[1]}/${m[2]}/${m[3]}/${m[4]}` });
        return res.end();
      }
      if (req.method === "GET" && (m = /^\/download\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname))) {
        const release = releases.get(`${m[1]}/${m[2]}`.toLowerCase());
        const one = release?.tag === decodeURIComponent(m[3]) ? release.assets.find((asset) => asset.name === decodeURIComponent(m[4])) : null;
        if (!one) return json(res, 404, { message: "Not Found" });
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": one.bytes.length });
        return res.end(one.bytes);
      }
      return json(res, 404, { message: "Not Found" });
    });
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${port}`;
  return {
    login,
    token,
    others,
    /** The stand-in's address, for fake-gh.mjs (BUSY_EMULATOR_FAKE_GH_STAND_IN): the device flow at its root, the API under /api. */
    base: `http://127.0.0.1:${port}`,
    next,
    hooks,
    requests,
    device,
    pulls,
    pending,
    deaf,
    makeRepo,
    commitFiles,
    addRelease,
    repoOf: (fullName) => repos.get(fullName.toLowerCase()) ?? null,
    /** The files of a branch: { path: text }. */
    filesOf(fullName, branch) {
      const repo = repos.get(fullName.toLowerCase());
      const commit = objects.get(repo.refs.get(branch));
      return Object.fromEntries(objects.get(commit.tree).entries.map((e) => [e.path, objects.get(e.sha)?.bytes?.toString("utf8") ?? e.sha]));
    },
    headOf: (fullName, branch) => repos.get(fullName.toLowerCase())?.refs.get(branch) ?? null,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
