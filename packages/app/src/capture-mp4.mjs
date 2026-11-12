// An MP4 file from H.264 samples (busy-emulator record, ADR-0007): the box writer of the clip, in the main process,
// with nothing from outside. One video track and one audio track of silence, the header (moov) before the data, the
// data interleaved a second at a time, a constant frame rate written as one entry of time to sample, no B-frames (the
// page checks that the encoder gives its samples in order), no edit list, no time of creation, no name of a program:
// the same samples give the same bytes. `readMp4` reads back what a test needs to know of a file.
//
// The audio track: AAC-LC, 48 kHz, stereo, every frame the same six bytes of silence (a channel pair with no
// spectrum). The clip has no sound, but the networks' upload specifications name an AAC track (Instagram's Reels,
// Facebook's, X's), some processing of a clip without one is known to fail, and ADR-0007's preset has a track always.

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function box(type, ...parts) {
  const body = Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

const full = (type, version, flags, ...parts) => box(type, u32((version << 24) | flags), ...parts);

function u32(...values) {
  const out = Buffer.alloc(4 * values.length);
  values.forEach((value, i) => out.writeUInt32BE(value >>> 0, i * 4));
  return out;
}

function u16(...values) {
  const out = Buffer.alloc(2 * values.length);
  values.forEach((value, i) => out.writeUInt16BE(value & 0xffff, i * 2));
  return out;
}

/** AAC-LC at 48 kHz, stereo: 1024 samples a frame. */
export const SILENCE = Object.freeze({ sampleRate: 48000, channels: 2, frameSamples: 1024 });
// One raw AAC-LC frame of silence for a channel pair: CPE (tag 0) with a common long window, max_sfb 0, no M/S, then
// for each channel global_gain 0 and no pulse, TNS or gain control data; END; zero bits to the byte. 46 bits.
export const SILENT_FRAME = Object.freeze([0x21, 0x00, 0x00, 0x00, 0x00, 0x1c]);
// AudioSpecificConfig: object type 2 (AAC LC), frequency index 3 (48 kHz), channel configuration 2.
const AUDIO_CONFIG = [0x11, 0x90];

/** The esds box of the audio track: ES_Descriptor, DecoderConfigDescriptor (MPEG-4 audio), its specific info, SL. */
function esds() {
  const bitrate = Math.round((SILENT_FRAME.length * 8 * SILENCE.sampleRate) / SILENCE.frameSamples);
  const descriptor = (tag, ...parts) => {
    const body = Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
    return Buffer.concat([Buffer.from([tag, body.length]), body]);
  };
  const decoderConfig = descriptor(0x04, [0x40, 0x15, 0, 0, 0], u32(bitrate, bitrate), descriptor(0x05, AUDIO_CONFIG));
  return full("esds", 0, 0, descriptor(0x03, u16(0), [0], decoderConfig, descriptor(0x06, [0x02])));
}

/** stsc from the number of samples in each chunk: an entry where the number changes. */
function stscOf(perChunk) {
  const entries = [];
  perChunk.forEach((count, i) => {
    if (!entries.length || entries.at(-1)[1] !== count) entries.push([i + 1, count, 1]);
  });
  return full("stsc", 0, 0, u32(entries.length, ...entries.flat()));
}

/**
 * @param {object} o
 * @param {number} o.width
 * @param {number} o.height
 * @param {number} o.fps            frames a second, a whole number
 * @param {Uint8Array} o.avcC       the decoder's configuration, as WebCodecs gives it with avc.format "avc"
 * @param {{ data: Uint8Array, key: boolean }[]} o.samples  in decoding order, which is the order of display
 * @param {boolean} [o.silence]     the audio track of silence (true); false writes the video track alone
 * @returns {Buffer}
 */
export function muxMp4({ width, height, fps, avcC, samples, silence = true }) {
  if (!samples.length) throw new RangeError("an MP4 needs at least one sample");
  if (!samples[0].key) throw new RangeError("the first sample must be a key frame");
  const timescale = fps * 1000;
  const delta = 1000;
  const movieDuration = Math.round((samples.length * 1000) / fps); // in mvhd's timescale, 1000
  const ftyp = box("ftyp", Buffer.from("isom", "latin1"), u32(0x200), Buffer.from("isomiso2avc1mp41", "latin1"));

  // A second of each track to a chunk: the video's fps samples, then the audio frames that end within that second.
  // The audio covers the video: as many frames as reach its end, the last one a part of a frame past it.
  const seconds = Math.ceil(samples.length / fps);
  const videoChunks = Array.from({ length: seconds }, (_, k) => Math.min(fps, samples.length - k * fps));
  const audioFrames = silence ? Math.ceil((samples.length * SILENCE.sampleRate) / fps / SILENCE.frameSamples) : 0;
  const audioUpTo = (k) => (k >= seconds ? audioFrames : Math.min(audioFrames, Math.ceil((k * SILENCE.sampleRate) / SILENCE.frameSamples)));
  // At more than 46 frames a second the last second's video may end before another audio frame starts: no chunk then.
  const audioChunks = silence ? Array.from({ length: seconds }, (_, k) => audioUpTo(k + 1) - audioUpTo(k)) : [];
  const videoData = samples.map((s) => Buffer.from(s.data.buffer, s.data.byteOffset, s.data.byteLength));
  const frame = Buffer.from(SILENT_FRAME);

  // The data, in order: for each second its video, then its audio; and where each chunk starts within the data.
  const parts = [];
  const videoOffsets = [];
  const audioOffsets = [];
  let at = 0;
  for (let k = 0, v = 0; k < seconds; k++) {
    videoOffsets.push(at);
    for (let n = 0; n < videoChunks[k]; n++, v++) {
      parts.push(videoData[v]);
      at += videoData[v].length;
    }
    if (!audioChunks[k]) continue;
    audioOffsets.push(at);
    for (let n = 0; n < audioChunks[k]; n++) parts.push(frame);
    at += audioChunks[k] * frame.length;
  }

  const moovWith = (base) => {
    const avc1 = box(
      "avc1",
      Buffer.alloc(6),
      u16(1), // data reference index
      Buffer.alloc(16),
      u16(width, height),
      u32(0x00480000, 0x00480000, 0),
      u16(1),
      Buffer.alloc(32),
      u16(0x0018, 0xffff),
      box("avcC", Buffer.from(avcC)),
    );
    const dinf = box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1)));
    const stbl = box(
      "stbl",
      full("stsd", 0, 0, u32(1), avc1),
      full("stts", 0, 0, u32(1, samples.length, delta)),
      full("stss", 0, 0, u32(samples.filter((s) => s.key).length, ...samples.flatMap((s, i) => (s.key ? [i + 1] : [])))),
      stscOf(videoChunks),
      full("stsz", 0, 0, u32(0, samples.length, ...samples.map((s) => s.data.length))),
      full("stco", 0, 0, u32(videoOffsets.length, ...videoOffsets.map((o) => base + o))),
    );
    const minf = box("minf", full("vmhd", 0, 1, u16(0, 0, 0, 0)), dinf, stbl);
    const mdia = box(
      "mdia",
      full("mdhd", 0, 0, u32(0, 0, timescale, samples.length * delta), u16(0x55c4, 0)), // language "und"
      full("hdlr", 0, 0, u32(0), Buffer.from("vide", "latin1"), u32(0, 0, 0), Buffer.from("VideoHandler\0", "latin1")),
      minf,
    );
    const tkhd = full("tkhd", 0, 3, u32(0, 0, 1, 0, movieDuration, 0, 0), u16(0, 0, 0, 0), u32(...MATRIX, width << 16, height << 16));
    const traks = [box("trak", tkhd, mdia)];
    if (silence) {
      const mp4a = box("mp4a", Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(SILENCE.channels, 16, 0, 0), u32(SILENCE.sampleRate * 0x10000), esds());
      const audioStbl = box(
        "stbl",
        full("stsd", 0, 0, u32(1), mp4a),
        full("stts", 0, 0, u32(1, audioFrames, SILENCE.frameSamples)),
        stscOf(audioChunks.filter(Boolean)),
        full("stsz", 0, 0, u32(frame.length, audioFrames)),
        full("stco", 0, 0, u32(audioOffsets.length, ...audioOffsets.map((o) => base + o))),
      );
      const audioDuration = Math.round((audioFrames * SILENCE.frameSamples * 1000) / SILENCE.sampleRate);
      traks.push(
        box(
          "trak",
          full("tkhd", 0, 3, u32(0, 0, 2, 0, audioDuration, 0, 0), u16(0, 1, 0x0100, 0), u32(...MATRIX, 0, 0)),
          box(
            "mdia",
            full("mdhd", 0, 0, u32(0, 0, SILENCE.sampleRate, audioFrames * SILENCE.frameSamples), u16(0x55c4, 0)),
            full("hdlr", 0, 0, u32(0), Buffer.from("soun", "latin1"), u32(0, 0, 0), Buffer.from("SoundHandler\0", "latin1")),
            box("minf", full("smhd", 0, 0, u16(0, 0)), dinf, audioStbl),
          ),
        ),
      );
    }
    const mvhd = full("mvhd", 0, 0, u32(0, 0, 1000, movieDuration, 0x00010000), u16(0x0100, 0), u32(0, 0, ...MATRIX, 0, 0, 0, 0, 0, 0, traks.length + 1));
    return box("moov", mvhd, ...traks);
  };
  const size = moovWith(0).length;
  const moov = moovWith(ftyp.length + size + 8);
  const mdatHead = Buffer.alloc(8);
  mdatHead.writeUInt32BE(at + 8, 0);
  mdatHead.write("mdat", 4, "latin1");
  return Buffer.concat([ftyp, moov, mdatHead, ...parts]);
}

