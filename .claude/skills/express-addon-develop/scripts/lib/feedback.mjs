import fs from "node:fs";
import path from "node:path";
import { DEV_ORIGIN } from "./devcert.mjs";
import { checkTrusted, defaultProbe, identifyDevServer, openDevServer, remoteReason } from "./express-host.mjs";
import { PRIVATE_LINK_ROUTE, probeDevPort, readLoopbackPolicy } from "./loopback.mjs";
import { mutate, readMerged, setStep } from "../../../express-addon-review/scripts/lib/session.mjs";

/**
 * The try loop. Nothing here opens Adobe Express. Before the try card, if the
 * dev server is not already this add-on, the person is asked whether to start it.
 */

export const loadFile = (out) => path.join(out, "load.txt");

const EXPRESS_STEPS = "In Adobe Express, connect Add-on testing to https://localhost:5241 (not 127.0.0.1). Leave chrome://flags/#local-network-access-check enabled and click Allow. Launch the add-on from In development.";

export function loadLine(why, extra = {}) {
  if (why === "running") return `The add-on is already running at https://localhost:5241. ${extra.report || ""}\n\n${EXPRESS_STEPS}`.trim();
  if (why === "started") return `Started it for you with npm start -- --analytics off. It is at https://localhost:5241. ${extra.report || ""}\n\n${EXPRESS_STEPS}`.trim();
  if (why === "manual") return `The add-on is not running. In the project folder, run:\n\nnpm start -- --analytics off\n\n${EXPRESS_STEPS}`;
  if (why === "remote") return `This computer cannot start the dev server (${extra.remote}). On your own computer, in the project folder, run npm start -- --analytics off.\n\n${EXPRESS_STEPS}`;
  if (why === "policy") return `Chrome policy LoopbackNetworkBlockedForUrls blocks Adobe Express from loading https://localhost:5241. Starting the dev server does not fix that. ${PRIVATE_LINK_ROUTE}`;
  if (why === "other") return `${extra.error || "https://localhost:5241 is already serving a different add-on."} This skill will not stop it. Stop that server, then try again. ${PRIVATE_LINK_ROUTE}`;
  if (why === "untrusted") return `Something is already listening on port 5241, but https://localhost:5241 is not a trusted dev server. This skill will not start a second one. ${extra.error || extra.report || ""}`.trim();
  if (why === "failed") return `npm start did not come up. ${extra.error || ""}\n\nIn the project folder, run:\n\nnpm start -- --analytics off\n\n${EXPRESS_STEPS}`.trim();
  return EXPRESS_STEPS;
}

/**
 * What to do before the try card.
 * `running` means this add-on is already on 5241. `start` means the person asked to launch it and it is still down.
 */
export function decideServe({ state, remote = "", policy = false, answer = "", answerRound = 0, round = 1 } = {}) {
  if (state === "running") return { action: "ready", why: "running" };
  if (state === "other") return { action: "blocked", why: "other" };
  if (state === "untrusted") return { action: "blocked", why: "untrusted" };
  if (policy) return { action: "blocked", why: "policy" };
  if (remote) return { action: "blocked", why: "remote" };
  if (answer === "start") return { action: "start", why: "start" };
  if (answer === "manual" && answerRound === round) return { action: "manual", why: "manual" };
  return { action: "ask", why: "down" };
}

export function serveAsk(round) {
  return {
    id: "serve",
    round,
    title: "Start the add-on?",
    kicker: "Before you try it",
    prompt: "The add-on is not running, so Adobe Express cannot load it yet. Start it on this computer? That runs npm start and serves https://localhost:5241. You still sign in to Express yourself. Nothing is submitted.",
    options: [
      { id: "start", label: "Start it for me (Recommended)", detail: "Runs npm start -- --analytics off in the project folder and waits until https://localhost:5241 is this add-on." },
      { id: "manual", label: "I'll start it myself", detail: "Nothing is started. The next card shows the command." }
    ]
  };
}

