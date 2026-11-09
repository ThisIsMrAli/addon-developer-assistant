#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { rememberedOut, reviewScripts } from "./lib/paths.mjs";

const args = process.argv.slice(2);
if (!args.includes("--out") && !process.env.EXPRESS_REVIEW_OUT && !process.env.EXPRESS_DEVELOP_OUT) {
  const out = rememberedOut();
  if (out) args.push("--out", out);
}
const result = spawnSync(process.execPath, [path.join(reviewScripts, "session.mjs"), ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