/** The boxes of a file at the top level, or of a box's body: [{ type, start, end, body }]. */
export function boxes(bytes, start = 0, end = bytes.length) {
  const out = [];
  for (let at = start; at + 8 <= end; ) {
    const size = bytes.readUInt32BE(at);
    if (size < 8 || at + size > end) throw new Error(`a box at ${at} runs past its end`);
    out.push({ type: bytes.toString("latin1", at + 4, at + 8), start: at, end: at + size, body: at + 8 });
    at += size;
  }
  return out;
}

/**
 * What the first SPS of an avcC says of the picture: its size and whether its samples are full range (yuvj420p, from
 * the VUI's video_full_range_flag) or video range (yuv420p). null where the SPS holds what this reader does not follow
 * (scaling matrices, picture order type 1).
 */
export function spsFacts(avcC) {
  const config = Buffer.from(avcC);
  if (config.length < 8 || (config[5] & 0x1f) < 1) return null;
  const length = config.readUInt16BE(6);
  const raw = config.subarray(8, 8 + length);
  if (raw.length < 4) return null;
  // The NAL unit's bytes without its emulation prevention bytes (00 00 03).
  const bytes = [];
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === 3 && bytes.length >= 2 && bytes.at(-1) === 0 && bytes.at(-2) === 0) continue;
    bytes.push(raw[i]);
  }
  let bit = 0;
  const one = () => (bytes[bit >> 3] >> (7 - (bit++ & 7))) & 1;
  const bits = (n) => Array.from({ length: n }).reduce((value) => value * 2 + one(), 0);
  const ue = () => {
    let zeros = 0;
    while (one() === 0 && zeros < 32) zeros++;
    return 2 ** zeros - 1 + bits(zeros);
  };
  const profile = bits(8);
  bits(16); // constraints, level
  ue(); // seq_parameter_set_id
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = ue();
    if (chroma === 3) one();
    ue();
    ue();
    one();
    if (one()) return null; // seq_scaling_matrix_present
  }
  ue(); // log2_max_frame_num_minus4
  const order = ue();
  if (order === 0) ue();
  else if (order === 1) return null;
  ue(); // max_num_ref_frames
  one();
  const widthMbs = ue() + 1;
  const heightUnits = ue() + 1;
  const frameOnly = one();
  if (!frameOnly) one();
  one(); // direct_8x8_inference
  const crop = one() ? [ue(), ue(), ue(), ue()] : [0, 0, 0, 0];
  const unitX = chroma === 0 || chroma === 3 ? 1 : 2;
  const unitY = (chroma === 1 ? 2 : 1) * (2 - frameOnly);
  const width = widthMbs * 16 - unitX * (crop[0] + crop[1]);
  const height = heightUnits * 16 * (2 - frameOnly) - unitY * (crop[2] + crop[3]);
  let fullRange = false; // without the VUI's signal type, video range
  if (one()) {
    if (one() && bits(8) === 255) bits(32); // aspect_ratio_info
    if (one()) one(); // overscan
    if (one()) {
      bits(3);
      fullRange = one() === 1;
    }
  }
  return { profile, width, height, fullRange };
}

