import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const developRoot = path.resolve(here, "../..");
export const reviewRoot = path.resolve(developRoot, "../express-addon-review");
export const liveDir = path.join(reviewRoot, "references", "live");
export const reviewScripts = path.join(reviewRoot, "scripts");

/** Read HOME at call time. `os.homedir()` caches the first value and ignores a later HOME. */
export function userHome() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function homeDir() {
  return path.join(userHome(), ".express-addon-develop");
}

function pointerFile() {
  return path.join(homeDir(), "current.json");
}

export function rememberOut(out) {
  const next = path.resolve(out);
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(pointerFile(), `${JSON.stringify({ out: next, at: new Date().toISOString() })}\n`);
}

export function rememberedOut() {
  try {
    const last = JSON.parse(fs.readFileSync(pointerFile(), "utf8")).out;
    return last && fs.existsSync(last) ? last : null;
  } catch {
    return null;
  }
}

