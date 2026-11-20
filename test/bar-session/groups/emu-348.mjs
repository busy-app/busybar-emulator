// EMU-348: drawing on 1.4.1. Three suites record it, each where it reads it:
//   golden.mjs   an app's own pictures (PNG of every color type, one larger than the display, one on the back) and
//                text outside ASCII in small, normal and large: golden/<firmware>/<scene>.json;
//   state/record.mjs --more   the night's draw and busy requests of 1.3.1 again: state/bar-state-<firmware>-more.json;
//   timed.mjs    the firmware's .anim on the back display: timed/<firmware>/anim-back.json (pace: the standard BUSY Bar).
export const GOLDEN_SCENES = [
  "png-front-full", "png-alpha-over-rect", "png-back", "png-too-large", "png-palette", "png-gray", "png-gray-alpha",
  "text-cyrillic-small", "text-cyrillic-normal", "text-cyrillic-large", "text-diacritics", "text-symbols", "text-emoji",
];

export default {
  id: "EMU-348",
  title: "drawing on 1.4.1: an app's pictures, text outside ASCII, draw answers, the back display",
  async run(ctx) {
    await ctx.part("golden", { firmware: "1.4.1", suite: true }, () => ctx.suite("golden.mjs", ["--record", "--bar", ctx.addr, "--only", GOLDEN_SCENES.join(",")], "golden frames of 13 scenes"));
    await ctx.part("state", { firmware: "1.4.1", suite: true }, () => ctx.suite("state/record.mjs", ["--more", "--bar", ctx.addr], "draw and busy answers and frames"));
    await ctx.part("timed", { firmware: "1.4.1", suite: true, standard: true }, () => ctx.suite("timed.mjs", ["--record", "--bar", ctx.addr, "--only", "anim-back"], "the back display's animation in time"));
  },
};
