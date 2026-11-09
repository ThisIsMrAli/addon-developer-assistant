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

/** Where @adobe/ccweb-add-on-devcert looks up a localhost certificate. */
export function domainCertPath(home, host = "localhost") {
  return path.join(home, ".config/Adobe/CCWebAddOn/devcert/domains", host, "certificate.crt");
}

export function domainKeyPath(home, host = "localhost") {
  return path.join(home, ".config/Adobe/CCWebAddOn/devcert/domains", host, "private-key.key");
}

/** True when the CA and the localhost certificate both exist and are not expired. */
export function devcertReady(home, exists = fs.existsSync) {
  if (!home) return false;
  const ca = caPath(home);
  const domain = domainCertPath(home);
  if (!exists(ca) || !exists(domain)) return false;
  return daysLeft(ca) > 0 && daysLeft(domain) > 0;
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
  const domain = domainCertPath(home);
  if (found.complete && exists(domain)) return { ok: true, action: "reuse", warning: SSL_WARNING, domain, ...found };
  if (found.certPresent && !found.keyPresent) {
    if (exists(domain)) {
      return {
        ok: true,
        action: "reuse-cert",
        warning: `${SSL_WARNING} The certificate is present and the private key is not, so nothing was regenerated.`,
        domain,
        ...found
      };
    }
    return {
      ok: false,
      action: "reuse-cert",
      warning: SSL_WARNING,
      error: "The CA certificate is present and the private key is not, so a localhost certificate could not be signed.",
      domain,
      ...found
    };
  }
  let action = "reuse";
  if (!found.complete) {
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
    action = "local-setup";
  }
  seedDevcertFiles(home);
  const signed = signLocalhost(home, run);
  if (signed.status !== 0 || !exists(domain)) {
    return { ok: false, action, warning: SSL_WARNING, error: (signed.stderr || signed.stdout || "openssl could not sign the localhost certificate.").trim(), domain, ...inspectCa(home, exists) };
  }
  return { ok: true, action, warning: SSL_WARNING, domain, ...inspectCa(home, exists) };
}

/** A sudo that refuses, so a child process cannot change the system trust store. */
export function sudoGuard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-no-sudo-"));
  const file = path.join(dir, "sudo");
  fs.writeFileSync(file, "#!/bin/sh\necho 'Refusing sudo. This skill does not change /usr/local/share/ca-certificates/devcert.crt.' >&2\nexit 1\n");
  fs.chmodSync(file, 0o755);
  guards.add(dir);
  return dir;
}

const guards = new Set();

/** Remove the refusing sudo directory once the dev server has started. */
export function releaseSudoGuard(dir) {
  if (!dir) return;
  guards.delete(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

function seedDevcertFiles(home) {
  const root = path.join(home, ".config/Adobe/CCWebAddOn/devcert");
  const caDir = path.join(root, "certificate-authority");
  fs.mkdirSync(caDir, { recursive: true });
  const version = path.join(root, "devcert-ca-version");
  const serial = path.join(caDir, "serial");
  const index = path.join(caDir, "index.txt");
  if (!fs.existsSync(version)) fs.writeFileSync(version, "2\n");
  if (!fs.existsSync(serial)) fs.writeFileSync(serial, "01\n");
  if (!fs.existsSync(index)) fs.writeFileSync(index, "");
}

function signLocalhost(home, run) {
  const cert = domainCertPath(home);
  const key = domainKeyPath(home);
  fs.mkdirSync(path.dirname(cert), { recursive: true });
  const ext = path.join(path.dirname(cert), "san.cnf");
  fs.writeFileSync(ext, "subjectAltName=DNS:localhost,DNS:*.localhost\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  const madeKey = run("openssl", ["genrsa", "-out", key, "2048"]);
  if (madeKey.status !== 0) return madeKey;
  const csr = path.join(path.dirname(cert), "request.csr");
  const requested = run("openssl", ["req", "-new", "-key", key, "-subj", "/CN=localhost", "-out", csr]);
  if (requested.status !== 0) return requested;
  const signed = run("openssl", ["x509", "-req", "-in", csr, "-CA", caPath(home), "-CAkey", keyPath(home), "-CAcreateserial", "-out", cert, "-days", "365", "-extfile", ext]);
  try { fs.chmodSync(key, 0o600); } catch { /* the file is already private to this user */ }
  return signed;
}

function daysLeft(file) {
  const result = spawnSync("openssl", ["x509", "-in", file, "-noout", "-enddate"], { encoding: "utf8" });
  if (result.status !== 0) return -1;
  const match = /notAfter=(.*)/.exec(`${result.stdout || ""}\n${result.stderr || ""}`);
  if (!match) return -1;
  const end = Date.parse(match[1]);
  if (Number.isNaN(end)) return -1;
  return (end - Date.now()) / 86_400_000;
}

process.on("exit", () => {
  for (const dir of guards) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function defaultRun(file, args) {
  return spawnSync(file, args, { encoding: "utf8" });
}
