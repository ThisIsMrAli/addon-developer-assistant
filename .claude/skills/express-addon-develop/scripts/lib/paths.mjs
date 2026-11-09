import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const developRoot = path.resolve(here, "../..");
export const reviewRoot = path.resolve(developRoot, "../express-addon-review");
export const liveDir = path.join(reviewRoot, "references", "live");
export const reviewScripts = path.join(reviewRoot, "scripts");

export const homeDir = path.join(os.homedir(), ".express-addon-develop");
const pointer = path.join(homeDir, "current.json");

export function rememberOut(out) {
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(pointer, `${JSON.stringify({ out, at: new Date().toISOString() })}\n`);
}

export function rememberedOut() {
  try {
    const last = JSON.parse(fs.readFileSync(pointer, "utf8")).out;
    return last && fs.existsSync(last) ? last : null;
  } catch {
    return null;
  }
}
