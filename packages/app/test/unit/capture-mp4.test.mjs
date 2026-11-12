// The MP4 writer of busy-emulator record (src/capture-mp4.mjs): what a player and the networks read from the boxes.
// The samples here are stand-ins; the app test (test/app/record.test.mjs) writes real H.264 from the encoder.
import assert from "node:assert/strict";
import { test } from "node:test";

import { boxes, muxMp4, readMp4, SILENCE, SILENT_FRAME, spsFacts } from "../../src/capture-mp4.mjs";

// An avcC of High profile (100), level 4.0 (40), with an empty SPS and PPS: enough for the boxes.
const AVCC = Uint8Array.from([1, 100, 0, 40, 0xff, 0xe1, 0, 0, 1, 0, 0]);
const samples = (count, fps) => Array.from({ length: count }, (_, i) => ({ data: Uint8Array.from({ length: 10 + (i % 7) }, (_, j) => (i + j) & 0xff), key: i % fps === 0 }));

test("an MP4 of 150 samples at 30 a second: header first, constant rate, 5 seconds, key frames where they were, data where the tables say", () => {
  const given = samples(150, 30);
  const file = muxMp4({ width: 1080, height: 1920, fps: 30, avcC: AVCC, samples: given });
  const mp4 = readMp4(file);
  assert.deepEqual(mp4.order, ["ftyp", "moov", "mdat"]);
  assert.equal(mp4.codec, "avc1");
  assert.deepEqual([mp4.width, mp4.height], [1080, 1920]);
  assert.deepEqual([mp4.profile, mp4.level], [100, 40]);
  assert.equal(mp4.frames, 150);
  assert.deepEqual(mp4.timeEntries, [[150, 1000]], "one entry: every sample lasts the same");
  assert.equal(mp4.fps, 30);
  assert.equal(mp4.duration, 5);
  assert.equal(mp4.movieDuration, 5);
  assert.deepEqual(mp4.keys, [1, 31, 61, 91, 121]);
  assert.ok(mp4.dataInPlace);
  assert.equal(mp4.chunks, 5, "a chunk a second");
  for (const i of [0, 1, 29, 30, 77, 149]) assert.deepEqual(new Uint8Array(mp4.sample(i)), given[i].data, `sample ${i}`);
  assert.ok(mp4.avcC.equals(Buffer.from(AVCC)));
  // No edit list, nothing about the machine or the time.
  assert.ok(!file.includes(Buffer.from("elst")) && !file.includes(Buffer.from("udta")));
  // The same samples, the same bytes.
  assert.ok(file.equals(muxMp4({ width: 1080, height: 1920, fps: 30, avcC: AVCC, samples: samples(150, 30) })));
});

test("other rates and sizes: 1 and 60 a second, 72 × 26 by 16 × 26", () => {
  for (const fps of [1, 24, 25, 60]) {
    const mp4 = readMp4(muxMp4({ width: 1872, height: 416, fps, avcC: AVCC, samples: samples(fps * 3, fps) }));
    assert.equal(mp4.fps, fps);
    assert.equal(mp4.duration, 3);
    assert.deepEqual([mp4.width, mp4.height], [1872, 416]);
  }
});

test("refused: no samples, a first sample that is not a key frame; boxes that run past the end are an error", () => {
  assert.throws(() => muxMp4({ width: 2, height: 2, fps: 30, avcC: AVCC, samples: [] }), RangeError);
  assert.throws(() => muxMp4({ width: 2, height: 2, fps: 30, avcC: AVCC, samples: [{ data: new Uint8Array(1), key: false }] }), RangeError);
  assert.throws(() => boxes(Buffer.from([0, 0, 0, 99, 0x66, 0x72, 0x65, 0x65])), /past its end/);
});

test("the audio track: AAC-LC, 48 kHz, stereo, silence that covers the video, interleaved with it a second at a time", () => {
  const mp4 = readMp4(muxMp4({ width: 1080, height: 1920, fps: 30, avcC: AVCC, samples: samples(150, 30) }));
  assert.deepEqual(mp4.tracks, ["vide", "soun"]);
  const { audio } = mp4;
  assert.equal(audio.codec, "mp4a");
  assert.equal(audio.objectType, 0x40, "MPEG-4 audio");
  assert.deepEqual([...audio.config], [0x11, 0x90], "AudioSpecificConfig: AAC LC, 48 kHz, two channels");
  assert.deepEqual([audio.sampleRate, audio.channels, audio.timescale], [48000, 2, 48000]);
  assert.equal(audio.frames, Math.ceil((5 * 48000) / 1024));
  assert.deepEqual(audio.timeEntries, [[audio.frames, 1024]]);
  assert.ok(audio.duration >= mp4.duration && audio.duration - mp4.duration < 1024 / 48000, `${audio.duration} s of sound for ${mp4.duration} s of picture`);
  assert.equal(audio.chunks, 5);
  for (const i of [0, 46, 47, audio.frames - 1]) assert.deepEqual([...audio.sample(i)], SILENT_FRAME, `frame ${i}`);
  assert.equal(mp4.movieDuration, 5, "the movie is as long as its picture");
  assert.equal(SILENCE.sampleRate, 48000);
});

test("the audio's chunks at every rate and length: none empty, every frame where the tables say; without silence, the video alone", () => {
  for (const fps of [1, 24, 25, 30, 50, 60]) {
    for (const count of [1, 2, fps - 1, fps, fps + 1, fps * 3 + 1]) {
      if (count < 1) continue;
      const mp4 = readMp4(muxMp4({ width: 64, height: 32, fps, avcC: AVCC, samples: samples(count, fps) }));
      assert.ok(mp4.dataInPlace, `${count} at ${fps}`);
      assert.equal(mp4.audio.frames, Math.ceil((count * 48000) / fps / 1024), `${count} at ${fps}`);
      assert.ok(mp4.audio.duration >= mp4.duration, `${count} at ${fps}`);
    }
  }
  const alone = muxMp4({ width: 64, height: 32, fps: 30, avcC: AVCC, samples: samples(45, 30), silence: false });
  const mp4 = readMp4(alone);
  assert.deepEqual([mp4.tracks, mp4.audio, mp4.dataInPlace], [["vide"], null, true]);
  assert.ok(!alone.includes(Buffer.from("mp4a")));
});

test("the SPS read for its size and range: the avcC of real clips (Chromium's hardware encoder on macOS)", () => {
  // A window at 2360×1464 from raw BGRA (full range, as before 12.11), a post from a canvas, a window drawn on a canvas.
  const cases = [
    ["01640032ffe1001127640032ac56802500b9e5966e021a020401000428ee3cb0fdf8f800", { profile: 100, width: 2360, height: 1464, fullRange: true }],
    ["01640028ffe1001027640028ac56804403c7979a8086808101000428ee3cb0fdf8f800", { profile: 100, width: 1080, height: 1920, fullRange: false }],
    ["01640028ffe1001127640028ac56806d0227b966a021a0204001000428ee3cb0fdf8f800", { profile: 100, width: 1740, height: 1080, fullRange: false }],
  ];
  for (const [hex, facts] of cases) assert.deepEqual(spsFacts(Buffer.from(hex, "hex")), facts, hex);
  assert.equal(spsFacts(AVCC), null, "no SPS in it");
});
