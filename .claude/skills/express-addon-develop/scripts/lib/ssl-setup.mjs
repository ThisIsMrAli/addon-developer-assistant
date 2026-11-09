/**
 * A local dev CA for https://localhost:5241.
 * Adobe's SSL tool can use sudo to replace /usr/local/share/ca-certificates/devcert.crt.
 * This module never does that. It reuses a CA that is already in this home, and otherwise
 * creates one only under that home.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { caPath } from "./devcert.mjs";

export const SYSTEM_CA = "/usr/local/share/ca-certificates/devcert.crt";
export const SSL_WARNING = "Adobe's SSL tool can use sudo to replace the system certificate at /usr/local/share/ca-certificates/devcert.crt. This skill does not run that, and it does not change the system trust store. An existing CA in this home is reused.";

export function keyPath(home) {
  return path.join(home, ".config/Adobe/CCWebAddOn/devcert/certificate-authority/private-key.key");
}

export function inspectCa(home, exists = fs.existsSync) {
  const cert = caPath(home);
  const key = keyPath(home);
  return {
    cert,
    key,
    certPresent: exists(cert),
    keyPresent: exists(key),
    complete: exists(cert) && exists(key),
    systemPresent: exists(SYSTEM_CA)
  };
}

/**
 * Reuse a complete CA. Otherwise create a localhost CA in this home with openssl.
 * The system file is never written.
 */
export function prepareDevCa({ home = process.env.HOME, exists = fs.existsSync, run = defaultRun } = {}) {
  if (!home) return { ok: false, action: "missing-home", warning: SSL_WARNING, error: "HOME is not set." };
  const found = inspectCa(home, exists);
  if (found.complete) return { ok: true, action: "reuse", warning: SSL_WARNING, ...found };
  if (found.certPresent && !found.keyPresent) {
    return {
      ok: true,
      action: "reuse-cert",
      warning: `${SSL_WARNING} The certificate is present and the private key is not, so nothing was regenerated.`,
      ...found
    };
  }
  const dir = path.dirname(found.cert);
  fs.mkdirSync(dir, { recursive: true });
  const result = run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048",
    "-keyout", found.key,
    "-out", found.cert,
    "-days", "365",
    "-nodes",
    "-subj", "/CN=localhost",
    "-addext", "basicConstraints=critical,CA:TRUE"
  ]);
  if (result.status !== 0 || !exists(found.cert) || !exists(found.key)) {
    return { ok: false, action: "local-setup", warning: SSL_WARNING, error: (result.stderr || result.stdout || "openssl could not create a local CA.").trim(), ...found };
  }
  return { ok: true, action: "local-setup", warning: SSL_WARNING, ...inspectCa(home, exists) };
}

/** A sudo that refuses, so a child process cannot change the system trust store. */
export function sudoGuard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-no-sudo-"));
  const file = path.join(dir, "sudo");
  fs.writeFileSync(file, "#!/bin/sh\necho 'Refusing sudo. This skill does not change /usr/local/share/ca-certificates/devcert.crt.' >&2\nexit 1\n");
  fs.chmodSync(file, 0o755);
  return dir;
}

function defaultRun(file, args) {
  return spawnSync(file, args, { encoding: "utf8" });
}
