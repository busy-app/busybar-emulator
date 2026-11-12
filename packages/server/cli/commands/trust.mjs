// busy-emulator trust [<folder>] [--wait <seconds>]: asks the person, through the running app, whether they trust a
// project folder the emulator did not create — the one way out of untrusted_project (ADR-0012 section 4). In the
// field test the agent made its project with the official `npm create` on the system's Node, got untrusted_project
// from build, and could only stop.
//
// The command only asks. The emulator's app shows a dialog of the system's with the folder's real path and what
// trusting it means (building it runs its code on this computer), buttons "Trust" and "Don't Trust", the second the
// default. The answer is the person's click there: nothing on the command line gives it, no option, no input, and no
// page can (the question goes to the server's management address with its key, the dialog belongs to the app's main
// process). A yes is written to the trusted list by the emulator itself and remembered for the folder; a no is kept
// only in the server's memory: for 30 seconds the same folder is not asked about again (trust_refused_recently), so
// that a caller in a loop cannot wear the person down; after that a call asks again. The command waits for the
// answer --wait seconds (120 unless given); stopping it takes the dialog away.
//
// It does not start the emulator (not_running). There is no other way to trust a folder: --trust of the project
// commands trusts nothing (../project.mjs requireTrust).
import { isTrusted } from "../../projects/trust.mjs";
import { blockedNetwork, commandLine, emulatorStatus, ready } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";
import { again, commandFor, projectAt, trustCommand } from "../project.mjs";

const USAGE = "trust [<folder>] [--wait <seconds>]";
const DEFAULT_WAIT_S = 120;
const MAX_WAIT_S = 600;

