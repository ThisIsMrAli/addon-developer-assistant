/**
 * Runs an add-on's document sandbox module outside Express: ES module syntax is rewritten to an
 * async function with an import hook, TypeScript is stripped by Node, and the two sandbox SDK
 * names resolve to the document stand-in. Used by `record` (in a child process) and by tests.
 */
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { parseSource } from "./code-scan.mjs";

const AsyncFunction = (async () => {}).constructor;
const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} };

function stripTypes(file, text) {
  if (!/\.(tsx?|mts|cts)$/i.test(file)) return text;
  if (typeof module.stripTypeScriptTypes !== "function") throw new Error(`${path.basename(file)} is TypeScript, and this Node has no module.stripTypeScriptTypes to run it. Use Node 22.13 or later.`);
  try {
    return module.stripTypeScriptTypes(text, { mode: "transform" });
  } catch {
    return module.stripTypeScriptTypes(text, { mode: "strip" });
  }
}

function patternNames(node, out = []) {
  if (!node) return out;
  if (node.type === "Identifier") out.push(node.name);
  else if (node.type === "ObjectPattern") for (const prop of node.properties) patternNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
  else if (node.type === "ArrayPattern") for (const item of node.elements) patternNames(item, out);
  else if (node.type === "AssignmentPattern") patternNames(node.left, out);
  else if (node.type === "RestElement") patternNames(node.argument, out);
  return out;
}

/** ES module text → body of an async function (__import, __exports). */
export function toFunctionBody(file, source) {
  const text = stripTypes(file, source);
  const parsed = parseSource(file.replace(/\.(tsx?|mts|cts)$/i, ".js"), text);
  if (!parsed.ast) throw new Error(parsed.error);
  const edits = [];
  const tail = [];
  let n = 0;
  const key = (value) => JSON.stringify(String(value));
  for (const stmt of parsed.ast.program.body) {
    if (stmt.type === "ImportDeclaration") {
      if (stmt.importKind === "type") { edits.push([stmt.start, stmt.end, ""]); continue; }
      const id = `__m${(n += 1)}`;
      const lines = [`const ${id} = await __import(${key(stmt.source.value)});`];
      for (const spec of stmt.specifiers) {
        if (spec.importKind === "type") continue;
        if (spec.type === "ImportDefaultSpecifier") lines.push(`const ${spec.local.name} = ${id}.default !== undefined ? ${id}.default : ${id};`);
        else if (spec.type === "ImportNamespaceSpecifier") lines.push(`const ${spec.local.name} = ${id};`);
        else lines.push(`const ${spec.local.name} = ${id}[${key(spec.imported.name ?? spec.imported.value)}];`);
      }
      edits.push([stmt.start, stmt.end, lines.join(" ")]);
    } else if (stmt.type === "ExportNamedDeclaration") {
      if (stmt.exportKind === "type") { edits.push([stmt.start, stmt.end, ""]); continue; }
      if (stmt.declaration) {
        edits.push([stmt.start, stmt.declaration.start, ""]);
        const decl = stmt.declaration;
        const names = decl.type === "VariableDeclaration" ? decl.declarations.flatMap((item) => patternNames(item.id)) : decl.id ? [decl.id.name] : [];
        for (const name of names) tail.push(`__exports[${key(name)}] = ${name};`);
      } else if (stmt.source) {
        const id = `__m${(n += 1)}`;
        edits.push([stmt.start, stmt.end, `const ${id} = await __import(${key(stmt.source.value)}); ${stmt.specifiers.map((spec) => `__exports[${key(spec.exported.name ?? spec.exported.value)}] = ${id}[${key(spec.local?.name ?? spec.local?.value ?? "default")}];`).join(" ")}`]);
      } else {
        edits.push([stmt.start, stmt.end, ""]);
        for (const spec of stmt.specifiers) tail.push(`__exports[${key(spec.exported.name ?? spec.exported.value)}] = ${spec.local.name};`);
      }
    } else if (stmt.type === "ExportDefaultDeclaration") {
      const decl = stmt.declaration;
      if ((decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id) {
        edits.push([stmt.start, decl.start, ""]);
        tail.push(`__exports.default = ${decl.id.name};`);
      } else {
        edits.push([stmt.start, decl.start, "__exports.default = ("]);
        edits.push([decl.end, decl.end, ");"]);
      }
    } else if (stmt.type === "ExportAllDeclaration") {
      edits.push([stmt.start, stmt.end, `Object.assign(__exports, await __import(${key(stmt.source.value)}));`]);
    }
  }
  let out = text;
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0] || b[1] - a[1])) out = out.slice(0, start) + replacement + out.slice(end);
  return `${out}\n;${tail.join("\n")}`;
}

function resolveLocal(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  const tries = [base, ...[".js", ".mjs", ".ts", ".tsx", ".jsx", ".cjs"].map((ext) => base + ext), ...["index.js", "index.ts", "index.mjs"].map((name) => path.join(base, name))];
  if (/\.js$/.test(base)) tries.push(base.replace(/\.js$/, ".ts"));
  return tries.find((item) => fs.existsSync(item) && fs.statSync(item).isFile()) || "";
}

/**
 * Loads a sandbox module (and its local imports) against a document stand-in and returns what it
 * passed to runtime.exposeApi. `text` stands in for the entry file's contents when given.
 */
export async function loadEntry(entry, doc, text = null) {
  const cache = new Map();
  const load = async (file) => {
    if (cache.has(file)) return cache.get(file);
    const exportsObject = {};
    cache.set(file, exportsObject);
    const body = toFunctionBody(file, file === entry && text !== null ? text : fs.readFileSync(file, "utf8"));
    // Snippets often use editor/constants without importing them; they read the stand-in's, and a real import shadows them.
    const sdk = doc.modules["express-document-sdk"] || {};
    const run = new AsyncFunction("__import", "__exports", "console", "editor", "constants", "colorUtils", "fonts", `return (async () => {\n${body}\n})();`);
    await run(async (spec) => {
      if (doc.modules[spec]) return doc.modules[spec];
      if (spec.startsWith(".")) {
        const found = resolveLocal(file, spec);
        if (!found) throw new Error(`${path.basename(file)} imports ${spec}, which was not found.`);
        if (/\.(json)$/i.test(found)) return { default: JSON.parse(fs.readFileSync(found, "utf8")) };
        if (!/\.(mjs|cjs|jsx?|tsx?)$/i.test(found)) return { default: found };
        return load(found);
      }
      return { default: doc.permissive(spec) };
    }, exportsObject, quiet, sdk.editor, sdk.constants, sdk.colorUtils, sdk.fonts);
    return exportsObject;
  };
  doc.log.entryExports = await load(entry);
  // An entry that never calls runtime.exposeApi is read as exposing its exported functions.
  return doc.log.exposed || doc.log.entryExports;
}

