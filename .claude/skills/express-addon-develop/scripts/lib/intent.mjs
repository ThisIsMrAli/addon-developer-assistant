/**
 * What the request already says. The skill reads the goal so the developer is not
 * asked again for a name or job they just typed.
 */

const FILLER = new Set([
  "high", "quality", "good", "great", "best", "nice", "simple", "easy", "fast", "new",
  "custom", "beautiful", "awesome", "powerful", "professional", "really", "very", "some",
  "any", "my", "our", "all", "both", "every", "each", "a", "an", "the"
]);
const UI_WORDS = new Set([
  "spectrum", "swc", "iframe", "sandbox", "plugin", "panel", "addon", "add-on", "add",
  "on", "adobe", "express", "uxp"
]);
const VERBS = new Set([
  "create", "generate", "make", "build", "show", "list", "display", "export", "import",
  "write", "add", "convert", "find", "manage", "edit", "produce", "render", "copy",
  "upload", "download", "rename", "sort", "resize", "crop", "apply", "fix", "clean",
  "extract", "search", "sync", "translate", "batch", "automate", "insert", "place",
  "replace", "remove", "delete", "check", "preview", "open", "save", "set", "get",
  "read", "scan", "detect", "split", "merge", "trim", "cut", "mark", "label", "tag",
  "organize", "arrange", "align", "duplicate", "swap"
]);
const CLAUSE = new Set([
  "with", "by", "using", "from", "for", "to", "that", "which", "so", "into", "via",
  "when", "where", "based", "in", "on", "at", "of", "inside", "within", "across",
  "through", "between", "over", "and", "or", "then"
]);
const ACRONYMS = new Set([
  "qr", "pdf", "svg", "png", "jpg", "jpeg", "gif", "url", "uri", "ai", "ui", "ux",
  "xml", "csv", "json", "api", "rgb", "cmyk", "ocr", "id", "seo", "css", "html", "oauth"
]);

function isVerb(word) {
  const lower = word.toLowerCase();
  return (
    VERBS.has(lower) ||
    VERBS.has(lower.replace(/(?:es|s)$/, "")) ||
    VERBS.has(lower.replace(/s$/, "")) ||
    VERBS.has(lower.replace(/ing$/, "")) ||
    VERBS.has(lower.replace(/ing$/, "e"))
  );
}

/** True when the words are the skill itself, or nothing. They do not describe an add-on. */
export function isBlankGoal(goal) {
  let text = String(goal || "").trim();
  if (!text) return true;
  text = text.replace(/(?:^|\s)(?:\/|~\/)?(?:[\w.-]+\/)*express-addon-develop\b/gi, " ");
  text = text.replace(/\s+/g, " ").trim();
  const bare = text.replace(/^\/+/, "").replace(/[_-]+/g, " ").toLowerCase();
  if (!bare) return true;
  return /^(?:express addon develop|express add on develop|addon develop|add on develop|assistant|express|addon|add on|plugin|panel)$/.test(bare);
}

/** Marketplace display name from the request. Must later match MANIFEST_NAME. */
export function deriveName(goal) {
  if (isBlankGoal(goal)) return "Express Add On";
  let text = String(goal || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/g, "");
  text = text.replace(/\b(?:adobe\s+)?express\b/gi, " ");
  text = text.replace(/\s+/g, " ").trim();
  let purpose = false;
  const lead =
    /^(?:please\s+)?(?:can you\s+|could you\s+|i\s+(?:want|need|would like)\s+(?:you\s+)?(?:to\s+)?)?(?:(?:create|build|make|write|develop|design|give|get)\s+(?:me\s+|us\s+)?)?(?:(?:an?|the|my|new)\s+)*(?:(?:spectrum|swc|express|adobe|new)\s+)*(?:add-?on|addon|plugin|panel|extension|tool|app)\b\s*(that|which|to|for|called|named|:|-)?\s*/i;
  const matched = text.match(lead);
  if (matched) {
    text = text.slice(matched[0].length);
    purpose = /^(?:that|which|to|for)$/i.test(matched[1] || "");
  }
  text = text.replace(/^(?:called|named)\s+/i, "");
  text = text.replace(/^(?:to|that|which|for)\s+/i, () => {
    purpose = true;
    return "";
  });
  let words = text.split(/[^A-Za-z0-9+#]+/).filter(Boolean);
  for (let first = true; words.length > 1; first = false) {
    const word = words[0].toLowerCase();
    const strip = isVerb(word) || /^(?:and|or|then)$/.test(word) || (purpose && first && /^[a-z]+s$/i.test(word));
    if (!strip) break;
    words.shift();
  }
  while (words.length > 1 && FILLER.has(words[0].toLowerCase())) words.shift();
  const cutAt = words.findIndex((word, index) => index > 0 && CLAUSE.has(word.toLowerCase()));
  const phrase = cutAt > 0 ? words.slice(0, cutAt) : words;
  const content = (list) => list.filter((word) => {
    const lower = word.toLowerCase();
    return !FILLER.has(lower) && !UI_WORDS.has(lower) && !CLAUSE.has(lower);
  });
  let chosen = content(phrase);
  if (!chosen.length && cutAt > 0) {
    const rest = words.slice(cutAt + 1);
    while (rest.length > 1 && (isVerb(rest[0]) || FILLER.has(rest[0].toLowerCase()) || UI_WORDS.has(rest[0].toLowerCase()))) rest.shift();
    chosen = content(rest);
  }
  if (!chosen.length) chosen = phrase.filter((word) => !UI_WORDS.has(word.toLowerCase()));
  chosen = chosen.slice(0, 4);
  if (!chosen.length) return "Express Add On";
  const titled = chosen.map((word) => {
    const lower = word.toLowerCase();
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
  let name = titled.join(" ").replace(/[^a-zA-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (name.length < 3) name = `${name} Add On`.trim();
  if (!/^[a-zA-Z0-9]/.test(name)) name = `Add On ${name}`.trim();
  return name.slice(0, 45);
}

export function nameIsGeneric(name) {
  return /^(?:express add on|express addon|add on|addon|plugin|panel|me plugin|extension|tool)$/i.test(String(name || "").trim());
}

/** The request does not say what the add-on does. */
export function goalIsThin(goal) {
  if (isBlankGoal(goal)) return true;
  const text = String(goal || "").trim();
  if (!text) return true;
  return nameIsGeneric(deriveName(text));
}

/** Folder slug from a display name. */
export function slugify(name) {
  return String(name || "express-add-on")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "express-add-on";
}

/** Set only when the sentence says Spectrum / SWC or plain controls. */
export function statedDesign(goal) {
  const text = String(goal || "");
  if (/\b(?:no|without|not)\s+spectrum\b|\bplain\s+(?:html|css|controls)\b|\bkeep\s+the\s+template/i.test(text)) return "leave";
  if (/\bspectrum\b|\bswc\b/i.test(text)) return "swc";
  return "";
}
