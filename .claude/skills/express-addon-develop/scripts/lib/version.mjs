/**
 * Sets the add-on's version for a resubmission. The manifest (src/manifest.json or manifest.json)
 * and package.json carry the same X.Y.Z. Only the "version" value changes; the rest of each file is kept.
 */
import fs from "node:fs";
import path from "node:path";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function addonVersionFiles(dir) {
  const files = [];
  for (const rel of ["src/manifest.json", "manifest.json", "package.json"]) {
    const full = path.join(dir, rel);
    if (fs.existsSync(full)) files.push(full);
  }
  return files;
}

export function nextVersion(current, bump) {
  const match = String(current || "").match(SEMVER);
  if (!match) throw new Error(`The current version "${current}" is not X.Y.Z, so it cannot be bumped. Pass --set X.Y.Z.`);
  let [major, minor, patch] = match.slice(1).map(Number);
  if (bump === "major") [major, minor, patch] = [major + 1, 0, 0];
  else if (bump === "minor") [minor, patch] = [minor + 1, 0];
  else if (bump === "patch") patch += 1;
  else throw new Error(`--bump takes patch, minor or major, not "${bump}".`);
  return `${major}.${minor}.${patch}`;
}

export function setAddonVersion(dir, { set = "", bump = "" } = {}) {
  const files = addonVersionFiles(dir);
  const manifest = files.find((file) => file.endsWith("manifest.json"));
  if (!manifest) throw new Error(`No manifest.json in ${dir} or ${path.join(dir, "src")}.`);
  const current = JSON.parse(fs.readFileSync(manifest, "utf8")).version || "";
  if (set && bump) throw new Error(`Pass --set or --bump, not both. --set ${set} would hide --bump ${bump}.`);
  if (!set && !bump) return { ok: true, changed: false, version: current, files: files.map((file) => path.relative(dir, file)) };
  const to = set ? String(set).trim() : nextVersion(current, bump);
  if (!SEMVER.test(to)) throw new Error(`"${to}" is not a version. Express add-on versions are X.Y.Z with no leading zeros, for example 1.0.4.`);
  let warning = "";
  if (SEMVER.test(current) && compareSemver(to, current) < 0) warning = `Version ${to} is lower than the current ${current}. A downgrade is written, and the marketplace may reject a lower version.`;
  const changed = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const json = JSON.parse(text);
    let next;
    if (/"version"\s*:\s*"[^"]*"/.test(text)) next = text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${to}"`);
    else next = `${JSON.stringify({ ...json, version: to }, null, 2)}\n`;
    if (JSON.parse(next).version !== to) throw new Error(`Could not set the version in ${file}.`);
    fs.writeFileSync(file, next);
    changed.push(path.relative(dir, file));
  }
  return { ok: true, changed: true, from: current, version: to, files: changed, ...(warning ? { warning } : {}), note: "Rebuild and package again so the zip carries the new version." };
}

function compareSemver(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
