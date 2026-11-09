/**
 * Read JavaScript and HTML as code, not as a bag of strings.
 * Comments and string literals do not count as calls. A broken statement is a syntax error.
 * Decorators and TypeScript are parsed with a parser that accepts them, not with `node --check`.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ID_START = /[A-Za-z_$]/;
const ID_CHAR = /[A-Za-z0-9_$]/;
const PARSER_PLUGINS = [["decorators", { decoratorsBeforeExport: true }], "typescript", "jsx"];
const SPECTRUM_CONTROLS = new Set([
  "sp-action-button", "sp-button", "sp-checkbox", "sp-link", "sp-menu", "sp-number-field",
  "sp-picker", "sp-radio", "sp-search", "sp-slider", "sp-switch", "sp-textfield", "sp-textarea"
]);
const PLAIN_CONTROLS = new Set(["a", "button", "input", "select", "textarea", ...SPECTRUM_CONTROLS]);

const VENDORED_PARSER = fileURLToPath(new URL("../../vendor/babel-parser/lib/index.js", import.meta.url));

let parserModule;

/**
 * The parser shipped inside the skill. A missing file is a hard failure.
 * The skill does not fall back to "not installed", and it does not look up `node_modules`.
 */
export function loadVendoredParser(file = VENDORED_PARSER) {
  if (!fs.existsSync(file)) {
    const error = new Error(`The vendored @babel/parser is missing at ${file}. The skill cannot parse decorators or TypeScript. It does not continue without that file, and npm install is not how this parser is provided.`);
    error.parserMissing = true;
    throw error;
  }
  return createRequire(file)(file);
}

function loadParser() {
  if (parserModule) return parserModule;
  parserModule = loadVendoredParser();
  return parserModule;
}

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
  const controls = tags.some((tag) => PLAIN_CONTROLS.has(tag));
  return { tags, text, controls };
}

/**
 * Parse one source file. Decorators (`@customElement`) and TypeScript are accepted.
 * The returned error is the parser message with the file and line, never a stack tail.
 */
export function parseSource(filename, text) {
  const parser = loadParser();
  try {
    const ast = parser.parse(String(text || ""), {
      sourceType: /\.cjs$/i.test(filename) ? "script" : "unambiguous",
      sourceFilename: filename,
      plugins: PARSER_PLUGINS,
      errorRecovery: false
    });
    return { ast, error: "" };
  } catch (error) {
    const line = error.loc?.line;
    const column = error.loc?.column;
    const where = line ? `${filename}:${line}${Number.isInteger(column) ? `:${column + 1}` : ""}` : filename;
    const message = String(error.message || "The file does not parse.").split("\n")[0];
    return { ast: null, error: `${where} ${message}` };
  }
}

/**
 * Syntax of a JavaScript or TypeScript file.
 * `node --check` rejects Adobe's own decorator syntax and only keeps the stack tail.
 */
