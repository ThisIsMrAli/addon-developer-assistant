import fs from "node:fs";
import path from "node:path";
import { mutate, readMerged, setStep } from "../../../express-addon-review/scripts/lib/session.mjs";

/**
 * The try loop. Nothing here can open Adobe Express for the developer by itself
 * (that is the optional beta step). Each round is one card: load it, use it, then
 * send words and screenshots, or say there are no more bugs.
 */

export const loadFile = (out) => path.join(out, "load.txt");

function loadHelp(out) {
  try {
    return fs.readFileSync(loadFile(out), "utf8").trim();
  } catch {
    return "In Adobe Express: Connect Add-on testing to https://localhost:5241 (not 127.0.0.1), or package dist.zip and use a private link. Leave chrome://flags/#local-network-access-check enabled and click Allow.";
  }
}

function brief(text) {
  return String(text).split("\n")[0].slice(0, 120).replace(/[.\s]+$/, "");
}

function quoted(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? `"${text.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"` : text;
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
      `Load it: ${loadHelp(out)}`,
      "Use it the way a real user would. If anything is wrong (a bug, an error message, wrong text, a layout that looks off, a missing feature), choose the first option, type what you saw, and add screenshots. If everything works, choose the second."
    ].join("\n\n")
    : [
      `Round ${round}.${sinceLast ? ` ${sinceLast}` : ""}`,
      fixedNotes.length ? `Fixed since you last looked: ${fixedNotes.map((note) => brief(note.text)).join("; ")}.` : "",
      stillOpen.length ? `Still open: ${stillOpen.map((note) => brief(note.text)).join("; ")}.` : "",
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

/** Publish the round. Returns what to tell the agent, or why not. */
export function prepareFeedback(out, { changed = "", skip = false } = {}) {
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
  const last = session.asks.find((item) => item.id === "feedback");
  if (last?.status === "pending") return { ok: true, id: "feedback", already: true, next: "The question is already waiting. Run the wait command for it." };
  if (last?.status === "answered" && !last.options.find((item) => item.id === last.answer)?.repeat) {
    setStep(out, "try", "done", "No more bugs, you said");
    return { ok: true, id: "feedback", answered: last.answer, next: "The developer already said there are no more bugs. Run the session next command." };
  }
  mutate(out, (draft) => {
    draft.feedbackChanged = String(changed || "").trim();
  });
  const definition = feedbackQuestion(out);
  const file = path.join(out, "feedback-ask.json");
  fs.writeFileSync(file, `${JSON.stringify(definition, null, 2)}\n`);
  return { ok: true, round: definition.round, definition, file };
}
