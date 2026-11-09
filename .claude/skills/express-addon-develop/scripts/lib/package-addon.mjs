import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readZip } from "../../../express-addon-review/scripts/lib/package.mjs";

const SKIP = new Set(["node_modules", ".git", "coverage"]);

export function buildProject(dir) {
  const pkg = readPkg(dir);
  if (!pkg?.scripts?.build) return { ok: true, skipped: true, note: "This add-on has no build script." };
  const install = run(dir, ["install", "--no-audit", "--no-fund"]);
  if (install.status !== 0) return { ok: false, error: tail(install) };
  const build = run(dir, ["run", "build"]);
  if (build.status !== 0) return { ok: false, error: tail(build) };
  return { ok: true, skipped: false, note: "npm run build finished." };
}

export function packageProject(dir) {
  const pkg = readPkg(dir);
  let scriptError = "";
  if (pkg?.scripts?.package) {
    const result = run(dir, ["run", "package"]);
    if (result.status !== 0) scriptError = tail(result);
  }
  const found = findManifestZip(dir);
  if (found) return { ok: true, zip: found, via: "script", scriptError };
  const zip = path.join(dir, `${safeName(dir)}.zip`);
  const root = fs.existsSync(path.join(dir, "dist", "manifest.json")) ? path.join(dir, "dist") : addonSource(dir);
  writeZip(zip, listFiles(root, root));
  return { ok: true, zip, via: "packed-here", root, scriptError };
}

function run(dir, args) {
  return spawnSync("npm", args, {
    cwd: dir,
    encoding: "utf8",
    timeout: 300000,
    env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false", BROWSER: "none" }
  });
}

function tail(result) {
  return `${result.stderr || ""}\n${result.stdout || ""}`.trim().split("\n").slice(-20).join("\n");
}

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function addonSource(dir) {
  if (fs.existsSync(path.join(dir, "src", "manifest.json"))) return path.join(dir, "src");
  return dir;
}

function safeName(dir) {
  return path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "addon";
}

function findManifestZip(dir) {
  const hits = [];
  const walk = (folder, depth) => {
    if (depth > 2) return;
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".zip")) hits.push(full);
    }
  };
  walk(dir, 0);
  return hits.find((file) => zipHasManifest(file)) || "";
}

function zipHasManifest(file) {
  try {
    return readZip(file).entries.some((entry) => entry.name === "manifest.json");
  } catch {
    return false;
  }
}

function listFiles(root, dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.endsWith(".zip")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(root, full, out);
    else if (entry.isFile()) {
      const name = path.relative(root, full).split(path.sep).join("/");
      out.push({ name, data: fs.readFileSync(full) });
    }
  }
  return out;
}

export function writeZip(file, entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(head, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, centralBuf, end]));
  return file;
}

function crc32(buffer) {
  let c = ~0;
  for (const byte of buffer) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
