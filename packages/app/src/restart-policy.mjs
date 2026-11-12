// How often a dead server is started again: the third death within a minute is the last one.
export function createRestartPolicy({ limit = 3, windowMs = 60_000, now = Date.now } = {}) {
  let deaths = [];
  return {
    limit,
    windowMs,
    /** Records a death. True: start the server again; false: this was one too many. */
    died() {
      const t = now();
      deaths = deaths.filter((at) => t - at < windowMs);
      deaths.push(t);
      return deaths.length < limit;
    },
    reset() {
      deaths = [];
    },
  };
}
