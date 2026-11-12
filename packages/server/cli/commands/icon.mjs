// busy-emulator icon [<folder>] (--text <AB> | --from <picture.png>) [--back <picture.png>] [--color <#RRGGBB>] [--force]:
// the app's two icons, written into the project beside its manifest (../../capture/icon.mjs):
//
//   src/appmeta/icon_front_8x8.png    8×8, color: the front display's menu and the catalog's card
//   src/appmeta/icon_back_11x11.png   11×11, a shape in the alpha channel: the back display's menu paints it itself
//
// --text draws one or two letters or digits; --from scales a PNG of any size down (its transparency is the back
// icon's shape; an opaque picture's shape is what differs from its corners). Both files are checked against the
// catalog's icon rules before the answer. --back gives the back icon its own picture (one drawn at 11×11 is taken pixel
// for pixel, another size scaled), in place of the one made from --text or --from. Icons that are there are kept unless --force is given. Nothing of the
// project is run, so the project need not be trusted; the emulator need not run.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { commandLine } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";
import { commandFor, projectAt } from "../project.mjs";
import { SANDBOX_CODES } from "../system.mjs";

const USAGE = "icon [<folder>] (--text <AB> | --from <picture.png>) [--back <picture.png>] [--color <#RRGGBB>] [--force]";

