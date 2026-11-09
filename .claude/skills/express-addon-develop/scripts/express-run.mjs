#!/usr/bin/env node
/**
 * BETA real Express check.
 * Remote machines (cloud agent, SSH, container) are skipped with a reason.
 * This command never types Adobe credentials and never claims a pass by itself.
 *
 *   node scripts/express-run.mjs [--out dir]
 *   node scripts/express-run.mjs --confirm [--out dir]
 */
import fs from "node:fs";
import path from "node:path";
import { reminder } from "../../express-addon-review/scripts/lib/next.mjs";
import { readMerged } from "../../express-addon-review/scripts/lib/session.mjs";
import { trustDevcert } from "./lib/devcert.mjs";
import { devcertReady } from "./lib/ssl-setup.mjs";
import {
  checkTrusted,
  defaultProbe,
  identifyDevServer,
  judgeExpress,
  openDevServer,
  prepareExpressRun,
  spawnVisible
} from "./lib/express-host.mjs";
import { policyFailure, readLoopbackPolicy, resolvePolicyDirs } from "./lib/loopback.mjs";
import { rememberedOut } from "./lib/paths.mjs";
import { expressResultAsk } from "./lib/flow.mjs";
import { patchDevelop, upsertQuestion } from "./lib/session-start.mjs";

const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.out || process.env.EXPRESS_DEVELOP_OUT || process.env.EXPRESS_REVIEW_OUT || rememberedOut() || "");
if (!out || !fs.existsSync(path.join(out, "session.json"))) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: "No develop session. Pass --out." })}\n`);
  process.exit(1);
}

if (args.confirm) confirm();
else await run();

function confirm() {
  const session = readMerged(out);
  const answer = (session?.asks || []).find((item) => item.id === "express-result" && item.status === "answered");
  const shot = (session?.shots || []).find((item) => item.kind === "express");
  const outcome = answer?.answer === "failed" ? "failed" : answer?.answer === "skip" ? "skipped" : "";
  const judged = judgeExpress({
    panelRendered: answer?.answer === "rendered",
    featureExercised: answer?.answer === "rendered",
    screenshot: shot?.file || "",
    outcome
  });
  patchDevelop(out, {
    expressJudged: true,
    expressPass: judged.expressPass,
    expressHostRan: judged.expressHostRan,
    expressOutcome: judged.outcome
  });
  write({ ok: true, confirmed: true, ...judged });
}

async function run() {
  const mock = process.env.EXPRESS_DEVELOP_MOCK_LAUNCH === "1";
  const prepared = prepareExpressRun({
    env: process.env,
    probe: defaultProbe(),
    launch: mock ? (spec) => ({ mocked: true, adapter: spec.adapter, url: spec.url }) : undefined
  });
  if (prepared.skipped) {
    patchDevelop(out, {
      expressChecked: true,
      expressRemote: !prepared.policyBlocked || /cgroup|SSH|container|EXPRESS_DEVELOP_REMOTE/.test(prepared.reason),
      expressPolicy: Boolean(prepared.policyBlocked),
      expressSetup: false,
      expressPass: false,
      expressHostRan: false,
      expressReason: prepared.reason,
      expressOutcome: "skipped"
    });
    write({ ok: true, ...prepared, credentials: "never handled" });
    return;
  }

  let server = { ok: true, skipped: true, trusted: true };
  if (!mock) {
    const session = readMerged(out);
    const home = process.env.HOME;
    server = await openDevServer({
      cwd: session?.addon?.path,
      caReady: () => devcertReady(home || ""),
      trust: () => trustDevcert({ home, exec: true }),
      check: checkTrusted,
      identify: (origin) => identifyDevServer(origin, manifestName(session))
    });
    fs.writeFileSync(path.join(out, "express-setup.json"), `${JSON.stringify(server.setup || { ok: false }, null, 2)}\n`);
    if (!server.ok || !server.trusted) return blocked(server.error || "https://localhost:5241 did not become this add-on.", 0, server.outcome || "timeout");
  }

  let opened = prepared.launchResult;
  if (!mock && prepared.spec?.spawn) {
    try {
      opened = spawnVisible(prepared.spec);
    } catch (error) {
      return blocked(error.message, 0, "failed");
    }
  }
  upsertQuestion(out, expressResultAsk());
  patchDevelop(out, {
    expressChecked: true,
    expressRemote: false,
    expressBlocked: "",
    expressSetup: mock ? false : true,
    expressPass: false,
    expressHostRan: false,
    expressReason: "",
    expressOutcome: "awaiting-confirmation"
  });
  write({
    ok: true,
    mock,
    setup: mock ? "mocked" : "trusted",
    server,
    opened,
    credentials: "never handled",
    ...prepared
  });
}

function blocked(error, exitCode, outcome = "failed") {
  const told = policyFailure(error, readLoopbackPolicy(resolvePolicyDirs(process.env)));
  patchDevelop(out, {
    expressChecked: true,
    expressRemote: false,
    expressPolicy: told.includes("LoopbackNetworkBlockedForUrls"),
    expressBlocked: told,
    expressReason: told,
    expressPass: false,
    expressHostRan: false,
    expressOutcome: outcome
  });
  write({ ok: false, recorded: true, expressPass: false, expressHostRan: false, outcome, error: told });
  process.exit(exitCode && exitCode !== 0 ? 0 : 0);
}

function manifestName(session) {
  const dir = session?.addon?.path || "";
  for (const rel of ["src/manifest.json", "manifest.json"]) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8")).name || session?.addon?.name || "";
    } catch {
      // The other path may hold the manifest.
    }
  }
  return session?.addon?.name || "";
}

function dashboardUp(dir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8"));
    if (!info?.pid) return false;
    process.kill(info.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function write(body) {
  fs.writeFileSync(path.join(out, "express-host.json"), `${JSON.stringify(body, null, 2)}\n`);
  const printed = { ...body };
  printed.next = reminder(out, { dashboardUp: dashboardUp(out) });
  process.stdout.write(`${JSON.stringify(printed)}\n`);
}

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