export function checkJsSyntax(file) {
  const text = fs.readFileSync(file, "utf8");
  const scanned = scanJs(text);
  if (scanned.syntax) return scanned.syntax;
  if (!/\.(mjs|cjs|jsx?|tsx?)$/i.test(file)) return "";
  return parseSource(file, text).error;
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

/**
 * Markup the panel actually renders: HTML, Lit `html` templates, and JSX.
 * A tag in a comment or in an ordinary string is not a control. `sp-theme` alone is not a form control.
 */
export function panelMarkup(text, filename = "panel.js") {
  const fromHtml = /\.html?$/i.test(filename) ? describeHtml(text) : emptyPanel();
  const parsed = /\.(mjs|cjs|jsx?|tsx?)$/i.test(filename) ? parseSource(filename, text) : { ast: null, error: "" };
  const fromCode = parsed.ast ? panelFromAst(parsed.ast) : emptyPanel();
  return mergePanels([fromHtml, fromCode]);
}

/** HTML files plus JS/TS sources plus a built bundle, judged the same way. */
export function projectPanels(files) {
  const parts = files.map((file) => panelMarkup(file.text, file.rel || file.file || "panel.js"));
  return mergePanels(parts);
}

/**
 * Where setItem/getItem/removeItem actually reads from.
 * A parameter named clientStorage that was passed localStorage is localStorage.
 */
export function storageKinds(files) {
  const programs = [];
  for (const file of files) {
    if (!/\.(mjs|cjs|jsx?|tsx?)$/i.test(file.rel || file.file || "")) continue;
    const parsed = parseSource(file.rel || file.file, file.text);
    if (parsed.ast) programs.push(parsed.ast);
  }
  const names = new WeakMap();
  const functions = [];
  for (const ast of programs) {
    walk(ast, (node) => {
      if (node.type === "FunctionDeclaration" && node.id?.name) names.set(node, node.id.name);
      if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && isFunction(node.init)) names.set(node.init, node.id.name);
      if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") && names.has(node)) {
        functions.push({ name: names.get(node), params: paramNames(node), node });
      }
    });
  }
  const calledWith = new Map();
  for (const ast of programs) {
    walk(ast, (node, stack) => {
      if (node.type !== "CallExpression") return;
      const name = calleeName(node.callee);
      if (!name || !functions.some((item) => item.name === name)) return;
      const args = (node.arguments || []).map((arg) => classifyArgument(arg, stack, ast));
      const list = calledWith.get(name) || [];
      list.push(args);
      calledWith.set(name, list);
    });
  }
  let client = false;
  let local = false;
  const note = (kind) => {
    if (kind === "client") client = true;
    if (kind === "local") local = true;
  };
  for (const ast of programs) {
    walk(ast, (node, stack) => {
      if (node.type !== "CallExpression") return;
      const prop = memberProperty(node.callee);
      if (!/^(getItem|setItem|removeItem)$/.test(prop)) return;
      note(resolveReceiver(node.callee.object, stack, calledWith, names));
    });
  }
  return { client, local };
}

/**
 * A throw or authorize() that is not inside a try, and whose function is not called from a try.
 * A catch in some other function does not cover it.
 */
export function controlFlow(files) {
  const programs = [];
  for (const file of files) {
    if (!/\.(mjs|cjs|jsx?|tsx?)$/i.test(file.rel || file.file || "")) continue;
    const parsed = parseSource(file.rel || file.file, file.text);
    if (parsed.ast) programs.push({ rel: file.rel || file.file, ast: parsed.ast });
  }
  const names = new WeakMap();
  for (const { ast } of programs) {
    walk(ast, (node) => {
      if (node.type === "FunctionDeclaration" && node.id?.name) names.set(node, node.id.name);
      if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && isFunction(node.init)) names.set(node.init, node.id.name);
    });
  }
  const calledInTry = new Set();
  for (const { ast } of programs) {
    walk(ast, (node, stack) => {
      if (node.type !== "CallExpression") return;
      const name = calleeName(node.callee);
      if (name && stack.some((item) => item.type === "TryStatement")) calledInTry.add(name);
    });
  }
  let unhandledThrow = false;
  let unhandledAuthorize = false;
  for (const { ast } of programs) {
    walk(ast, (node, stack) => {
      const covered = stack.some((item) => item.type === "TryStatement") || calledFromTry(stack, names, calledInTry);
      if (node.type === "ThrowStatement" && !covered) unhandledThrow = true;
      if (node.type === "CallExpression" && isAuthorize(node.callee) && !covered) unhandledAuthorize = true;
    });
  }
  return { unhandledThrow, unhandledAuthorize };
}

function calledFromTry(stack, names, calledInTry) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const name = names.get(stack[i]);
    if (name && calledInTry.has(name)) return true;
  }
  return false;
}

function resolveReceiver(object, stack, calledWith, names) {
  const chain = memberChain(object);
  if (!chain) return "";
  if (chain.length > 1) return chain.includes("clientStorage") ? "client" : chain[0] === "localStorage" ? "local" : "";
  const name = chain[0];
  if (name === "localStorage") return "local";
  const fn = [...stack].reverse().find((item) => isFunction(item));
  if (fn) {
    const params = paramNames(fn);
    const index = params.indexOf(name);
    if (index >= 0) {
      const fnName = names.get(fn) || "";
      const sites = calledWith.get(fnName) || [];
      let kind = "";
      for (const args of sites) {
        const arg = args[index];
        if (arg === "client") return "client";
        if (arg === "local") kind = "local";
      }
      return kind;
    }
  }
  const bound = bindingOf(name, stack);
  if (bound) return bound;
  return "";
}

