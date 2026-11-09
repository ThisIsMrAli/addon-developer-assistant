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
 * A throw or authorize() is covered when a try/catch reaches it.
 * That includes a wrapper (`_run`, `_guard`, `_act`) whose parameter is called inside the try,
 * and a throw several calls deeper than the guarded handler.
 * A catch in some other function that never calls this one does not cover it.
 */
export function controlFlow(files) {
  const programs = [];
  for (const file of files) {
    if (!/\.(mjs|cjs|jsx?|tsx?)$/i.test(file.rel || file.file || "")) continue;
    const parsed = parseSource(file.rel || file.file, file.text);
    if (parsed.ast) programs.push(parsed.ast);
  }
  let nextId = 0;
  const idOf = new WeakMap();
  const byName = new Map();
  const identify = (node, name) => {
    if (!idOf.has(node)) idOf.set(node, ++nextId);
    const id = idOf.get(node);
    if (name) {
      const list = byName.get(name) || [];
      if (!list.includes(id)) list.push(id);
      byName.set(name, list);
    }
    return id;
  };
  for (const ast of programs) {
    walk(ast, (node) => {
      if (node.type === "FunctionDeclaration" && node.id?.name) identify(node, node.id.name);
      if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && isFunction(node.init)) identify(node.init, node.id.name);
      if ((node.type === "ClassMethod" || node.type === "ObjectMethod" || node.type === "ClassPrivateMethod") && node.key?.type === "Identifier") identify(node, node.key.name);
      if (node.type === "Property" && !node.computed && node.key?.type === "Identifier" && isFunction(node.value)) identify(node.value, node.key.name);
      if ((isFunction(node) || node.type === "ClassMethod" || node.type === "ObjectMethod") && !idOf.has(node)) identify(node, "");
    });
  }
  for (const ast of programs) {
    walk(ast, (node) => {
      if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier" || node.init?.type !== "Identifier") return;
      const ids = byName.get(node.init.name);
      if (!ids) return;
      const list = byName.get(node.id.name) || [];
      for (const id of ids) if (!list.includes(id)) list.push(id);
      byName.set(node.id.name, list);
    });
  }
  const invocations = new Map();
  const invoke = (id, inTry, callerId) => {
    if (!id) return;
    const list = invocations.get(id) || [];
    list.push({ inTry, callerId });
    invocations.set(id, list);
  };
  const callbackSlots = new Map();
  for (const ast of programs) {
    walk(ast, (node) => {
      if (!isCallable(node)) return;
      const id = idOf.get(node);
      const params = paramNames(node);
      const slots = new Set();
      walk(node.body, (inner, innerStack) => {
        if (inner.type !== "CallExpression") return;
        const inTry = innerStack.some((item) => item.type === "TryStatement");
        if (!inTry) return;
        if (inner.callee?.type === "Identifier") {
          const index = params.indexOf(inner.callee.name);
          if (index >= 0) slots.add(index);
        }
        if (inner.callee?.type === "MemberExpression" && ARRAY_METHODS.has(calleeName(inner.callee))) {
          const arg = inner.arguments?.[0];
          if (arg?.type === "Identifier") {
            const index = params.indexOf(arg.name);
            if (index >= 0) slots.add(index);
          }
        }
      });
      if (slots.size) callbackSlots.set(id, slots);
    });
  }
  for (const ast of programs) {
    walk(ast, (node, stack) => {
      if (node.type !== "CallExpression") return;
      const callerId = enclosingFn(stack, idOf);
      const here = stack.some((item) => item.type === "TryStatement");
      const name = calleeName(node.callee);
      const ids = name && byName.has(name) ? byName.get(name) : [];
      for (const id of ids) invoke(id, here, callerId);
      const arrayMethod = node.callee?.type === "MemberExpression" && ARRAY_METHODS.has(name);
      const thenCaught = name === "then" && stack.some((item) => item.type === "CallExpression" && calleeName(item.callee) === "catch");
      node.arguments?.forEach((arg, index) => {
        const wrapped = ids.some((id) => callbackSlots.get(id)?.has(index));
        const arrayCb = arrayMethod && index === 0;
        const linked = wrapped || arrayCb || thenCaught;
        if (isFunction(arg) && linked) invoke(idOf.get(arg), wrapped || thenCaught || here, callerId);
        const target = boundName(arg);
        if (linked && target && byName.has(target)) {
          const coveredHere = wrapped || thenCaught || (arrayCb && here);
          for (const id of byName.get(target)) invoke(id, coveredHere, callerId);
        }
      });
    });
  }
  const covered = (id, seen = new Set()) => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    const sites = invocations.get(id) || [];
    if (!sites.length) return false;
    return sites.every((site) => site.inTry || (site.callerId && covered(site.callerId, seen)));
  };
  let unhandledThrow = false;
  let unhandledAuthorize = false;
  for (const ast of programs) {
    walk(ast, (node, stack) => {
      const fnId = enclosingFn(stack, idOf);
      const safe = stack.some((item) => item.type === "TryStatement") || (fnId && covered(fnId));
      if (node.type === "ThrowStatement" && !safe) unhandledThrow = true;
      if (node.type === "CallExpression" && isAuthorize(node.callee) && !safe) unhandledAuthorize = true;
    });
  }
  return { unhandledThrow, unhandledAuthorize };
}

