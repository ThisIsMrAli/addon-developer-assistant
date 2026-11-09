import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Chromium-family browsers, best first. Any of them takes the same flags. */
export function chromeCandidates(platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    ];
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    const relative = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
      "Chromium\\Application\\chrome.exe"
    ];
    return roots.flatMap((root) => relative.map((name) => path.win32.join(root, name)));
  }
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];
  const dirs = String(env.PATH || "/usr/local/bin:/usr/bin:/bin:/snap/bin").split(path.delimiter).filter(Boolean);
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

/** `CHROME_PATH` wins. Returns null when nothing is installed. */
export function findChrome({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (env.CHROME_PATH && exists(env.CHROME_PATH)) return env.CHROME_PATH;
  return chromeCandidates(platform, env).find((candidate) => exists(candidate)) || null;
}

export const NO_CHROME =
  "No Chrome, Edge, or Chromium was found. Install one, or set CHROME_PATH to its executable.";

/** Photographs `url` at an exact viewport. Throws when no file comes out. */
export function shoot({ chrome, url, out, width, height, scale = 1, background = "FFFFFFFF", timeout = 60_000 }) {
  // A fresh profile stops a running Chrome from swallowing the command. On a brand-new
  // profile Chrome 156 can sit on the first-run dialog and never exit, so that attempt
  // is killed with its process group and, if it wrote nothing, retried without a profile.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "express-addon-review-chrome-"));
  fs.writeFileSync(path.join(profile, "First Run"), "");
  fs.rmSync(out, { force: true });
  const shared = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-fre",
    "--noerrdialogs",
    "--disable-search-engine-choice-screen",
    `--force-device-scale-factor=${scale}`,
    `--window-size=${width},${height}`,
    `--default-background-color=${background}`,
    `--screenshot=${out}`
  ];
  if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0) shared.unshift("--no-sandbox");
  const profileBudget = Math.min(timeout, 8000);
  try {
    const first = captureOnce(chrome, [...shared, `--user-data-dir=${profile}`, url], out, profileBudget);
    if (first === "wrote") return;
    fs.rmSync(out, { force: true });
    const second = captureOnce(chrome, [...shared, url], out, timeout);
    if (second === "wrote") return;
  } finally {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A profile left behind is not a failed picture.
    }
  }
  throw new Error(`Chrome at ${chrome} cannot run here: it did not write ${out}. It was started with --headless=new --screenshot.`);
}

function captureOnce(chrome, args, out, timeout) {
  const child = spawn(chrome, args, { stdio: "ignore", detached: true });
  const pid = child.pid;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (fileReady(out)) {
      killGroup(pid);
      return "wrote";
    }
    if (pid && !alive(pid)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  killGroup(pid);
  return fileReady(out) ? "wrote" : "timeout";
}

function fileReady(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
