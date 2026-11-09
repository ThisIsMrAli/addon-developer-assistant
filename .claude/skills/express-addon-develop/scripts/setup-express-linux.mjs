#!/usr/bin/env node
/**
 * Trust the Adobe add-on dev CA for https://localhost:5241.
 * Does not open Adobe Express. Set EXPRESS_DEVELOP_SETUP_EXEC=0 to plan without apt or certutil.
 *
 *   node scripts/setup-express-linux.mjs [--out dir] [--ca file]
 */
import fs from "node:fs";
import path from "node:path";
import { reminder } from "../../express-addon-review/scripts/lib/next.mjs";
import { rememberedOut } from "./lib/paths.mjs";
import { trustDevcert } from "./lib/devcert.mjs";
import { patchDevelop } from "./lib/session-start.mjs";

const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.out || process.env.EXPRESS_DEVELOP_OUT || process.env.EXPRESS_REVIEW_OUT || rememberedOut() || "");
if (!out || !fs.existsSync(path.join(out, "session.json"))) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: "No develop session. Pass --out." })}\n`);
  process.exit(1);
}

const home = process.env.HOME;
const result = trustDevcert({
  home,
  ca: args.ca ? path.resolve(args.ca) : undefined,
  exec: process.env.EXPRESS_DEVELOP_SETUP_EXEC !== "0"
});
const record = { ...result, executed: result.exec === true };
fs.writeFileSync(path.join(out, "express-setup.json"), `${JSON.stringify(record, null, 2)}\n`);
patchDevelop(out, {
  expressSetup: record.ok === true,
  expressHostRan: false,
  expressPass: false
});
if (record.error) process.stderr.write(`${record.error}\n`);
const body = { ...record };
if (record.ok) body.next = reminder(out);
process.stdout.write(`${JSON.stringify(body)}\n`);
process.exit(record.exitCode);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}
