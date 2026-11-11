import { deriveName, goalIsThin, nameIsGeneric, statedDesign } from "./intent.mjs";

/**
 * What the sentence did not decide. Questions for these are asked before the confirm card.
 * A fact the sentence already states is not asked again.
 */

export { goalIsThin, nameIsGeneric, statedDesign };

/** Up to two choices the goal leaves open. Each has a recommended first option. */
export function featureQuestions(plan) {
  const text = `${plan.goal || ""} ${plan.name || ""}`;
  const questions = [];
  if (/\b(heading|headline|text)\b/i.test(text) && /\b(image|photo|picture)\b/i.test(text) && !/\b(both|and (?:an? )?(?:image|photo)|text then|heading then)\b/i.test(plan.goal || "")) {
    questions.push({
      id: "feat-layout",
      title: "Text and image",
      prompt: "The brief mentions text and an image. How should they sit on the page?",
      options: [
        { id: "stack", label: "Heading column, then the image below (Recommended)", detail: "Matches Adobe's position and resize how-tos." },
        { id: "text-only", label: "Text only for now", detail: "Skip the image in this build." },
        { id: "image-only", label: "Image only for now", detail: "Skip the heading in this build." }
      ]
    });
  }
  if (/\boauth\b|\bdropbox\b|\bgoogle\b/i.test(text) && !/\bclientstorage\b|\bstore (?:the )?token\b/i.test(text)) {
    questions.push({
      id: "feat-token",
      title: "OAuth tokens",
      prompt: "Where should the add-on keep the OAuth token after authorize?",
      options: [
        { id: "storage", label: "clientStorage (Recommended)", detail: "Persists across sessions in the add-on." },
        { id: "memory", label: "Memory only", detail: "Lost when the panel closes." }
      ]
    });
  }
  return questions.slice(0, 2);
}

/** Questions still open after reading the sentence. The confirm card is not one of these. */
export function planningQuestions(plan) {
  const questions = [];
  if (goalIsThin(plan.goal)) {
    questions.push({
      id: "goal",
      title: "What should it do?",
      kicker: "The job",
      prompt: "Describe the add-on in one or two sentences: the job, and what the person sees in the panel. This is the spec. Nothing is built from the skill name alone.",
      input: "text",
      maxLength: 400,
      options: []
    });
  }
  if (nameIsGeneric(plan.name)) {
    questions.push({
      id: "name",
      title: "Add-on name",
      kicker: "The name",
      prompt: "What should the marketplace name be? Letters, numbers, and spaces only (3–45 characters), for example Color Note.",
      input: "text",
      maxLength: 45,
      options: []
    });
  }
  if (goalIsThin(plan.goal)) {
    questions.push({
      id: "description",
      title: "What the panel shows",
      kicker: "The screen",
      prompt: "In one sentence, what does the panel show, and what does the main button do?",
      input: "text",
      maxLength: 240,
      options: []
    });
  }
  questions.push(...featureQuestions(plan));
  return questions;
}

/** Writes planning answers onto the plan. Safe to call on every read. */
export function applyPlanning(plan, answers) {
  const next = { ...plan, features: { ...(plan.features || {}) } };
  if (typeof answers.goal === "string" && answers.goal.trim()) {
    next.goal = answers.goal.trim();
    if (!answers.name && nameIsGeneric(next.name)) next.name = deriveName(next.goal);
  }
  if (typeof answers.name === "string" && answers.name.trim()) {
    next.name = answers.name.trim().slice(0, 45);
  }
  if (typeof answers.description === "string" && answers.description.trim()) {
    next.description = answers.description.trim().slice(0, 240);
  } else if (!next.description && !goalIsThin(next.goal)) {
    next.description = next.goal;
  }
  for (const [id, value] of Object.entries(answers)) {
    if (id.startsWith("feat-") && value) next.features[id] = value;
  }
  return next;
}

const FEATURE_LABELS = {
  "feat-layout": {
    stack: "Heading column, then the image below.",
    "text-only": "Text only for now.",
    "image-only": "Image only for now."
  },
  "feat-token": {
    storage: "Store the OAuth token in clientStorage.",
    memory: "Keep the OAuth token in memory only."
  }
};

