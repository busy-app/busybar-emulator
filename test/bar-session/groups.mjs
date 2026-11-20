// The groups of the BUSY Bar session, in the order a session runs them: what risks nothing first, what needs a person in
// the middle, what may restart the BUSY Bar last. `minutes`: about how long each takes on a BUSY Bar with every part
// allowed (the trial runs against an emulator, 18.11, and the BUSY Bar's own times: restarts of 30-60 s, HTTPS of 1.5 s).
import emu344 from "./groups/emu-344.mjs";
import emu347 from "./groups/emu-347.mjs";
import emu348 from "./groups/emu-348.mjs";
import emu349 from "./groups/emu-349.mjs";
import emu350 from "./groups/emu-350.mjs";
import emu351 from "./groups/emu-351.mjs";
import emu352 from "./groups/emu-352.mjs";
import emu353 from "./groups/emu-353.mjs";
import emu354 from "./groups/emu-354.mjs";
import emu355 from "./groups/emu-355.mjs";
import emu363 from "./groups/emu-363.mjs";

export const GROUPS = [
  { ...emu347, minutes: 1, parts: ["names"] },
  { ...emu348, minutes: 4, parts: ["golden", "state", "timed"] },
  { ...emu351, minutes: 6, parts: ["record", "network", "body", "big-text (heap, reboot)"] },
  { ...emu355, minutes: 1, parts: ["sound"] },
  { ...emu354, minutes: 3, parts: ["chars", "empty-snd", "refused", "playing", "records-1.3.1 (a BUSY Bar on 1.3.1)"] },
  { ...emu352, minutes: 2, parts: ["timers", "persist", "storage-64k (heap, reboot)", "clear-then-timeout", "clear-then-fetch (reboot)"] },
  { ...emu353, minutes: 2, parts: ["lights (person)"] },
  { ...emu349, minutes: 3, parts: ["short", "held", "wheel", "back-exit (person)", "back-start (person; reboot)"] },
  { ...emu344, minutes: 1, parts: ["speed (the standard BUSY Bar)"] },
  { ...emu363, minutes: 1, parts: ["inline (reboot)", "named (reboot)"] },
  { ...emu350, minutes: 8, parts: ["golden", "failures", "oom-early (heap, reboot)", "oom-late (heap, reboot)", "json (heap, reboot)"] },
];

export const groupOf = (id) => GROUPS.find((g) => g.id === id);