const ARRAY_METHODS = new Set(["map", "forEach", "filter", "find", "findIndex", "some", "every", "flatMap", "reduce", "reduceRight"]);

function boundName(arg) {
  if (arg?.type === "Identifier") return arg.name;
  if (arg?.type === "CallExpression" && calleeName(arg.callee) === "bind") {
    const object = arg.callee.object;
    if (object?.type === "Identifier") return object.name;
    if (object?.type === "MemberExpression" && !object.computed && object.property?.type === "Identifier") return object.property.name;
  }
  return "";
}

function isCallable(node) {
  return isFunction(node) || node?.type === "ClassMethod" || node?.type === "ObjectMethod" || node?.type === "ClassPrivateMethod";
}

function enclosingFn(stack, idOf) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (isCallable(stack[i]) && idOf.has(stack[i])) return idOf.get(stack[i]);
  }
  return 0;
}

const IMAGE_CALL = /(^|\.)(addImage|createImage|createImageContainer|loadBitmapImage)$/;

function isSandboxProxyCall(callee) {
  if (callee?.type !== "MemberExpression") return false;
  const chain = memberChain(callee.object) || [];
  return chain.some((part) => part === "proxy" || /sandboxproxy/i.test(part));
}

/** Half of the page width, or a loop that steps across it. `page.width / 2 +` and `page.width * 0.5 +` are the same offset. */
export function hasColumnPlacement(text) {
  const parsed = parseSource("layout.js", String(text || ""));
  if (!parsed.ast) return false;
  let ok = false;
  walk(parsed.ast, (node) => {
    if (node.type === "BinaryExpression" && node.operator === "+" && (isHalfWidth(node.left) || isHalfWidth(node.right))) ok = true;
    if (forLoopSpansPage(node)) ok = true;
  });
  return ok;
}

function isHalfWidth(node) {
  if (!node || node.type !== "BinaryExpression") return false;
  const width = (part) => part?.type === "MemberExpression" && !part.computed && part.property?.name === "width";
  const half = (part) => part?.type === "NumericLiteral" && Math.abs(part.value - 0.5) < 1e-9;
  if (node.operator === "/" && width(node.left) && node.right?.type === "NumericLiteral" && node.right.value === 2) return true;
  if (node.operator === "*" && ((width(node.left) && half(node.right)) || (width(node.right) && half(node.left)))) return true;
  return false;
}

function forLoopSpansPage(node) {
  if (node?.type !== "ForStatement" || !node.test) return false;
  const update = node.update;
  const steps = update?.type === "UpdateExpression" || (update?.type === "AssignmentExpression" && update.operator === "+=");
  if (!steps) return false;
  let width = false;
  walk(node.test, (inner) => {
    if (inner.type === "MemberExpression" && !inner.computed && inner.property?.name === "width") width = true;
  });
  return width;
}

function insideKeptEdit(stack) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const fn = stack[i];
    if (!isFunction(fn)) continue;
    for (let j = i - 1; j >= 0; j -= 1) {
      const call = stack[j];
      if (call.type !== "CallExpression" || !call.arguments?.includes(fn)) continue;
      const name = calleeName(call.callee);
      if (name === "queueAsyncEdit") return true;
      if (name === "keepContentActiveDuringAsync" && call.arguments[2] === fn) return true;
    }
  }
  return false;
}

/** createImageContainer must run in the documented afterAsyncCallback, or in queueAsyncEdit. */
export function imageKeepsContentActive(files) {
  let saw = false;
  let bad = false;
  for (const file of files) {
    if (!/\.(mjs|cjs|jsx?|tsx?)$/i.test(file.rel || file.file || "")) continue;
    const parsed = parseSource(file.rel || file.file, String(file.text || ""));
    if (!parsed.ast) continue;
    walk(parsed.ast, (node, stack) => {
      if (node.type !== "CallExpression" || calleeName(node.callee) !== "createImageContainer") return;
      if (isSandboxProxyCall(node.callee)) return;
      saw = true;
      if (!insideKeptEdit(stack)) bad = true;
    });
  }
  return !saw || !bad;
}

/** An image call is placed when its function uses the shared free-space layout, not the page center alone. A sandbox proxy call is not the iframe image API. */
export function imagePlacedWithContent(files) {
  let saw = false;
  let unplaced = false;
  for (const file of files) {
    if (!/\.(mjs|cjs|jsx?|tsx?)$/i.test(file.rel || file.file || "")) continue;
    const text = String(file.text || "");
    const parsed = parseSource(file.rel || file.file, text);
    if (!parsed.ast) continue;
    const layout = /boundsInParent/.test(text) && hasColumnPlacement(text);
    walk(parsed.ast, (node, stack) => {
      if (node.type !== "CallExpression") return;
      if (isSandboxProxyCall(node.callee)) return;
      const called = calleeName(node.callee);
      if (!called || !IMAGE_CALL.test(called)) return;
      saw = true;
      const owner = [...stack].reverse().find((item) => isCallable(item));
      const body = owner && Number.isInteger(owner.start) && Number.isInteger(owner.end) ? text.slice(owner.start, owner.end) : text;
      const shares = /boundsInParent/.test(body) || /placeOnPage\s*\(|placeImageNode\s*\(|placeHeading\s*\(/.test(body);
      if (!shares || !layout) unplaced = true;
    });
  }
  return saw && !unplaced;
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