export default {
  name: "trust",
  summary: "Ask the person, in a dialog of the emulator's app, to trust a project folder the emulator did not create",
  usage: USAGE,
  maxArguments: 1,
  options: { "--wait": { key: "wait", value: "<seconds>" } },
  async run(ctx, sys, { args, options, progress }) {
    const self = commandLine(ctx);
    let wait = DEFAULT_WAIT_S;
    if (options.wait !== undefined) {
      wait = /^\d{1,4}$/.test(options.wait) ? Number(options.wait) : NaN;
      if (!(wait >= 5 && wait <= MAX_WAIT_S)) throw new CliError("usage", `--wait takes a whole number of seconds from 5 to ${MAX_WAIT_S}, not ${JSON.stringify(options.wait)}.`, `Usage: ${self} ${USAGE}`, { option: "--wait" });
    }
    const project = projectAt(ctx, sys, args[0]);
    const build = commandFor(ctx, project, "build");
    if (isTrusted(ctx.dataDir, project.dir, ctx.platform)) {
      return { data: { folder: project.dir, id: project.id, trusted: "before", asked: false }, text: `${project.dir} is trusted already; nobody was asked. Next: ${build}` };
    }
    const asking = trustCommand(ctx, project);
    const onlyTheDialog = `a folder is trusted only in the emulator's dialog, which needs the emulator's app running with its window (${self} start)`;

    const status = await emulatorStatus(ctx, sys);
    if (!ready(status)) {
      const hint = `Start it with ${self} start, then run ${asking} again: the emulator's app is what asks the person.`;
      if (!status.running) throw new CliError("not_running", "The emulator is not running, so there is no app to ask the person through.", hint);
      throw new CliError("not_running", `The emulator is running, but its BUSY Bar is not ready (${status.state}).`, hint);
    }
    const unavailable = (why) => new CliError("trust_unavailable", `The emulator could not ask the person whether ${project.dir} is trusted: ${why}. It stays untrusted.`, `Tell the person: ${onlyTheDialog}. Then run ${asking} again.`, { folder: project.dir });
    const control = sys.readControl(ctx.dataDir);
    if (control.blocked) {
      throw new CliError("blocked_file", `This process may not read the emulator's data folder ${ctx.dataDir} (${control.blocked}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.");
    }
    if (control.missing) throw unavailable(`its management address cannot be read (${control.missing})`);
    if (control.barPort !== status.port) throw unavailable(`the data folder's server is on port ${control.barPort}, the emulated BUSY Bar on ${status.port}`);

    progress(`Asking the person in BUSY Bar Emulator whether they trust ${project.dir} (waiting up to ${wait} s for their click)…`);
    const answer = await sys.askTrust(control.port, control.key, project.dir, wait * 1000);
    if (answer.blocked) throw blockedNetwork(control.port, answer.blocked);
    if (answer.failed) throw unavailable(`127.0.0.1:${control.port} did not answer (${answer.failed})`);
    let body = null;
    try {
      body = JSON.parse(answer.body);
    } catch {
      // Not the emulator's answer; told below.
    }
    const said = typeof body?.error === "string" ? body.error.replace(/\.$/, "") : null;
    if (answer.status === 409) throw new CliError("trust_busy", `${said ?? "Another question to the person is open in the emulator"}.`, `Wait until the person has answered it, then run ${asking} again.`, { folder: project.dir });
    if (answer.status === 400) {
      throw new CliError("trust_refused_path", `${said ?? "The emulator did not take the folder"}. ${project.dir} stays untrusted, and nobody was asked.`, body?.reason === "unshowable" ? `Rename the folder (or the folder above it that has such a name), then run ${again(ctx, "trust <folder>")} with the new name.` : `Name the project's folder: ${again(ctx, "trust <folder>")}.`, { folder: project.dir, reason: body?.reason ?? null });
    }
    // The person said no to this folder a moment ago: the server does not put the question before them again yet.
    if (answer.status === 429) {
      const seconds = Number.isFinite(body?.retry_after_s) ? body.retry_after_s : null;
      throw new CliError("trust_refused_recently", `The person chose "Don't Trust" for ${project.dir} a moment ago, so the emulator does not ask them again yet${seconds === null ? "" : ` (for another ${seconds} s)`}. The folder stays untrusted.`, "Do not ask again unless the person tells you to. Ask them what they would rather do; a project made with create needs no question.", { folder: project.dir, retry_after_s: seconds, trusted: false });
    }
    if (answer.status === 401) throw unavailable("it did not take the server's key (the emulator has just started again); run the command again");
    // 404: a server from before this command; 501: a server without the app (run from the source folder).
    if (answer.status === 404 || answer.status === 501) throw unavailable(said ?? "this emulator has no dialog to ask in");
    if (answer.status !== 200 || typeof body?.trusted !== "boolean") throw unavailable(said ?? `it answered HTTP ${answer.status}`);

    const data = { folder: project.dir, id: project.id, asked: body.answer !== "already", answer: body.answer };
    if (body.trusted) {
      // The emulator wrote the list; this command line must read the folder as trusted from the same list.
      if (!isTrusted(ctx.dataDir, project.dir, ctx.platform)) throw unavailable(`the running emulator keeps its trusted folders somewhere else than ${ctx.dataDir}`);
      return { data: { ...data, trusted: body.answer === "already" ? "before" : "now" }, text: `${body.answer === "already" ? `${project.dir} is trusted already` : `The person trusted ${project.dir}; the emulator remembers it`}. Next: ${build}` };
    }
    if (body.answer === "refuse") {
      throw new CliError("trust_refused", `The person chose "Don't Trust" for ${project.dir}: it stays untrusted, and nothing of it is built or run.`, "Do not ask again unless the person tells you to. Ask them what they would rather do; a project made with create needs no question.", { ...data, trusted: false });
    }
    if (body.answer === "no_answer") {
      throw new CliError("trust_no_answer", `Nobody answered the emulator's question about ${project.dir} within ${wait} s; the dialog was taken away and the folder stays untrusted.`, `Tell the person that BUSY Bar Emulator will ask them to trust this folder, then run ${asking} again (--wait <seconds> waits longer, up to ${MAX_WAIT_S}).`, { ...data, trusted: false });
    }
    throw unavailable(body.answer === "canceled" ? "the question was taken away before the person answered" : (body.reason ?? "its app can show no dialog now"));
  },
};
