// The bar's speaker: POST and DELETE /api/audio/play with the checks and answers of the firmware (api_audio.c) and the
// behavior of its audio service (applications/services/audio): a file is raw 16-bit mono PCM at 44100 Hz; a new file
// replaces the one playing; the amplifier takes 100 ms to warm up before a file is even opened and stays warm for 3 s
// after the sound ends. The sound itself plays in the device window, which gets "audio" events and fetches the samples.
import { EventEmitter } from "node:events";

const SAMPLE_RATE = 44100; // AUDIO_SAMPLE_RATE
const WARMUP_MS = 100; // AUDIO_AMPLIFIER_WARMUP_MS
const COOLDOWN_MS = 3000; // AUDIO_AMPLIFIER_COOLDOWN_MS
const ASSETS_DIR = "/ext/user_assets"; // AUDIO_ASSETS_DIR
const SHARED_SOUNDS = "/ext/apps_assets/shared/sounds"; // SHARED_SOUND_PATH

// mongoose's mg_path_is_sane: no ".." path segment.
const sane = (path) => !path.split(/[/\\]/).includes("..");

export class AudioPlayer {
  /**
   * @param {(path: string) => Uint8Array | null} readFile device path → bytes
   * @param {(text: string) => void} log
   */
  constructor(readFile, log) {
    this.readFile = readFile;
    this.log = log;
    // "play" { id, seconds } when a sound starts, "stop" when it is cut short or ends.
    this.events = new EventEmitter();
    this.current = null; // { id, path, samples: Uint8Array, timer } while a sound plays
    this.warmup = null; // the timer of the amplifier's warmup, with the file to open after it
    this.queued = null;
    this.warmUntil = 0;
    this.nextId = 1;
  }

  get playing() {
    return this.current !== null;
  }

  /** The samples of the sound that plays, for the device window. */
  samples(id) {
    return this.current?.id === Number(id) ? this.current.samples : null;
  }

  /** audio_play_file(): false only when a warm, silent amplifier cannot open the file at once. */
  playFile(path) {
    this.queued = path;
    if (this.current) {
      // The one playing fades out, then the new one starts.
      this.end();
      return this.load() || true;
    }
    if (this.warmup) return true; // it will play this file when the warmup is over
    if (Date.now() < this.warmUntil) return this.load();
    this.warmup = setTimeout(() => {
      this.warmup = null;
      this.load();
    }, WARMUP_MS);
    return true;
  }

  load() {
    const path = this.queued;
    this.queued = null;
    if (!path) return false;
    const samples = this.readFile(path);
    if (!samples) {
      this.log(`Audio: failed to open ${path}`);
      this.warmUntil = Date.now() + COOLDOWN_MS;
      return false;
    }
    const seconds = samples.length / 2 / SAMPLE_RATE;
    const id = this.nextId++;
    this.current = { id, path, samples, timer: setTimeout(() => this.end(), seconds * 1000) };
    this.log(`Audio: ${path}, ${seconds.toFixed(1)} s`);
    this.events.emit("play", { id, seconds });
    return true;
  }

  end() {
    if (!this.current) return;
    clearTimeout(this.current.timer);
    this.current = null;
    this.warmUntil = Date.now() + COOLDOWN_MS;
    this.events.emit("stop");
  }

  /** audio_stop(): false when nothing plays or is about to. */
  stop() {
    this.queued = null;
    if (this.current) {
      this.end();
      return true;
    }
    if (this.warmup) {
      clearTimeout(this.warmup);
      this.warmup = null;
      return true;
    }
    return false;
  }

  /**
   * POST /api/audio/play: the body → { status, error? }. An app's own file is under its folder in /ext/user_assets,
   * a stock one is named "<anything>/<file>" and is looked for among the shared sounds.
   */
  request(bodyText) {
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = {};
    }
    const str = (v) => (typeof v === "string" ? v : null);
    const app = str(body?.application_name);
    const uploaded = str(body?.path);
    const stock = str(body?.stock_path);
    if (app === null) return { status: 400, error: "Missing application_name" };
    if (uploaded !== null && stock !== null) return { status: 400, error: "Both path and stock_path are defined" };
    if (uploaded === null && stock === null) return { status: 400, error: "Missing path or stock_path" };
    let file;
    if (uploaded !== null) {
      file = `${ASSETS_DIR}/${app}/${uploaded}`;
      if (!sane(file)) return { status: 400, error: "Invalid path" };
    } else {
      const slash = stock.lastIndexOf("/");
      const name = slash < 0 ? "" : stock.slice(slash + 1);
      if (!name) return { status: 400, error: "Wrong file name" };
      file = `${SHARED_SOUNDS}/${name}`;
    }
    return this.playFile(file) ? { status: 200 } : { status: 404, error: "Failed to play audio" };
  }
}
