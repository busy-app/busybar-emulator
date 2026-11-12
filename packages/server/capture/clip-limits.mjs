// What a clip may be (busy-emulator record, POST /_emu/record): the server's checks, and the command line's, which
// tells a wrong call before it asks the emulator. One module for both, so the two cannot disagree.
//
// A GIF is encoded by the server, on a thread of its own (gif-worker.mjs), and its size grows with every frame that
// differs from the one before and with the square of the scale: a changing screen at scale 26 is about 120 KB a frame
// at worst, so 30 s at 50 frames a second would be a GIF of some 180 MB that nobody can post. A GIF takes at most
// GIF_LIMITS.frames frames (seconds × fps), and frames × scale × scale at most GIF_LIMITS.area: 30 s at 25 frames a
// second at the default scale 8 is half of it; at scale 26 it is 142 frames. At worst (every LED changes at every
// step) such a file is about 20 MB, encoded in 2 to 3 s.

// An MP4 is at most two minutes, as the window's Record button takes (X takes 140 s from an account without Premium).
export const LIMITS = Object.freeze({ seconds: [1, 120], fps: [1, 60], gifFps: [1, 50], scale: [2, 26] });
export const GIF_LIMITS = Object.freeze({ frames: 750, area: 96_000 });
/** A GIF's frames a second and scale when the caller gives none. */
export const GIF_DEFAULTS = Object.freeze({ fps: 25, scale: 8 });

/** The most frames a GIF at `scale` may have. */
export function gifMaxFrames(scale) {
  return Math.min(GIF_LIMITS.frames, Math.floor(GIF_LIMITS.area / (scale * scale)));
}

/** Why a GIF of `seconds` at `fps` and `scale` is too large, or null. The text names the limits and what to change. */
export function gifTooLarge({ seconds, fps, scale }) {
  const frames = seconds * fps;
  const most = gifMaxFrames(scale);
  if (frames <= most) return null;
  const longest = Math.max(1, Math.floor(most / fps));
  return (
    `a GIF of ${seconds} s at ${fps} frames a second is ${frames} frames, too many at scale ${scale}: ` +
    `a GIF has at most ${GIF_LIMITS.frames} frames (seconds × fps), and frames × scale × scale at most ${GIF_LIMITS.area}, ` +
    `which at scale ${scale} is ${most} frames (${longest} s at ${fps} frames a second). Record fewer seconds, fewer frames a second or a smaller scale, or an MP4`
  );
}
