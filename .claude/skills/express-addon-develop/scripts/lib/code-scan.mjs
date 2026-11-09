/**
 * Read JavaScript and HTML as code, not as a bag of strings.
 * Comments and string literals do not count as calls. A broken statement is a syntax error.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ID_START = /[A-Za-z_$]/;
const ID_CHAR = /[A-Za-z0-9_$]/;

/** Calls and a syntax note from one source string. Comments are skipped. */
export function scanJs(source) {
  const text = String(source || "");
  const calls = [];
  const words = [];
  let syntax = "";
  let i = 0;
  let dotted = "";
  let dot = false;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      dotted = "";
      dot = false;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i = Math.min(text.length, i + 2);
      dotted = "";
      dot = false;
      continue;
    }
    if (c === "'" || c === "\"") {
      i = skipQuoted(text, i, c);
      dotted = "";
      dot = false;
      continue;
    }
    if (c === "`") {
      i = skipTemplate(text, i);
      dotted = "";
      dot = false;
      continue;
    }
    if (ID_START.test(c)) {
      const start = i;
      i += 1;
      while (i < text.length && ID_CHAR.test(text[i])) i += 1;
      const word = text.slice(start, i);
      words.push(word);
      dotted = dot && dotted ? `${dotted}.${word}` : word;
      dot = false;
      continue;
    }
    if (c === "." && dotted) {
      dot = true;
      i += 1;
      continue;
    }
    if (c === "(" && dotted && !dot) {
      calls.push(dotted);
      dotted = "";
      i += 1;
      continue;
    }
    if (c === "=") {
      let j = i + 1;
      while (j < text.length && /[\s]/.test(text[j])) j += 1;
      if (text[j] === ";") syntax = "A statement is missing its value.";
      dotted = "";
      i += 1;
      continue;
    }
    if (!/\s/.test(c)) dotted = "";
    i += 1;
  }
  return { calls, words, syntax };
}

/** The same source with comments removed, so a word in a comment cannot satisfy a check. */
export function stripComments(source) {
  return String(source || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/** Tags and visible text from HTML. Comments and the title element are not controls. */
export function scanHtml(source) {
  const without = String(source || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<title[\s\S]*?<\/title>/gi, " ");
  const tags = [];
  for (const match of without.matchAll(/<\/?([a-zA-Z][\w:-]*)\b/g)) tags.push(match[1].toLowerCase());
  const text = without
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const controls = tags.some((tag) => ["button", "input", "textarea", "select", "a", "sp-button", "sp-textfield", "sp-textarea", "sp-picker", "sp-checkbox", "sp-switch", "sp-theme"].includes(tag));
  return { tags, text, controls };
}

/**
 * `node --check` on a JavaScript file. ESM syntax is checked as a module.
 * A syntax error is returned even when a bundler would exit 0.
 */
export function checkJsSyntax(file) {
  const text = fs.readFileSync(file, "utf8");
  const scanned = scanJs(text);
  if (scanned.syntax) return scanned.syntax;
  if (!/\.(mjs|cjs|js)$/i.test(file)) return "";
  const stripped = stripComments(text);
  const asModule = !/\.cjs$/i.test(file) && (/\.mjs$/i.test(file) || /^\s*(import|export)\b/m.test(stripped) || /\bawait\b/.test(stripped));
  // --input-type is only legal on stdin. A .mjs path is already a module.
  const result = /\.mjs$/i.test(file)
    ? spawnSync(process.execPath, ["--check", file], { encoding: "utf8" })
    : asModule
      ? spawnSync(process.execPath, ["--check", "--input-type=module"], { input: text, encoding: "utf8" })
      : spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status === 0) return "";
  const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim().split("\n").slice(-4).join(" ");
  return detail || "The file does not parse.";
}

export function checkJsText(name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-scan-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  try {
    return checkJsSyntax(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function skipQuoted(text, i, quote) {
  i += 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

function skipTemplate(text, i) {
  i += 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "`") return i + 1;
    if (text[i] === "$" && text[i + 1] === "{") {
      i += 2;
      let depth = 1;
      while (i < text.length && depth) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") depth -= 1;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return i;
}