export async function inspectServe({ name, probe = probeDevPort, identify = identifyDevServer, check = checkTrusted } = {}) {
  const found = await probe(5241);
  if (!found?.host) return { state: "down", report: found?.report || "Port 5241 is not listening." };
  let trusted = { ok: false, trusted: false, error: "" };
  try {
    trusted = await check(DEV_ORIGIN);
  } catch (error) {
    trusted = { ok: false, trusted: false, error: error.message };
  }
  if (!trusted.ok && !trusted.trusted) {
    return { state: "untrusted", report: found.report, error: trusted.error || found.report };
  }
  let who = { ok: false, error: "" };
  try {
    who = await identify(DEV_ORIGIN, name);
  } catch (error) {
    who = { ok: false, error: error.message };
  }
  if (who.ok) return { state: "running", report: found.report };
  return { state: "other", report: found.report, error: who.error || "Port 5241 is serving a different add-on." };
}

function brief(text) {
  return String(text).split("\n")[0].slice(0, 120).replace(/[.\s]+$/, "");
}

function quoted(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? `"${text.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"` : text;
}

function loadHelp(out) {
  try {
    return fs.readFileSync(loadFile(out), "utf8").trim();
  } catch {
    return loadLine("manual");
  }
}

/** The question for the round that is about to start. */
export function feedbackQuestion(out) {
  const session = readMerged(out);
  const round = (session.asks.find((ask) => ask.id === "feedback")?.round || 0) + 1;
  const next = round + 1;
  const reports = session.notes.filter((note) => /^fb\d/.test(note.id));
  const fixedNotes = reports.filter((note) => note.status === "fixed");
  const stillOpen = reports.filter((note) => note.status === "open");
  const sinceLast = (session.feedbackChanged || "").trim();
  const prompt = round === 1
    ? [
      "The add-on is built and packaged. The headless panel walk used an SDK stand-in, so you are the first real try.",
      loadHelp(out),
      "Use it the way a real user would. If anything is wrong (a bug, an error message, wrong text, a layout that looks off, a missing feature), choose the first option, type what you saw, and add screenshots. If everything works, choose the second."
    ].join("\n\n")
    : [
      `Round ${round}.${sinceLast ? ` ${sinceLast}` : ""}`,
      fixedNotes.length ? `Fixed since you last looked: ${fixedNotes.map((note) => brief(note.text)).join("; ")}.` : "",
      stillOpen.length ? `Still open: ${stillOpen.map((note) => brief(note.text)).join("; ")}.` : "",
      loadHelp(out),
      "Reload the add-on, try the same steps again, then tell me what is still wrong, or that there are no more bugs."
    ].filter(Boolean).join("\n\n");
  const record = `node scripts/develop.mjs record --out ${quoted(out)}`;
  const again = `node scripts/develop.mjs feedback --changed "<one line: what you changed, or the question you need answered>" --out ${quoted(out)}`;
  return {
    id: "feedback",
    title: round === 1 ? "Try it" : `Try it again (round ${round})`,
    prompt,
    attach: true,
    round,
    maxLength: 4000,
    options: [
      {
        id: "bugs",
        label: "Something is wrong, or I want a change",
        detail: "Type what you saw and add screenshots. The assistant fixes it, rebuilds, and asks you to try again.",
        repeat: true,
        then: `The developer sent report ${round} (note fb${round}). 1) Read their words and open every screenshot file; you can view images. If the words already name what is wrong and what they expected, that is the fix; only ask a question in --changed when the expected result is missing. 2) If there is more than one problem, add one note each: node scripts/session.mjs note --id fb${round}-1 --text "..." --out ${quoted(out)}. 3) Fix the code. Change only what the report names, and do not remove a feature to make a problem go away. When the design answer is Spectrum, stay on Spectrum Web Components: sections are sp-tabs, a list of choices is sp-picker or sp-menu, and a button is only a real action. Do not switch the panel to Radix or plain HTML because a report names another library. An open sp-picker is a menu, not a dialog that needs a Close button. 4) Run \`${record}\`, then build and package, until they pass. 5) Mark each fixed note: node scripts/session.mjs note --id <id> --status fixed --out ${quoted(out)}. 6) Run \`${again}\` to ask round ${next}. A request for a new feature or a change is handled the same way. Do not end your turn and do not ask the developer in chat.`
      },
      {
        id: "good",
        label: "No more bugs, finish trying",
        detail: "Everything I tried works. Continues to the optional Express beta and the listing."
      }
    ]
  };
}

