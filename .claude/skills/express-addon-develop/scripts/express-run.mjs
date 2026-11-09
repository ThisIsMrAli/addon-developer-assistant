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
import {
  checkTrusted,
  defaultProbe,
  judgeExpress,
  prepareExpressRun,
  spawnVisible,
  waitForDevServer
} from "./lib/express-host.mjs";
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
      expressRemote: true,
      expressSetup: false,
      expressPass: false,
      expressHostRan: false,
      expressReason: prepared.reason,
      expressOutcome: "skipped"
    });
    write({ ok: true, ...prepared, credentials: "never handled" });
    return;
  }

  let setup = { ok: true, executed: false, skipped: true };
  let server = { ok: true, skipped: true, trusted: true };
  if (!mock) {
    setup = trustDevcert({ home: process.env.HOME, exec: true });
    fs.writeFileSync(path.join(out, "express-setup.json"), `${JSON.stringify(setup, null, 2)}\n`);
    if (!setup.ok) return blocked(setup.error || "The dev CA was not trusted.", setup.exitCode || 1);
    const session = readMerged(out);
    server = await waitForDevServer({ cwd: session?.addon?.path, check: checkTrusted });
    if (!server.trusted) return blocked(server.error || "https://localhost:5241 did not become trusted.", 0, server.outcome || "timeout");
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
  patchDevelop(out, {
    expressChecked: true,
    expressRemote: false,
    expressBlocked: error,
    expressPass: false,
    expressHostRan: false,
    expressOutcome: outcome
  });
  write({ ok: false, recorded: true, expressPass: false, expressHostRan: false, outcome, error });
  process.exit(exitCode && exitCode !== 0 ? 0 : 0);
}

function write(body) {
  fs.writeFileSync(path.join(out, "express-host.json"), `${JSON.stringify(body, null, 2)}\n`);
  const printed = { ...body };
  printed.next = reminder(out);
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