export default {
  name: "icon",
  summary: "Make the app's two icons (8×8 front, 11×11 back) from one or two letters or from a PNG of any size, in the formats the BUSY Bar and the catalog take",
  usage: USAGE,
  maxArguments: 1,
  options: { "--text": { key: "text", value: "<AB>" }, "--from": { key: "from", value: "<picture.png>" }, "--back": { key: "back", value: "<picture.png>" }, "--color": { key: "color", value: "<#RRGGBB>" }, "--force": { key: "force" } },
  async run(ctx, sys, { args, options }) {
    const { ICONS, MAX_PICTURE_BYTES, PictureError, asText, backFromPicture, iconColor, iconText, iconsFromPicture, iconsFromText } = await import("../../capture/icon.mjs");
    const self = commandLine(ctx);
    const usage = (message, option) => new CliError("usage", message, `Usage: ${self} ${USAGE}. For example: ${self} icon --text FT --color "#FF5533".`, { option });
    if ((options.text === undefined) === (options.from === undefined)) throw usage(options.text === undefined ? "icon needs what to make the icons from: --text with one or two letters, or --from with a PNG file." : "--text and --from do not go together: the icons are made from letters or from a picture.", options.text === undefined ? null : "--from");
    const letters = options.text === undefined ? null : iconText(options.text);
    if (options.text !== undefined && !letters) throw usage(`--text takes one or two letters or digits (A to Z, 0 to 9), not ${JSON.stringify(options.text)}: an 8×8 icon has room for no more.`, "--text");
    const color = options.color === undefined ? undefined : iconColor(options.color);
    if (options.color !== undefined && !color) throw usage(`--color takes a color as #RRGGBB, not ${JSON.stringify(options.color)}.`, "--color");
    if (color && !letters) throw usage("--color goes with --text: a picture keeps its own colors.", "--color");

    const project = projectAt(ctx, sys, args[0]);
    const folder = [path.join(project.dir, "src", "appmeta"), path.join(project.dir, "appmeta")].find((dir) => existsSync(path.join(dir, "manifest.json")));
    if (!folder) throw new CliError("not_a_project", `${project.dir} has no appmeta/manifest.json to put the icons beside.`, "Run it in the folder of an app project.", { folder: project.dir });
    const files = { front: path.join(folder, ICONS.front.file), back: path.join(folder, ICONS.back.file) };
    const there = Object.values(files).filter((file) => existsSync(file));
    if (there.length && !options.force) {
      throw new CliError("icon_exists", `${there.map((file) => path.relative(project.dir, file)).join(" and ")} ${there.length === 1 ? "is" : "are"} there already and ${there.length === 1 ? "is" : "are"} kept.`, `To replace both icons, add --force: ${commandFor(ctx, project, "icon", ` --force ${letters ? `--text ${letters}` : "--from <picture.png>"}`)}.`, { files: there });
    }

    /** A picture the command was given, made into what `make` makes of its bytes; a failure says which file and why. */
    const fromFile = (given, make, sizeHint) => {
      const from = path.resolve(sys.cwd(), given);
      try {
        if (statSync(from).size > MAX_PICTURE_BYTES) throw new PictureError(`it is ${(statSync(from).size / 1024 / 1024).toFixed(1)} MiB; the most is ${MAX_PICTURE_BYTES / 1024 / 1024} MiB`);
        return { from, made: make(readFileSync(from)) };
      } catch (e) {
        if (e instanceof PictureError) throw new CliError("picture_unreadable", `${from} cannot be made into an icon: ${e.message}.`, `Give a PNG file (8 bits a channel, not interlaced), ${sizeHint}.`, { file: from });
        if (SANDBOX_CODES.has(e?.code)) throw new CliError("blocked_file", `This process may not read ${from} (${e.code}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.", { file: from });
        throw new CliError("picture_unreadable", `${from} cannot be read (${e?.code ?? e?.message ?? e}).`, "Name a PNG file that is there.", { file: from });
      }
    };
    let icons;
    let source = null;
    if (letters) icons = iconsFromText(letters, color);
    else {
      const { from, made } = fromFile(options.from, iconsFromPicture, "of any size; a square one keeps its shape best");
      icons = made;
      source = { file: from, width: icons.source.width, height: icons.source.height };
    }
    let backSource = null;
    if (options.back !== undefined) {
      const { from, made } = fromFile(options.back, backFromPicture, "of any size; one drawn at 11×11 is taken pixel for pixel");
      icons = { ...icons, back: made };
      backSource = { file: from };
    }

    // The catalog's own rules for an icon, before anything is written: a file made here that they refuse is a fault
    // of the emulator's, and is said as one.
    const { loadPngChecker } = await import("../../readiness/check.mjs");
    const checker = await loadPngChecker();
    const verdicts = {};
    for (const side of ["front", "back"]) {
      const verdict = checker ? checker.check(icons[side], ICONS[side].kind) : null;
      verdicts[side] = verdict ? verdict.verdict : "unchecked";
      if (verdict?.verdict === "fail") throw new CliError("internal", `The ${side} icon made here does not pass the catalog's rules: ${verdict.message}`, "Report this with the command you ran.");
    }
    for (const side of ["front", "back"]) {
      try {
        writeFileSync(files[side], icons[side]);
      } catch (e) {
        if (SANDBOX_CODES.has(e?.code)) throw new CliError("blocked_file", `This process may not write ${files[side]} (${e.code}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.", { file: files[side] });
        throw new CliError("write_failed", `Could not write ${files[side]}: ${e?.code ?? e?.message ?? e}.`, "Check that the project's folder can be written to.", { file: files[side] });
      }
    }
    const shape = asText(icons.back);
    const blank = !shape.includes("#");
    return {
      data: {
        folder: project.dir,
        id: project.id,
        from: letters ? { text: letters, color: color ? `#${color.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase()}` : "#FFFFFF" } : source,
        back_from: backSource,
        front: { file: files.front, width: ICONS.front.size, height: ICONS.front.size, format: "8-bit RGBA", bytes: icons.front.length, catalog: verdicts.front },
        back: { file: files.back, width: ICONS.back.size, height: ICONS.back.size, format: "8-bit gray and alpha", bytes: icons.back.length, catalog: verdicts.back, shape: shape.split("\n") },
        replaced: there,
      },
      text: [
        `Made the icons of ${project.id ?? "the app"} from ${letters ? `the text ${letters}` : `${source.file} (${source.width}×${source.height})`}${backSource ? `, the back one from ${backSource.file}` : ""}:`,
        `  ${files.front}  8×8, color: the front display's menu and the catalog`,
        `  ${files.back}  11×11, a shape the back display's menu paints itself:`,
        ...shape.split("\n").map((row) => `      ${row}`),
        ...(blank ? ["The back icon's shape is empty: the picture has nothing that stands out from its corners. Give one with a transparent background."] : []),
        `Both pass the catalog's icon rules${checker ? "" : " (not checked: this copy has no PNG checker)"}. Next: ${commandFor(ctx, project, "dev", " --once")} puts them into the app; commit them with the project.`,
      ].join("\n"),
    };
  },
};
