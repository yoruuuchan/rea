import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
const input = JSON.parse(process.env.REA_TEST_MANAGED_PUBLICATION ?? "null");
assert.ok(
  input && typeof input.prefix === "string" && typeof input.marker === "string",
);
assert.ok(["SIGINT", "SIGTERM"].includes(input.signal));
assert.ok(["event", "os"].includes(input.delivery));
const require = createRequire(import.meta.url);
const fs = require("node:fs/promises");
const remove = fs.rmdir;
let queued = false;
fs.rmdir = async (...arguments_) => {
  const result = await remove(...arguments_);
  if (!queued && String(arguments_[0]).startsWith(input.prefix)) {
    queued = true;
    setImmediate(() => {
      writeFileSync(
        input.marker,
        JSON.stringify({
          signal: input.signal,
          delivery: input.delivery,
          listeners: process.listenerCount(input.signal),
        }),
      );
      if (input.delivery === "os") process.kill(process.pid, input.signal);
      else process.emit(input.signal);
    });
  }
  return result;
};
syncBuiltinESMExports();
