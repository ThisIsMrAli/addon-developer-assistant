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
  throw new Error("No review folder. Run review.mjs first, or pass --out.");
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