/** Where each sample of a track lies in the file, from its stsc, stsz and stco. */
function sampleRanges(bytes, stbl, inside, find) {
  const stsz = find(inside(stbl), "stsz");
  const stsc = find(inside(stbl), "stsc");
  const stco = find(inside(stbl), "stco");
  const fixed = bytes.readUInt32BE(stsz.body + 4);
  const count = bytes.readUInt32BE(stsz.body + 8);
  const sizes = Array.from({ length: count }, (_, i) => (fixed ? fixed : bytes.readUInt32BE(stsz.body + 12 + 4 * i)));
  const chunks = Array.from({ length: bytes.readUInt32BE(stco.body + 4) }, (_, i) => bytes.readUInt32BE(stco.body + 8 + 4 * i));
  const entries = Array.from({ length: bytes.readUInt32BE(stsc.body + 4) }, (_, i) => [bytes.readUInt32BE(stsc.body + 8 + 12 * i), bytes.readUInt32BE(stsc.body + 12 + 12 * i)]);
  const ranges = [];
  let sample = 0;
  chunks.forEach((offset, c) => {
    const per = entries.filter(([first]) => first <= c + 1).at(-1)?.[1] ?? 0;
    for (let n = 0, at = offset; n < per && sample < count; n++, sample++) {
      ranges.push([at, at + sizes[sample]]);
      at += sizes[sample];
    }
  });
  return { sizes, chunks: chunks.length, ranges, complete: sample === count };
}