function upcomingRound(session) {
  const last = session.asks.find((ask) => ask.id === "feedback");
  if (last?.status === "answered" && last.options?.find((item) => item.id === last.answer)?.repeat) return (last.round || 1) + 1;
  return (last?.round || 0) + (last?.status === "answered" ? 0 : 1) || 1;
}

/** Publish the round, or the start question when the dev server is down. */
export async function prepareFeedback(out, { changed = "", skip = false, probe, identify, check, remote, policy, start } = {}) {
  const session = readMerged(out);
  const audit = session.steps.find((item) => item.id === "audit");
  if (skip) {
    setStep(out, "try", "skipped", "Nobody was there to try it", { doing: "" });
    return { ok: true, skipped: true, note: "The try step was skipped. The add-on was built and packaged but not tried by a person." };
  }
  if (!audit || audit.status !== "done") {
    if (!session.develop?.audited) {
      return { ok: false, error: "The add-on has not been audited yet.", next: "Run the audit, then feedback." };
    }
  }
  const pendingServe = session.asks.find((item) => item.id === "serve" && item.status === "pending");
  if (pendingServe) return { ok: true, id: "serve", already: true, next: "The start question is already waiting. Run the wait command for it." };
  const last = session.asks.find((item) => item.id === "feedback");
  if (last?.status === "pending") return { ok: true, id: "feedback", already: true, next: "The question is already waiting. Run the wait command for it." };
  if (last?.status === "answered" && !last.options.find((item) => item.id === last.answer)?.repeat) {
    setStep(out, "try", "done", "No more bugs, you said");
    return { ok: true, id: "feedback", answered: last.answer, next: "The developer already said there are no more bugs. Run the session next command." };
  }

  const round = upcomingRound(session);
  const serveAnswer = session.asks.find((item) => item.id === "serve" && item.status === "answered");
  const remoteText = remote ? remote() : remoteReason(process.env, defaultProbe());
  const policyOn = policy ? Boolean(policy()) : Boolean(readLoopbackPolicy().blocks);
  setStep(out, "try", "running", "Checking the dev server", { doing: "Checking whether the add-on is running" });
  const seen = await inspectServe({
    name: session.addon?.name || "",
    probe,
    identify,
    check
  });
  const decision = decideServe({
    state: seen.state,
    remote: remoteText,
    policy: policyOn,
    answer: serveAnswer?.answer || "",
    answerRound: serveAnswer?.round || 0,
    round
  });
  if (decision.action === "ask") {
    return { ok: true, publish: "serve", definition: serveAsk(round) };
  }
  let why = decision.why;
  let extra = { report: seen.report, error: seen.error, remote: remoteText };
  if (decision.action === "start") {
    if (session.develop?.serveAttemptRound === round) {
      why = "failed";
      extra = { error: session.develop?.serveError || "npm start did not come up." };
    } else {
      setStep(out, "try", "running", "Starting the add-on", { doing: "npm start -- --analytics off" });
      mutate(out, (draft) => {
        draft.develop = { ...(draft.develop || {}), serveAttemptRound: round };
      });
      const launch = start || ((cwd) => openDevServer({ cwd }));
      let started;
      try {
        started = await launch(session.addon?.path || "");
      } catch (error) {
        started = { ok: false, error: error.message };
      }
      mutate(out, (draft) => {
        draft.develop = { ...(draft.develop || {}), serveError: started.ok ? "" : (started.error || "npm start did not come up."), devServerPid: started.pid || null };
      });
      if (started.ok) {
        const again = await inspectServe({ name: session.addon?.name || "", probe, identify, check });
        why = again.state === "running" ? "started" : "failed";
        extra = { report: again.report, error: again.error || started.error };
      } else {
        why = "failed";
        extra = { error: started.error || "npm start did not come up." };
      }
    }
  }
  fs.writeFileSync(loadFile(out), `${loadLine(why, extra)}\n`);
  mutate(out, (draft) => {
    draft.feedbackChanged = String(changed || "").trim();
    draft.develop = { ...(draft.develop || {}), serveState: why };
  });
  const definition = feedbackQuestion(out);
  const file = path.join(out, "feedback-ask.json");
  fs.writeFileSync(file, `${JSON.stringify(definition, null, 2)}\n`);
  return { ok: true, publish: "feedback", round: definition.round, definition, file };
}
