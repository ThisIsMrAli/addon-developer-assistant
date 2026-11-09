import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const skillRoot = path.resolve(here, "../..");
export const liveDir = path.join(skillRoot, "references", "live");
export const assetsDir = path.join(skillRoot, "assets", "dashboard");

/** Reviews live outside the skill and outside the add-on, so neither folder collects output. */
export function userHome() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function homeDir() {
  return path.join(userHome(), ".express-addon-review");
}

function pointerFile() {
  return path.join(homeDir(), "current.json");
}

export function defaultOut(slug) {
  return path.join(homeDir(), slug);
}

export function rememberOut(out) {
  const next = path.resolve(out);
  let previous = "";
  try {
    previous = JSON.parse(fs.readFileSync(pointerFile(), "utf8")).out || "";
  } catch {
    previous = "";
  }
  if (previous && path.resolve(previous) !== next) stopDashboard(previous);
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(pointerFile(), `${JSON.stringify({ out: next, at: new Date().toISOString() })}\n`);
}

/** The folder the last review wrote, or null before any review has run. */
export function rememberedOut() {
  try {
    const last = JSON.parse(fs.readFileSync(pointerFile(), "utf8")).out;
    return last && fs.existsSync(last) ? last : null;
  } catch {
    return null;
  }
}

/** `--out`, then EXPRESS_REVIEW_OUT, then the folder the last review wrote. */
export function resolveOut(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.EXPRESS_REVIEW_OUT) return path.resolve(process.env.EXPRESS_REVIEW_OUT);
  const last = rememberedOut();
  if (last) return last;
  const develop = rememberedDevelopOut();
  if (develop) return develop;
  throw new Error("No review folder. Run review.mjs first, or pass --out.");
}

/** The develop skill remembers its own session folder; its dashboard is served by this script too. */
export function rememberedDevelopOut() {
  if (process.env.EXPRESS_DEVELOP_OUT && fs.existsSync(process.env.EXPRESS_DEVELOP_OUT)) return path.resolve(process.env.EXPRESS_DEVELOP_OUT);
  try {
    const last = JSON.parse(fs.readFileSync(path.join(userHome(), ".express-addon-develop", "current.json"), "utf8")).out;
    return last && fs.existsSync(last) ? last : null;
  } catch {
    return null;
  }
}

/** Every session folder this user's review and develop runs point at, newest pointers first, without repeats. */
export function knownOuts() {
  const list = [process.env.EXPRESS_REVIEW_OUT, rememberedOut(), process.env.EXPRESS_DEVELOP_OUT, rememberedDevelopOut()]
    .filter(Boolean)
    .map((item) => path.resolve(item));
  return [...new Set(list)];
}

function stopDashboard(out) {
  const file = path.join(out, "server.json");
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    if (info.pid) {
      try {
        process.kill(info.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  } catch {
    // No server record.
  }
  fs.rmSync(file, { force: true });
}
