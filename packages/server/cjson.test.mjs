// cjsonPrint() against what the firmware's own cJSON prints. The expected strings were printed by cJSON_Print() of
// busybar-firmware/lib/cjson/cJSON.c (1.7.18, firmware 1.3.1 8edd2da4) compiled with clang on macOS, from the JSON on
// the left (EMU-232). Run: node --test emulator/packages/server/cjson.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { cjsonPrint } from "./cjson.mjs";

const PRINTED = [
  // An app's settings document as GET /api/apps/settings gives it (the bar's answer recorded 10.11, firmware 1.3.1).
  ['{"version":1,"values":{"label":"hello","count":3,"flag":false}}', '{\n\t"version":\t1,\n\t"values":\t{\n\t\t"label":\t"hello",\n\t\t"count":\t3,\n\t\t"flag":\tfalse\n\t}\n}'],
  ['{"version":1,"values":{"label":"ünï","count":1,"flag":true}}', '{\n\t"version":\t1,\n\t"values":\t{\n\t\t"label":\t"ünï",\n\t\t"count":\t1,\n\t\t"flag":\ttrue\n\t}\n}'],
  ['{"version":2,"values":{}}', '{\n\t"version":\t2,\n\t"values":\t{\n\t}\n}'],
  ["{}", "{\n}"],
  ["[]", "[]"],
  ['{"a":{"b":{}}}', '{\n\t"a":\t{\n\t\t"b":\t{\n\t\t}\n\t}\n}'],
  [
    '{"version":1,"values":{"group":{"inner":{"x":1,"y":"two"},"z":[1,2,{"q":3}]},"loc":{"mode":"fixed","name":"Somewhere","x":12.5,"y":-65.25}}}',
    '{\n\t"version":\t1,\n\t"values":\t{\n\t\t"group":\t{\n\t\t\t"inner":\t{\n\t\t\t\t"x":\t1,\n\t\t\t\t"y":\t"two"\n\t\t\t},\n\t\t\t"z":\t[1, 2, {\n\t\t\t\t\t"q":\t3\n\t\t\t\t}]\n\t\t},\n\t\t"loc":\t{\n\t\t\t"mode":\t"fixed",\n\t\t\t"name":\t"Somewhere",\n\t\t\t"x":\t12.5,\n\t\t\t"y":\t-65.25\n\t\t}\n\t}\n}',
  ],
  ['[1,"a",true,false,null,{"k":[2,3]},[[]]]', '[1, "a", true, false, null, {\n\t\t"k":\t[2, 3]\n\t}, [[]]]'],
  ['{"s":"quote\\" back\\\\ slash/ \\b\\f\\n\\r\\t \\u0001 \\u001f \\u007f end"}', '{\n\t"s":\t"quote\\" back\\\\ slash/ \\b\\f\\n\\r\\t \\u0001 \\u001f \u007f end"\n}'],
  ['{"s":"emoji 😀 greek όνομα"}', '{\n\t"s":\t"emoji 😀 greek όνομα"\n}'],
  // Numbers: "%d" for what an int holds, else "%1.15g", or "%1.17g" when 15 digits do not give the number back.
  [
    "[0,-0,1,-1,2147483647,-2147483648,2147483648,-2147483649,1.5,-1.5,0.1,0.30000000000000004,1e-5,0.0001,0.00012345,1e21,1e15,1e16,123456789012,12.3456,-98.7654,0.3333333333333333,5e-324,1.7976931348623157e308,12345.678901234567,0.7999999999999999,100.0,1234567890123456789]",
    "[0, 0, 1, -1, 2147483647, -2147483648, 2147483648, -2147483649, 1.5, -1.5, 0.1, 0.3, 1e-05, 0.0001, 0.00012345, 1e+21, 1e+15, 1e+16, 123456789012, 12.3456, -98.7654, 0.33333333333333331, 4.94065645841247e-324, 1.79769313486232e+308, 12345.678901234567, 0.8, 100, 1.2345678901234568e+18]",
  ],
];

test("cjsonPrint prints JSON as the firmware's cJSON_Print does", () => {
  for (const [json, printed] of PRINTED) assert.equal(cjsonPrint(JSON.parse(json)), printed, json);
});
