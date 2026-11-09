import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("a helper next to this file resolves when the working directory is somewhere else", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(fs.existsSync(path.join(here, "helpers.mjs")), true);
});
