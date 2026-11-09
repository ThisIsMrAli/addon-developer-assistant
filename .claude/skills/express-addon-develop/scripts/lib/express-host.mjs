/**
 * BETA: open a real Adobe Express window, or skip when this machine cannot show one.
 * A pass is recorded only when the panel rendered in Express and the feature was exercised.
 * This file does not type credentials and does not disable Chrome security flags.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { DEV_ORIGIN, assertSafeArgv } from "./devcert.mjs";

export { DEV_ORIGIN };
export const EXPRESS_URL = "https://new.express.adobe.com";
export const DOCS_CHECKED = "2026-11-09";

export const ADAPTERS = {
  "cursor-browser": {
    id: "cursor-browser",
    verified: true,
    inSkillCommand: false,
    source: "https://cursor.com/docs/agent/tools/browser",
    checked: DOCS_CHECKED,
    note: "Cursor's Agent Browser is a built-in tool. The docs say Agent can control a web browser, list tools for visiting URLs, clicking, typing, and screenshots, and show @browser in prompts. They also say Browser works without installing an external tool. No shell binary is documented. The raw URL listed in https://cursor.com/llms.txt returned 404 on this date; the HTML docs page was read. This skill asks the Cursor agent to open the URL with that tool. It does not invent a command."
  },
  "local-browser": {
    id: "local-browser",
    verified: true,
    inSkillCommand: true,
    source: "CHROME_PATH, or google-chrome, google-chrome-stable, microsoft-edge, or msedge on PATH",
    checked: DOCS_CHECKED,
    note: "A visible window with a persistent profile under ~/.config/express-addon-develop/chrome-profile. No --headless, no --ignore-certificate-errors, no 127.0.0.1."
  },
  "claude-chrome": {
    id: "claude-chrome",
    verified: false,
    inSkillCommand: false,
    source: "https://code.claude.com/docs/en/chrome",
    checked: DOCS_CHECKED,
    note: "Verified as a way a person starts Claude Code: `claude --chrome`, `/chrome`, and `@browser` in the VS Code prompt. The page does not document a command this skill can run to open one URL inside an existing session, so this adapter is not selected. Fallback: local Chrome or Edge, plus the dashboard checklist."
  },
  "codex-browser": {
    id: "codex-browser",
    verified: false,
    inSkillCommand: false,
    source: "https://developers.openai.com/codex/cli and https://developers.openai.com/api/docs/guides/tools-computer-use",
    checked: DOCS_CHECKED,
    note: "The Codex CLI page describes a terminal coding agent and does not document a browser-launch command. Computer use and BrowserToolset are API tools an application hosts, not a Codex CLI command. Unverified for this skill. Fallback: local Chrome or Edge, plus the dashboard checklist."
  }
};

export function defaultProbe() {
  let cgroup = "";
  try {
    cgroup = readFileSync("/proc/1/cgroup", "utf8");
  } catch {
    cgroup = "";
  }
  return {
    cgroup,
    dockerenv: existsSync("/.dockerenv"),
    containerenv: existsSync("/run/.containerenv")
  };
}

export function remoteReason(env = process.env, probe = {}) {
  if (env.EXPRESS_DEVELOP_REMOTE === "0") return "";
  if (env.EXPRESS_DEVELOP_REMOTE === "1") return "EXPRESS_DEVELOP_REMOTE=1";
  if (env.SSH_CONNECTION || env.SSH_CLIENT) return "SSH session";
  if (probe.dockerenv || probe.containerenv) return "container";
  const cgroup = `${env.CURSOR_WORKLOAD_CGROUP || ""}\n${probe.cgroup || ""}`;
  if (/\/pod-|kubepods|docker|containerd|libpod/.test(cgroup)) return "cloud or container cgroup";
  return "";
}

export function defaultWhich(name) {
  if (!/^[a-z0-9.+_-]+$/i.test(name)) return "";
  const result = spawnSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim().split("\n")[0];
}

function browserKind(file) {
  return /edge/i.test(path.basename(file)) ? "local-edge" : "local-chrome";
}

export function resolveBrowser(env, exists = existsSync, which = defaultWhich) {
  if (env.CHROME_PATH && exists(env.CHROME_PATH)) {
    return { id: browserKind(env.CHROME_PATH), file: env.CHROME_PATH };
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "microsoft-edge", "msedge"]) {
    const file = which(name);
    if (file && exists(file)) return { id: browserKind(file), file };
  }
  return null;
}

export function detectAdapter(env = process.env, options = {}) {
  const exists = options.exists || existsSync;
  const which = options.which || defaultWhich;
  const notes = {
    "claude-chrome": ADAPTERS["claude-chrome"],
    "codex-browser": ADAPTERS["codex-browser"]
  };
  const cursorExposed = env.CURSOR_AGENT === "1" && env.CURSOR_BROWSER_TOOL !== "0";
  if (cursorExposed) {
    return { id: "cursor-browser", spawn: false, file: "", notes, source: ADAPTERS["cursor-browser"] };
  }
  const browser = resolveBrowser(env, exists, which);
  if (browser) {
    return { id: browser.id, spawn: true, file: browser.file, notes, source: ADAPTERS["local-browser"] };
  }
  return { id: "checklist", spawn: false, file: "", notes, source: null };
}

export function launchSpec(adapter, env = process.env) {
  const home = env.HOME || "";
  const profile = path.join(home, ".config", "express-addon-develop", "chrome-profile");
  if (!adapter.spawn) {
    const instructions = adapter.id === "cursor-browser"
      ? [
        `Open ${EXPRESS_URL} with Cursor's Browser tool (navigate). Source: ${ADAPTERS["cursor-browser"].source}. @browser is the prompt form. Do not invent a shell binary.`,
        "Do not type a password, a code, or a cookie. The person signs in.",
        "Enable Add-on Development. Open Your add-ons, Add-on testing, and connect to https://localhost:5241. Leave chrome://flags/#local-network-access-check enabled and click Allow. Launch the add-on from In development.",
        "Exercise the feature and capture a screenshot. A pass still needs the express-result confirmation and that screenshot."
      ]
      : [
        "No Cursor browser tool and no local Chrome or Edge was found. Set CHROME_PATH, or open https://new.express.adobe.com yourself.",
        "Claude Code's `claude --chrome` and Codex's computer-use API are not invoked by this skill. Use the checklist buttons.",
        "Do not type a password. Connect Add-on testing to https://localhost:5241. Leave the local-network flag enabled and click Allow."
      ];
    return { adapter: adapter.id, spawn: false, url: EXPRESS_URL, headless: false, args: [], instructions, profile };
  }
  const args = [`--user-data-dir=${profile}`, "--new-window", EXPRESS_URL];
  assertSafeArgv([adapter.file, ...args]);
  return {
    adapter: adapter.id,
    spawn: true,
    file: adapter.file,
    args,
    url: EXPRESS_URL,
    headless: false,
    profile,
    instructions: [
      "A visible browser is opening at https://new.express.adobe.com. Sign in yourself. This skill does not take credentials.",
      "Enable Add-on Development, then Your add-ons, Add-on testing, connect to https://localhost:5241, Allow the local network prompt, and launch from In development.",
      "Exercise the feature. Then answer the beta result buttons and keep a screenshot."
    ]
  };
}

export function prepareExpressRun({ env = process.env, probe = {}, launch, exists, which } = {}) {
  const reason = remoteReason(env, probe);
  const adapter = detectAdapter(env, { exists, which });
  if (reason) {
    return {
      skipped: true,
      reason,
      launched: false,
      expressPass: false,
      expressHostRan: false,
      origin: DEV_ORIGIN,
      url: EXPRESS_URL,
      adapter
    };
  }
  const spec = launchSpec(adapter, env);
  let launchResult = null;
  if (spec.spawn && launch) launchResult = launch(spec);
  return {
    skipped: false,
    reason: "",
    launched: Boolean(spec.spawn && launch),
    expressPass: false,
    expressHostRan: false,
    origin: DEV_ORIGIN,
    url: EXPRESS_URL,
    adapter,
    spec,
    launchResult
  };
}

export function judgeExpress({ panelRendered = false, featureExercised = false, screenshot = "", outcome = "" } = {}) {
  if (outcome === "timeout" || outcome === "failed" || outcome === "skipped") {
    return { expressPass: false, expressHostRan: false, outcome };
  }
  const rendered = panelRendered === true;
  const exercised = featureExercised === true;
  const shot = Boolean(screenshot);
  return {
    expressPass: rendered && exercised && shot,
    expressHostRan: rendered,
    outcome: rendered && exercised && shot ? "passed" : "incomplete"
  };
}

export function checkTrusted(origin = DEV_ORIGIN) {
  if (origin !== DEV_ORIGIN) {
    return Promise.resolve({ ok: false, trusted: false, error: `Refusing ${origin}. The dev server is ${DEV_ORIGIN}.` });
  }
  return new Promise((resolve) => {
    const request = https.get(origin, { rejectUnauthorized: true, timeout: 8000 }, (response) => {
      response.resume();
      resolve({ ok: true, trusted: true, statusCode: response.statusCode });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve({ ok: false, trusted: false, error: "timeout" });
    });
    request.on("error", (error) => {
      resolve({ ok: false, trusted: false, error: error.code || error.message });
    });
  });
}

export function identifyDevServer(origin, expectedName) {
  if (origin !== DEV_ORIGIN) return Promise.resolve({ ok: false, error: `Refusing ${origin}. The dev server is ${DEV_ORIGIN}.` });
  const name = String(expectedName || "").trim();
  return new Promise((resolve) => {
    const request = https.get(origin, { rejectUnauthorized: true, timeout: 8000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (name && !body.includes(name)) {
          resolve({ ok: false, error: `https://localhost:5241 is not this add-on. The listing does not contain “${name}”.` });
          return;
        }
        resolve({ ok: true, name });
      });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    request.on("error", (error) => resolve({ ok: false, error: error.code || error.message }));
  });
}

/**
 * Start `npm start` first. The dev CA is created by that server.
 * Trust runs only after the CA file exists, then the certificate is checked, then the listing is checked.
 */