/**
 * What a test needs to know of an MP4 with one H.264 track and, maybe, one AAC track: order of the top-level boxes,
 * size, frame rate, the samples' sizes, which are key frames, profile and level from avcC, the audio track's facts, and
 * whether the data lies where the tables say: every sample of both tracks inside mdat, mdat holding nothing else.
 */
export function readMp4(bytes) {
  bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const top = boxes(bytes);
  const find = (list, type) => list.find((b) => b.type === type) ?? null;
  const inside = (b) => boxes(bytes, b.body, b.end);
  const path = (b, ...types) => types.reduce((at, type) => (at ? find(inside(at), type) : null), b);
  const moov = find(top, "moov");
  const mvhd = path(moov, "mvhd");
  const traks = inside(moov).filter((b) => b.type === "trak");
  const handler = (trak) => bytes.toString("latin1", path(trak, "mdia", "hdlr").body + 8, path(trak, "mdia", "hdlr").body + 12);
  const trak = traks.find((t) => handler(t) === "vide");
  const sound = traks.find((t) => handler(t) === "soun") ?? null;
  const mdhd = path(trak, "mdia", "mdhd");
  const stbl = path(trak, "mdia", "minf", "stbl");
  const stsd = path(stbl, "stsd");
  const entry = boxes(bytes, stsd.body + 8, stsd.end)[0];
  const avcC = boxes(bytes, entry.body + 78, entry.end).find((b) => b.type === "avcC");
  const stts = path(stbl, "stts");
  const stss = path(stbl, "stss");
  const video = sampleRanges(bytes, stbl, inside, find);
  const timeEntries = Array.from({ length: bytes.readUInt32BE(stts.body + 4) }, (_, i) => [bytes.readUInt32BE(stts.body + 8 + 8 * i), bytes.readUInt32BE(stts.body + 12 + 8 * i)]);
  const keys = stss ? Array.from({ length: bytes.readUInt32BE(stss.body + 4) }, (_, i) => bytes.readUInt32BE(stss.body + 8 + 4 * i)) : null;
  const mdat = find(top, "mdat");
  const timescale = bytes.readUInt32BE(mdhd.body + 12);
  const mediaDuration = bytes.readUInt32BE(mdhd.body + 16);
  const config = bytes.subarray(avcC.body, avcC.end);

  let audio = null;
  let audioRanges = [];
  if (sound) {
    const aStbl = path(sound, "mdia", "minf", "stbl");
    const aStsd = path(aStbl, "stsd");
    const aEntry = boxes(bytes, aStsd.body + 8, aStsd.end)[0];
    const aMdhd = path(sound, "mdia", "mdhd");
    const aStts = path(aStbl, "stts");
    const esdsBox = boxes(bytes, aEntry.body + 28, aEntry.end).find((b) => b.type === "esds");
    const esdsBody = bytes.subarray(esdsBox.body + 4, esdsBox.end);
    const at = esdsBody.indexOf(Buffer.from([0x05, 0x02]));
    const aTimescale = bytes.readUInt32BE(aMdhd.body + 12);
    const ranges = sampleRanges(bytes, aStbl, inside, find);
    audioRanges = ranges.ranges;
    audio = {
      codec: aEntry.type,
      channels: bytes.readUInt16BE(aEntry.body + 16),
      sampleRate: bytes.readUInt32BE(aEntry.body + 24) >>> 16,
      objectType: esdsBody[esdsBody.indexOf(0x04) + 2],
      config: at >= 0 ? Buffer.from(esdsBody.subarray(at + 2, at + 4)) : null,
      timescale: aTimescale,
      duration: bytes.readUInt32BE(aMdhd.body + 16) / aTimescale,
      timeEntries: Array.from({ length: bytes.readUInt32BE(aStts.body + 4) }, (_, i) => [bytes.readUInt32BE(aStts.body + 8 + 8 * i), bytes.readUInt32BE(aStts.body + 12 + 8 * i)]),
      frames: ranges.sizes.length,
      chunks: ranges.chunks,
      sample: (i) => bytes.subarray(...audioRanges[i]),
    };
  }
  const all = [...video.ranges, ...audioRanges].sort((a, b) => a[0] - b[0]);
  const contiguous = all.every(([start], i) => start === (i === 0 ? mdat.body : all[i - 1][1]));
  return {
    order: top.map((b) => b.type),
    tracks: traks.map(handler),
    codec: entry.type,
    width: bytes.readUInt16BE(entry.body + 24),
    height: bytes.readUInt16BE(entry.body + 26),
    profile: config[1],
    level: config[3],
    timescale,
    duration: mediaDuration / timescale,
    movieDuration: bytes.readUInt32BE(mvhd.body + 16) / bytes.readUInt32BE(mvhd.body + 12),
    timeEntries,
    fps: timeEntries.length === 1 ? timescale / timeEntries[0][1] : null,
    frames: video.sizes.length,
    chunks: video.chunks,
    sizes: video.sizes,
    keys,
    dataInPlace: video.complete && (!sound || audio.frames === audioRanges.length) && contiguous && all.at(-1)[1] === mdat.end,
    avcC: Buffer.from(config),
    fullRange: spsFacts(config)?.fullRange ?? null,
    audio,
    sample: (i) => bytes.subarray(...video.ranges[i]),
  };
}