function bindingOf(name, stack) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const node = stack[i];
    if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression" && node.type !== "ArrowFunctionExpression" && node.type !== "Program" && node.type !== "BlockStatement") continue;
    const body = node.type === "Program" || node.type === "BlockStatement" ? node.body : node.body?.body;
    const list = Array.isArray(body) ? body : [];
    for (const statement of list) {
      if (statement.type !== "VariableDeclaration") continue;
      for (const decl of statement.declarations) {
        if (decl.id?.type === "Identifier" && decl.id.name === name) return classifyArgument(decl.init, stack, null);
      }
    }
  }
  return "";
}

function classifyArgument(node, stack, ast) {
  if (!node) return "";
  if (node.type === "Identifier") {
    if (node.name === "localStorage") return "local";
    const bound = bindingOf(node.name, stack);
    if (bound) return bound;
    if (ast) {
      let found = "";
      walk(ast, (item) => {
        if (item.type === "VariableDeclarator" && item.id?.type === "Identifier" && item.id.name === node.name) {
          const chain = memberChain(item.init);
          if (chain?.includes("clientStorage")) found = "client";
          if (chain?.[0] === "localStorage") found = "local";
        }
      });
      if (found) return found;
    }
    return "";
  }
  const chain = memberChain(node);
  if (!chain) return "";
  if (chain.includes("clientStorage")) return "client";
  if (chain[0] === "localStorage") return "local";
  return "";
}

function isAuthorize(callee) {
  return memberProperty(callee) === "authorize" || (callee.type === "Identifier" && callee.name === "authorize");
}

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property?.type === "Identifier") return callee.property.name;
  return "";
}

function memberProperty(callee) {
  if (callee?.type === "MemberExpression" && !callee.computed && callee.property?.type === "Identifier") return callee.property.name;
  return "";
}

function memberChain(node) {
  const parts = [];
  let current = node;
  while (current) {
    if (current.type === "Identifier") {
      parts.unshift(current.name);
      return parts;
    }
    if (current.type === "MemberExpression" && !current.computed && current.property?.type === "Identifier") {
      parts.unshift(current.property.name);
      current = current.object;
      continue;
    }
    if (current.type === "ThisExpression") {
      parts.unshift("this");
      return parts;
    }
    return null;
  }
  return null;
}

function paramNames(fn) {
  return (fn.params || []).map((param) => {
    if (param.type === "Identifier") return param.name;
    if (param.type === "AssignmentPattern" && param.left?.type === "Identifier") return param.left.name;
    return "";
  });
}

function isFunction(node) {
  return node && (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression");
}

function panelFromAst(ast) {
  const tags = [];
  const texts = [];
  walk(ast, (node) => {
    if (node.type === "TaggedTemplateExpression" && tagName(node.tag) === "html") {
      const html = (node.quasi?.quasis || []).map((part) => part.value?.cooked || "").join(" ");
      const scanned = scanHtml(html);
      tags.push(...scanned.tags);
      if (scanned.text) texts.push(scanned.text);
    }
    if (node.type === "JSXOpeningElement") {
      const name = jsxName(node.name);
      if (name) tags.push(name.toLowerCase());
    }
    if (node.type === "JSXText" && node.value.trim()) texts.push(node.value.replace(/\s+/g, " ").trim());
  });
  return describeTags(tags, texts.join(" "));
}

function tagName(tag) {
  if (!tag) return "";
  if (tag.type === "Identifier") return tag.name;
  if (tag.type === "MemberExpression" && !tag.computed && tag.property?.type === "Identifier") return tag.property.name;
  return "";
}

function jsxName(name) {
  if (!name) return "";
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") return name.property?.name || "";
  return "";
}

function describeHtml(text) {
  const scanned = scanHtml(text);
  return describeTags(scanned.tags, scanned.text);
}

function describeTags(tags, text) {
  return {
    tags,
    text: String(text || "").replace(/\s+/g, " ").trim(),
    controls: tags.some((tag) => PLAIN_CONTROLS.has(tag)),
    spectrum: tags.some((tag) => SPECTRUM_CONTROLS.has(tag))
  };
}

function emptyPanel() {
  return { tags: [], text: "", controls: false, spectrum: false };
}

function mergePanels(parts) {
  const tags = parts.flatMap((part) => part.tags);
  const text = parts.map((part) => part.text).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return {
    tags,
    text,
    controls: parts.some((part) => part.controls),
    spectrum: parts.some((part) => part.spectrum)
  };
}

function walk(node, visit, stack = []) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  visit(node, stack);
  const next = stack.concat(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visit, next);
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      walk(value, visit, next);
    }
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
