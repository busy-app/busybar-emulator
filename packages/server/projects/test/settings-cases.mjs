// Settings files the firmware refuses, each with the field at fault and the firmware's words for it: [fields, field,
// problem]. Two tests share them: settings-schema.test.mjs holds the emulator's own check to them, and
// emulator/test/server/agent-hands.test.mjs launches an app with each on the emulated bar and reads what the
// firmware's parser itself logs.
export const BROKEN = [
  [{ a: { type: "select", label: "A", default: "x" } }, "a", "unknown type 'select'"],
  [{ a: { type: "boolean", default: true } }, "a", "key 'label' is missing"],
  [{ a: { type: "boolean", label: "A" } }, "a", "key 'default' is missing"],
  [{ a: { type: "boolean", label: "A", default: "yes" } }, "a", "key 'default' has type string (boolean was expected)"],
  [{ a: { type: "enum", label: "A", default: "x" } }, "a", "key 'options' is missing"],
  [{ a: { type: "enum", label: "A", default: "x", options: ["x", "y"] } }, "a", "key 'value' is missing"],
  [{ a: { type: "enum", label: "A", default: "z", options: [{ value: "x", label: "X" }] } }, "a", "default 'z' is not among the options"],
  [{ a: { type: "enum", label: "A", default: "x", options: [{ value: "x", label: "X" }, { value: "x", label: "Y" }] } }, "a", "duplicate enum option value 'x'"],
  [{ a: { type: "enum", label: "A", default: "x", options: [] } }, "a", "key 'options' must contain between 1 and 32 items"],
  [{ a: { type: "integer", label: "A", default: 5, min: 10, max: 1 } }, "a", "'min' is greater than 'max'"],
  [{ a: { type: "integer", label: "A", default: 50, min: 0, max: 10 } }, "a", "default is out of bounds"],
  [{ a: { type: "integer", label: "A", default: 0, min: 0, max: 10, step: 3 } }, "a", "'max' - 'min' must be evenly divisible by 'step'"],
  [{ a: { type: "integer", label: "A", default: 0, step: 0 } }, "a", "key 'step' must be a non-zero integer"],
  [{ a: { type: "string", label: "A", default: "0123456789", max_length: 4 } }, "a", "default length is out of bounds"],
  [{ a: { type: "string", label: "A", default: "", max_length: 300 } }, "a", "'max_length' is greater than 255"],
  [{ a: { type: "color", label: "A", default: "red" } }, "a", "default must be a '#RRGGBB' or '#RRGGBBAA' color"],
  [{ a: { type: "time", label: "A", default: "25:00" } }, "a", "default must be a 'HH:MM' or 'HH:MM:SS' time"],
  [{ a: { type: "geolocation", label: "A", default: { mode: "here", name: "X" } } }, "a", "key 'mode' must be 'auto' or 'fixed', got 'here'"],
  [{ a: { type: "geolocation", label: "A", default: { mode: "fixed", name: "X" } } }, "a", "invalid default value"],
  [{ a: { type: "group", label: "A", fields: {} } }, "a", "group has no fields"],
  [{ g: { type: "group", label: "G", fields: { inner: { type: "boolean", label: "I" } } } }, "g.inner", "key 'default' is missing"],
  [{ Bad: { type: "boolean", label: "A", default: true } }, "Bad", "invalid id format"],
];

