// EMU-344: the speed probe again (speed.mjs --record), with the pieces the model needs to tell the price of a call
// from that of an instruction and a heap byte: calls (String() a pixel), noCalls (the same without a call), cheapCalls
// (an empty function as often), and drawtime with its own frame and with the probe's 72x16 frame of 32 colors. The
// times go to packages/server/bar-speed.json under the BUSY Bar's firmware, the model is fitted again as speed.mjs
// does. The standard BUSY Bar only.
export default {
  id: "EMU-344",
  title: "speed: calls, no calls, cheap calls; drawtime with the probe's frame",
  async run(ctx) {
    await ctx.part("speed", { suite: true, standard: true }, () => ctx.suite("speed.mjs", ["--record", "--bar", ctx.addr], "the speed probe's times and the model fitted to them"));
  },
};
