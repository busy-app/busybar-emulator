// The GIF of a take, encoded on a thread of its own (record.mjs): the server's thread runs the bar, its API and the
// app's JS, and must go on answering while a long GIF is made. workerData: { fronts, steps, scale, fps } as
// encodeFrontGif takes them; the answer is the file's bytes, or { error }. Imported on the main thread (a test imports
// every module), it does nothing.
import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { encodeFrontGif } from "./gif.mjs";

if (!isMainThread && parentPort) {
  try {
    const { fronts, steps, scale, fps } = workerData;
    const gif = encodeFrontGif(fronts, steps, { scale, fps });
    parentPort.postMessage({ gif: new Uint8Array(gif.buffer, gif.byteOffset, gif.byteLength) });
  } catch (e) {
    parentPort.postMessage({ error: String(e?.stack ?? e) });
  }
}