export function featureLines(plan) {
  const lines = [];
  for (const [id, value] of Object.entries(plan.features || {})) {
    const label = FEATURE_LABELS[id]?.[value];
    if (label) lines.push(`- ${label}`);
  }
  return lines;
}

/** The words a developer types on the "change something" card, read into plan fields. */
export function parseTweak(text, plan) {
  const value = String(text || "");
  const changes = {};
  const quoted = value.match(/["“']([^"”']{2,60})["”']/);
  const called = value.match(/\b(?:called|named|name it|name:|rename (?:it )?(?:to)?)\s+([A-Za-z0-9][A-Za-z0-9 _]{1,44}?)(?=$|[,.;]|\s+(?:and|with|use|using|for|in|needs?)\b)/i);
  const name = (quoted && quoted[1]) || (called && called[1]);
  if (name) changes.name = name.trim();
  if (/\bspectrum\b|\bswc\b/i.test(value)) changes.design = "swc";
  if (/\b(?:no|without|not)\s+spectrum\b|\bplain\b|\bkeep\s+the\s+template/i.test(value)) changes.design = "leave";
  if (/\bempty\s+folder\b|\bfrom\s+scratch\b|\bnew\s+add-?on\b/i.test(value)) changes.origin = "new";
  if (/\bexist(?:ing)?\b|\balready\s+have\b|\bextend\b/i.test(value)) changes.origin = "existing";
  if (/\b(?:brief|goal|job)\s*[:=]\s*(.+)$/i.test(value)) {
    changes.goal = value.match(/\b(?:brief|goal|job)\s*[:=]\s*(.+)$/i)[1].trim();
  } else if (/\binstead\b|\brather\b|\bshould\s+(?:do|add|create|build)\b/i.test(value) && value.length > 12) {
    changes.goal = value.trim();
  }
  void plan;
  return changes;
}

export function planSummary(plan) {
  const ready = !goalIsThin(plan.goal);
  const origin = plan.origin === "existing"
    ? `Extend the add-on at ${plan.path || plan.dir || "(folder)"}`
    : "Start from an empty folder (template chosen after the docs)";
  return [
    ready
      ? "Nothing is created until you choose Build it. This is the spec, including anything already said in chat."
      : "This is not ready to build. The job has not been described.",
    ready ? `Adobe Express add-on "${plan.name}"` : `Name: ${plan.name || "not chosen"}`,
    `Goal: ${plan.goal || "not described yet"}`,
    plan.description && plan.description !== plan.goal ? `Description: ${plan.description}` : "",
    ...featureLines(plan),
    origin,
    plan.designHint ? `Controls: ${plan.designHint === "swc" ? "Spectrum Web Components preferred" : "Keep the template's controls"}` : "",
    `Folder: ${plan.path || plan.dir || ""}`,
    "Steps after you confirm: fetch Adobe's current Express docs, pick a template when the folder is new, check feasibility, write the feature, build, package, walk the panel, then ask you to try it."
  ].filter(Boolean).join("\n");
}

export function planAsk(plan) {
  return {
    id: "plan",
    title: "Confirm the spec",
    kicker: "Before anything is created",
    prompt: planSummary(plan),
    options: [
      { id: "build", label: "Build it (Recommended)", detail: "Fetches the docs, builds the add-on, then asks you to try it." },
      { id: "change", label: "Change something", detail: "Say what to change: name, goal, Spectrum or plain controls, new or existing folder." },
      { id: "stop", label: "Stop", detail: "Ends the session. Nothing is created.", ends: true }
    ]
  };
}

export function tweakAsk() {
  return {
    id: "tweak",
    title: "What to change",
    prompt: "What should be different? Plain words are fine, for example: name it Color Note, use Spectrum, start from an empty folder, add a caption field instead.",
    input: "text",
    maxLength: 300,
    options: [],
    when: { plan: "change" }
  };
}