export async function openDevServer({
  cwd,
  spawnImpl = spawn,
  trust = async () => ({ ok: true }),
  caReady = () => true,
  check = checkTrusted,
  identify = async () => ({ ok: true }),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 45000,
  intervalMs = 1000
} = {}) {
  if (!cwd) return { ok: false, outcome: "failed", error: "No add-on folder to serve.", trusted: false };
  const child = spawnImpl("npm", ["start"], { cwd, detached: true, stdio: "ignore" });
  if (child && typeof child.unref === "function") child.unref();
  const started = Date.now();
  while (!caReady()) {
    if (Date.now() - started >= timeoutMs) {
      return { ok: false, trusted: false, pid: child?.pid ?? null, outcome: "failed", error: "npm start did not create the dev CA. The certificate was not checked before the server started." };
    }
    await sleep(intervalMs);
  }
  const setup = await trust();
  if (setup && setup.ok === false) {
    return { ok: false, trusted: false, pid: child?.pid ?? null, outcome: "failed", error: setup.error || "The dev CA was not trusted.", setup };
  }
  const remaining = Math.max(0, timeoutMs - (Date.now() - started));
  const checked = await waitForDevServer({ cwd, child, check, identify, sleep, timeoutMs: remaining, intervalMs });
  return { ...checked, setup };
}

