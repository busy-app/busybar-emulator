// A server module whose start ends the process before it is ready, as a crash in the middle of a start would: for the
// shell's tests of a start that ended without a word.
export async function startServer() {
  console.error("the module ended its process");
  process.exit(5);
}
