/**
 * What the Adobe Express document sandbox's JavaScript engine does not have.
 *
 * The document sandbox is "not a full fledged browser's JavaScript execution environment"
 * (references/document-sandbox/index.md). It runs on QuickJS (guides/learn/platform-concepts/architecture.md).
 * Its Web APIs are the console methods only (references/document-sandbox/web/index.md), and the
 * timer methods were removed (references/changelog.md: setTimeout, clearTimeout, setInterval, clearInterval).
 *
 * Evidence for the built-ins (NP11, heading-image 1.0.5 in real Express): `slots.at(-1)` threw
 * "not a function", so Array.prototype.at is missing. QuickJS added `.at` in its 2023-12-09 release,
 * together with Object.hasOwn and findLast/findLastIndex, so an engine without `.at` predates that
 * release and lacks everything QuickJS added in it or later (Changelog 2023-12-09, 2024-01-13,
 * 2025-04-26, 2025-09-13). Older built-ins that 1.0.4 used in real Express (`??`, spread, Set, find)
 * and ones QuickJS shipped earlier (replaceAll 2020-01-05, flat/flatMap, Promise.any 2020-04-12) stay.
 *
 * This file has no imports, so the browser stand-in can load it as it is.
 */

export const QUICKJS_CHANGELOG = "https://github.com/bellard/quickjs/blob/master/Changelog";
const DOCS = "https://developer.adobe.com/express/add-ons/docs/references/document-sandbox";

/** Prototype methods: [owner name, method, QuickJS release that added it]. */
export const MISSING_PROTOTYPE_METHODS = [
  ["Array", "at", "2023-12-09"],
  ["String", "at", "2023-12-09"],
  ["TypedArray", "at", "2023-12-09"],
  ["Array", "findLast", "2023-12-09"],
  ["Array", "findLastIndex", "2023-12-09"],
  ["TypedArray", "findLast", "2023-12-09"],
  ["TypedArray", "findLastIndex", "2023-12-09"],
  ["Array", "toSorted", "2024-01-13"],
  ["Array", "toReversed", "2024-01-13"],
  ["Array", "toSpliced", "2024-01-13"],
  ["Array", "with", "2024-01-13"],
  ["TypedArray", "toSorted", "2024-01-13"],
  ["TypedArray", "toReversed", "2024-01-13"],
  ["TypedArray", "with", "2024-01-13"],
  ["String", "isWellFormed", "2024-01-13"],
  ["String", "toWellFormed", "2024-01-13"]
];

/** Static functions: [owner, name, release]. */
export const MISSING_STATIC_METHODS = [
  ["Object", "hasOwn", "2023-12-09"],
  ["Object", "groupBy", "2024-01-13"],
  ["Map", "groupBy", "2024-01-13"],
  ["Promise", "withResolvers", "2024-01-13"],
  ["Promise", "try", "2025-09-13"],
  ["Error", "isError", "2025-09-13"],
  ["RegExp", "escape", "2025-09-13"],
  ["Math", "sumPrecise", "2026-06-04"]
];

/** Globals that are not in the document sandbox. */
export const MISSING_GLOBALS = [
  ["structuredClone", "a Web API that the document sandbox does not provide (its Web APIs are the console methods)", `${DOCS}/web/`],
  ["setTimeout", "removed from the document sandbox (Adobe changelog: timer methods are no longer supported)", "https://developer.adobe.com/express/add-ons/docs/references/changelog"],
  ["setInterval", "removed from the document sandbox (Adobe changelog: timer methods are no longer supported)", "https://developer.adobe.com/express/add-ons/docs/references/changelog"],
  ["clearTimeout", "removed from the document sandbox (Adobe changelog: timer methods are no longer supported)", "https://developer.adobe.com/express/add-ons/docs/references/changelog"],
  ["clearInterval", "removed from the document sandbox (Adobe changelog: timer methods are no longer supported)", "https://developer.adobe.com/express/add-ons/docs/references/changelog"],
  ["fetch", "not in the document sandbox; call it in the iframe panel and pass the result over the communication API", "https://developer.adobe.com/express/add-ons/docs/guides/learn/platform-concepts/architecture"],
  ["WeakRef", "added to QuickJS in 2025-04-26, after the release the Express engine predates", QUICKJS_CHANGELOG],
  ["FinalizationRegistry", "added to QuickJS in 2025-04-26, after the release the Express engine predates", QUICKJS_CHANGELOG]
];

export const MISSING_GLOBAL_NAMES = MISSING_GLOBALS.map(([name]) => name);

const PROTO_NAMES = new Set(MISSING_PROTOTYPE_METHODS.map(([, name]) => name));