export async function waitForDevServer({ cwd, spawnImpl = spawn, child = null, check = checkTrusted, identify = async () => ({ ok: true }), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = 45000, intervalMs = 1000 } = {}) {
  if (!cwd) return { ok: false, outcome: "failed", error: "No add-on folder to serve.", trusted: false };
  const startedChild = child || spawnImpl("npm", ["start"], { cwd, detached: true, stdio: "ignore" });
  if (!child && startedChild && typeof startedChild.unref === "function") startedChild.unref();
  const started = Date.now();
  let last = { ok: false, trusted: false, error: "not checked" };
  do {
    last = await check(DEV_ORIGIN);
    if (last.fatal) {
      return { ok: false, trusted: false, pid: startedChild?.pid ?? null, outcome: "failed", error: last.error || "The dev CA was not trusted." };
    }
    if (last.trusted) {
      const who = await identify(DEV_ORIGIN);
      if (who && who.ok === false) {
        return { ok: false, trusted: true, pid: startedChild?.pid ?? null, outcome: "wrong-server", error: who.error || "Port 5241 is serving a different add-on." };
      }
      return { ok: true, trusted: true, pid: startedChild?.pid ?? null, outcome: "ready", identity: who?.name || "" };
    }
    if (Date.now() - started >= timeoutMs) break;
    await sleep(intervalMs);
  } while (Date.now() - started < timeoutMs);
  return {
    ok: false,
    trusted: false,
    pid: startedChild?.pid ?? null,
    outcome: last.error === "timeout" || !last.trusted ? "timeout" : "failed",
    error: last.error || "https://localhost:5241 did not present a trusted certificate in time."
  };
}

export function spawnVisible(spec) {
  assertSafeArgv([spec.file, ...spec.args]);
  if (spec.headless || spec.args.some((arg) => String(arg).includes("headless") || String(arg).includes("127.0.0.1"))) {
    throw new Error("Refusing a headless or non-localhost Express window.");
  }
  const child = spawn(spec.file, spec.args, { detached: true, stdio: "ignore" });
  child.unref();
  return { pid: child.pid };
}
