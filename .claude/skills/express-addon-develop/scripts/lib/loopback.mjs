/**
 * Two facts about a real local Express sideload.
 * Chrome may be forbidden, by policy, from calling the loopback dev server.
 * Adobe's dev server listens on [::1]:5241, so a check that uses 127.0.0.1 is refused.
 * This module only reads policy files and opens short TCP probes. It never writes a policy.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const LOOPBACK_POLICY = "LoopbackNetworkBlockedForUrls";
export const POLICY_ROOTS = ["/etc/opt/chrome/policies", "/etc/chromium/policies"];

/**
 * Real runs read POLICY_ROOTS. Tests pass `policyDirs`, or set
 * EXPRESS_DEVELOP_POLICY_DIRS to a `path.delimiter`-separated list.
 * An env object that does not have the key keeps the real directories.
 */
export function resolvePolicyDirs(env = process.env, policyDirs) {
  if (Array.isArray(policyDirs)) return policyDirs;
  if (!env || !Object.prototype.hasOwnProperty.call(env, "EXPRESS_DEVELOP_POLICY_DIRS")) return POLICY_ROOTS;
  return String(env.EXPRESS_DEVELOP_POLICY_DIRS || "").split(path.delimiter).filter((item) => item.length > 0);
}

export function patternBlocksLoopback(pattern) {
  const text = String(pattern || "").trim();
  if (!text) return false;
  if (text === "*" || text === "*://*" || text === "*://*/*") return true;
  const host = text.replace(/^[a-z*][a-z0-9+.-]*:\/\//i, "").split(/[/:]/)[0];
  if (host === "*") return true;
  return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host);
}

export function policyBlocksLoopback(value) {
  const list = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return list.some((item) => patternBlocksLoopback(item));
}

export const PRIVATE_LINK_ROUTE = "Localhost sideload is blocked, so the real Express test is a private link, and only after you approve it. Run npm run package, then dist.zip, then Manage add-ons, then the listing, then Private link. A publisher profile is required first, and the logo must be 250x250. Do not create the publisher profile or the listing. That step is manual.";

export function loopbackPolicyReason() {
  return `Chrome policy LoopbackNetworkBlockedForUrls blocks loopback, so Express cannot load the add-on (Apps on device: Blocked by your administrator). The skill does not change that policy. ${PRIVATE_LINK_ROUTE}`;
}

export function policyFailure(error, hit) {
  const text = String(error || "The real Express check failed.");
  if (!hit?.blocks) return text;
  if (text.includes(LOOPBACK_POLICY)) return text;
  return `${text} ${loopbackPolicyReason()} Express reports a PORT error because the administrator blocked apps on the device. No Chrome security flag is added.`;
}

/**
 * Read managed and recommended Chrome policy JSON. `roots` is injectable for tests.
 * A missing directory is not an error. Invalid JSON is skipped. Nothing is written.
 */
export function readLoopbackPolicy(roots = POLICY_ROOTS, io = fs) {
  const hits = [];
  for (const root of roots) {
    if (!io.existsSync(root)) continue;
    for (const file of jsonFiles(root, io)) {
      let parsed;
      try {
        parsed = JSON.parse(io.readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      collect(parsed, file, hits);
    }
  }
  const blocking = hits.find((hit) => hit.blocks);
  return blocking || { blocks: false, file: hits[0]?.file || "", value: hits[0]?.value ?? null };
}

function collect(node, file, hits) {
  if (!node || typeof node !== "object") return;
  if (Object.prototype.hasOwnProperty.call(node, LOOPBACK_POLICY)) {
    hits.push({ file, value: node[LOOPBACK_POLICY], blocks: policyBlocksLoopback(node[LOOPBACK_POLICY]) });
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") collect(value, file, hits);
  }
}

function jsonFiles(dir, io) {
  const found = [];
  let entries = [];
  try {
    entries = io.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...jsonFiles(full, io));
    else if (entry.isFile() && entry.name.endsWith(".json")) found.push(full);
  }
  return found;
}

function tryConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (listening, error = "") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ host, label: host === "::1" ? "[::1]" : host, listening, error });
    };
    socket.setTimeout(800);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (error) => finish(false, error.code || error.message));
  });
}

/** Probe [::1] and 127.0.0.1. The Express address stays https://localhost. */
export async function probeDevPort(port = 5241) {
  const results = await Promise.all([tryConnect("::1", port), tryConnect("127.0.0.1", port)]);
  const listening = results.filter((item) => item.listening).map((item) => item.label);
  const refused = results.filter((item) => !item.listening).map((item) => item.label);
  const host = listening.includes("[::1]") ? "::1" : listening.includes("127.0.0.1") ? "127.0.0.1" : "";
  let report;
  if (!listening.length) report = `Port ${port} is not listening on [::1] or 127.0.0.1.`;
  else if (listening.length === 1 && listening[0] === "[::1]") {
    report = `Port ${port} is listening on [::1] only. 127.0.0.1 refused the connection. ccweb-add-on-scripts binds IPv6 localhost, so a client that resolves localhost to 127.0.0.1 gets connection refused.`;
  } else if (listening.length === 1) report = `Port ${port} is listening on 127.0.0.1 only. [::1] refused the connection.`;
  else report = `Port ${port} is listening on [::1] and 127.0.0.1.`;
  return { port, results, listening, refused, host, report };
}

export function devRequestOptions(host, port = 5241) {
  return { host, port, servername: "localhost", rejectUnauthorized: true, timeout: 8000 };
}
