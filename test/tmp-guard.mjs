/**
 * Remove temp directories and files this process created under the temp dir.
 * Loaded with `node --import` so it wraps the fs calls before the tests run.
 * `node-compile-cache` is left in place.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = (() => {
  try { return fs.realpathSync(os.tmpdir()); } catch { return path.resolve(os.tmpdir()); }
})();
const initial = new Set(fs.readdirSync(tmpRoot));
const created = new Set();

function consider(target) {
  if (typeof target !== "string") return;
  const resolved = path.resolve(target);
  if (resolved !== tmpRoot && !resolved.startsWith(`${tmpRoot}${path.sep}`)) return;
  const top = resolved.slice(tmpRoot.length + 1).split(path.sep)[0];
  if (!top || top === "node-compile-cache" || initial.has(top)) return;
  created.add(path.join(tmpRoot, top));
}

const originalMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function trackedMkdtemp(prefix, options) {
  const dir = originalMkdtemp.call(fs, prefix, options);
  consider(dir);
  return dir;
};

const originalMkdir = fs.mkdirSync;
fs.mkdirSync = function trackedMkdir(target, options) {
  const result = originalMkdir.call(fs, target, options);
  consider(target);
  return result;
};

const originalWrite = fs.writeFileSync;
fs.writeFileSync = function trackedWrite(target, ...args) {
  const result = originalWrite.call(fs, target, ...args);
  consider(target);
  return result;
};

const originalAppend = fs.appendFileSync;
fs.appendFileSync = function trackedAppend(target, ...args) {
  const result = originalAppend.call(fs, target, ...args);
  consider(target);
  return result;
};

process.on("exit", () => {
  for (const entry of created) {
    try { fs.rmSync(entry, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});