/** A short sentence on why `owner.name` fails in Express. */
export function missingReason(owner, name) {
  const proto = MISSING_PROTOTYPE_METHODS.find(([o, n]) => n === name && (!owner || o === owner));
  if (proto) return `${proto[0]}.prototype.${name} is not in the Express document sandbox's JavaScript engine (QuickJS added it in its ${proto[2]} release; real Express threw "not a function" on Array.prototype.at, so its engine predates the 2023-12-09 release). In Express the call throws.`;
  const stat = MISSING_STATIC_METHODS.find(([o, n]) => o === owner && n === name);
  if (stat) return `${owner}.${name} is not in the Express document sandbox's JavaScript engine (QuickJS added it in its ${stat[2]} release; the Express engine predates 2023-12-09, as Array.prototype.at is missing there). In Express the call throws "not a function".`;
  const glob = MISSING_GLOBALS.find(([n]) => n === name);
  if (glob) return `${name} is ${glob[1]}.`;
  return "";
}

/** A plain replacement the reason can suggest. */
export function replacementFor(name) {
  return {
    at: "use list[list.length - 1] (or list[i]) instead of .at()",
    findLast: "loop from the end, or use a reversed copy with slice().reverse().find()",
    findLastIndex: "loop from the end",
    toSorted: "use slice().sort()",
    toReversed: "use slice().reverse()",
    toSpliced: "use slice() and splice() on the copy",
    with: "copy with slice() and assign the index",
    hasOwn: "use Object.prototype.hasOwnProperty.call(object, key)",
    structuredClone: "copy plain data with JSON.parse(JSON.stringify(value)) or by hand",
    setTimeout: "do the waiting in the iframe panel, then call the sandbox",
    setInterval: "do the waiting in the iframe panel, then call the sandbox",
    fetch: "fetch in the iframe panel and pass the result to the sandbox"
  }[name] || "";
}

/**
 * Remove the missing built-ins from this realm, so code run here fails the way it fails in Express.
 * Only for a process (or page) that runs add-on sandbox code and nothing else that needs them.
 */
export function stripNewerBuiltins(target = globalThis) {
  const removed = [];
  const typed = Object.getPrototypeOf(Int8Array.prototype);
  const owners = { Array: target.Array?.prototype, String: target.String?.prototype, TypedArray: typed };
  for (const [owner, name] of MISSING_PROTOTYPE_METHODS) {
    const proto = owners[owner];
    if (proto && Object.prototype.hasOwnProperty.call(proto, name) && delete proto[name]) removed.push(`${owner}.prototype.${name}`);
  }
  for (const [owner, name] of MISSING_STATIC_METHODS) {
    const object = target[owner];
    if (object && Object.prototype.hasOwnProperty.call(object, name) && delete object[name]) removed.push(`${owner}.${name}`);
  }
  // Array.prototype[Symbol.unscopables] names `at`, `findLast` and the rest; that does not make them callable.
  return removed;
}

/**
 * Uses of the missing built-ins in one parsed program. `walk` is the caller's AST walker.
 * Returns [{ name, owner, line, reason }]. Member calls `.at()` and the like are flagged whatever
 * the receiver, because a sandbox file rarely defines its own `at` method, and in Express the
 * array and string ones are absent.
 */
export function engineUses(ast, walk) {
  const found = [];
  const declared = new Set();
  walk(ast, (node) => {
    if ((node.type === "VariableDeclarator" || node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id?.type === "Identifier") declared.add(node.id.name);
    if ((node.type === "ClassMethod" || node.type === "ObjectMethod" || node.type === "ObjectProperty") && !node.computed && node.key?.type === "Identifier" && PROTO_NAMES.has(node.key.name)) declared.add(`.${node.key.name}`);
  });
  const add = (name, owner, node) => {
    const reason = missingReason(owner, name);
    if (!reason) return;
    found.push({ name, owner, line: node.loc?.start?.line || 0, reason, fix: replacementFor(name) });
  };
  walk(ast, (node) => {
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = node.callee;
      if ((callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") && !callee.computed && callee.property?.type === "Identifier") {
        const name = callee.property.name;
        const object = callee.object;
        if (object?.type === "Identifier" && MISSING_STATIC_METHODS.some(([o, n]) => o === object.name && n === name)) { add(name, object.name, node); return; }
        if (PROTO_NAMES.has(name) && !declared.has(`.${name}`)) add(name, MISSING_PROTOTYPE_METHODS.find(([, n]) => n === name)[0], node);
      }
      if (callee?.type === "Identifier" && MISSING_GLOBAL_NAMES.includes(callee.name) && !declared.has(callee.name)) add(callee.name, "", node);
    }
    if (node.type === "NewExpression" && node.callee?.type === "Identifier" && ["WeakRef", "FinalizationRegistry"].includes(node.callee.name) && !declared.has(node.callee.name)) add(node.callee.name, "", node);
  });
  return found;
}
