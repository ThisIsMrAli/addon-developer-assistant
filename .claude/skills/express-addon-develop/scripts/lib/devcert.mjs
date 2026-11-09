/**
 * Trust Adobe's local add-on dev CA in this computer's Chrome.
 * Same order as the known-working express-devcert-trust.sh:
 * install certutil (apt, then the Debian pool), then trust the CA in both NSS databases.
 * Never disables a Chrome flag, never passes ignore-certificate-errors, never uses 127.0.0.1.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export const DEV_ORIGIN = "https://localhost:5241";
export const FORBIDDEN_HOST = "127.0.0.1";
export const NICKNAME = "adobe-ccweb-devcert";
export const TRUST_FLAGS = "C,,";
export const CA_RELATIVE = ".config/Adobe/CCWebAddOn/devcert/certificate-authority/certificate.cert";

const UNSAFE = /ignore-certificate-errors|127\.0\.0\.1|disable-web-security|allow-insecure-localhost|local-network-access-check=disabled|LocalNetworkAccess/i;

export function caPath(home) {
  return path.join(home, CA_RELATIVE);
}

export function nssDatabases(home) {
  return [path.join(home, ".pki/nssdb"), path.join(home, ".local/share/pki/nssdb")];
}

export function assertSafeArgv(argv) {
  const text = argv.map(String).join(" ");
  if (UNSAFE.test(text)) throw new Error(`Refusing an unsafe sideload argument: ${text}`);
}

export function stripEpoch(version) {
  return String(version || "").trim().replace(/^[0-9]+:/, "");
}

export function poolUrls(version, arch) {
  const name = `libnss3-tools_${stripEpoch(version)}_${String(arch || "").trim()}.deb`;
  return [
    `https://deb.debian.org/debian-security/pool/updates/main/n/nss/${name}`,
    `https://deb.debian.org/debian/pool/main/n/nss/${name}`
  ];
}

export function defaultRun(file, args) {
  assertSafeArgv([file, ...args]);
  const result = spawnSync(file, args, { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function trustedLine(stdout) {
  return /devcert +C,,/.test(String(stdout || ""));
}

/**
 * @param {object} io
 * @param {string} io.home
 * @param {boolean} [io.exec] false plans mutating commands and does not run them
 * @param {boolean} [io.certutilPresent]
 * @param {(file: string, args: string[]) => {status: number, stdout: string, stderr: string}} [io.run]
 * @param {(path: string) => boolean} [io.exists]
 * @param {(path: string) => void} [io.mkdir]
 */
export function trustDevcert(io = {}) {
  const home = io.home || process.env.HOME;
  if (!home) throw new Error("HOME is not set.");
  const ca = io.ca || process.env.CA || caPath(home);
  const exec = io.exec !== false;
  const run = io.run || defaultRun;
  const exists = io.exists || existsSync;
  const mkdir = io.mkdir || ((dir) => mkdirSync(dir, { recursive: true }));
  const planned = [];
  const performed = [];

  const call = (file, args) => {
    assertSafeArgv([file, ...args]);
    const command = [file, ...args].join(" ");
    planned.push(command);
    if (!exec) return { status: 0, stdout: "", stderr: "", skipped: true };
    const result = run(file, args);
    performed.push(command);
    return result;
  };

  let certutilPresent = io.certutilPresent;
  if (certutilPresent === undefined) {
    const which = run("bash", ["-lc", "command -v certutil"]);
    certutilPresent = which.status === 0 && String(which.stdout || "").trim().length > 0;
  }

  const install = { attempted: false, urls: [], version: "", arch: "" };
  if (!certutilPresent) {
    install.attempted = true;
    const apt = call("sudo", ["DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-qq", "libnss3-tools"]);
    const aptFailed = exec && apt.status !== 0;
    if (!exec || aptFailed) {
      const version = run("dpkg-query", ["-W", "-f=${Version}", "libnss3"]);
      const arch = run("dpkg", ["--print-architecture"]);
      install.version = stripEpoch(version.stdout || "");
      install.arch = String(arch.stdout || "").trim();
      install.urls = install.version && install.arch ? poolUrls(install.version, install.arch) : [];
      if (aptFailed) {
        let downloaded = false;
        for (const url of install.urls) {
          const curl = call("curl", ["-fsSL", "-o", "/tmp/nss-tools.deb", url]);
          if (curl.status === 0) {
            downloaded = true;
            break;
          }
        }
        if (!downloaded) {
          return finish({
            ok: false,
            exitCode: 1,
            ca,
            home,
            exec,
            certutilPresent,
            install,
            planned,
            performed,
            verified: [],
            error: "The apt mirror failed and the Debian pool download failed."
          });
        }
        const dpkg = call("sudo", ["dpkg", "-i", "/tmp/nss-tools.deb"]);
        if (dpkg.status !== 0) {
          return finish({
            ok: false,
            exitCode: 1,
            ca,
            home,
            exec,
            certutilPresent,
            install,
            planned,
            performed,
            verified: [],
            error: "libnss3-tools could not be installed from the Debian pool package."
          });
        }
      } else {
        for (const url of install.urls) planned.push(`curl -fsSL -o /tmp/nss-tools.deb ${url}`);
        planned.push("sudo dpkg -i /tmp/nss-tools.deb");
      }
    }
  }

  if (!exists(ca)) {
    return finish({
      ok: false,
      exitCode: 2,
      ca,
      home,
      exec,
      certutilPresent,
      install,
      planned,
      performed,
      verified: [],
      error: `No dev CA at ${ca}. Run the add-on once with 'npm run start' (it creates the CA), then rerun this.`
    });
  }

  const inspected = call("openssl", ["x509", "-in", ca, "-noout", "-subject", "-enddate"]);
  const verified = [];
  for (const dir of nssDatabases(home)) {
    if (exec) mkdir(dir);
    else planned.push(`mkdir -p ${dir}`);
    const database = `sql:${dir}`;
    if (!exists(path.join(dir, "cert9.db"))) call("certutil", ["-d", database, "-N", "--empty-password"]);
    planned.push(`certutil -d ${database} -D -n ${NICKNAME}`);
    if (exec) run("certutil", ["-d", database, "-D", "-n", NICKNAME]);
    const added = call("certutil", ["-d", database, "-A", "-t", TRUST_FLAGS, "-n", NICKNAME, "-i", ca]);
    let listed = { status: 0, stdout: "" };
    if (exec) {
      listed = run("certutil", ["-d", database, "-L"]);
      performed.push(`certutil -d ${database} -L`);
    }
    planned.push(`certutil -d ${database} -L`);
    const trusted = exec ? listed.status === 0 && trustedLine(listed.stdout) : false;
    verified.push({ dir, added: added.status === 0, trusted });
    if (exec && !trusted) {
      return finish({
        ok: false,
        exitCode: 1,
        ca,
        home,
        exec,
        certutilPresent,
        install,
        planned,
        performed,
        verified,
        certificate: String(inspected.stdout || "").trim(),
        error: `certutil did not show devcert with trust C,, in ${dir}`
      });
    }
  }

  return finish({
    ok: exec ? verified.every((item) => item.trusted) : false,
    exitCode: exec && verified.every((item) => item.trusted) ? 0 : exec ? 1 : 0,
    ca,
    home,
    exec,
    certutilPresent,
    install,
    planned,
    performed,
    verified,
    certificate: String(inspected.stdout || "").trim(),
    error: "",
    message: exec ? "Trusted. Restart Chrome, then open https://localhost:5241 (not 127.0.0.1)." : ""
  });
}

function finish(result) {
  return {
    expressHostRan: false,
    expressPass: false,
    browserRunIsExpressPass: false,
    flagState: "leave enabled",
    host: DEV_ORIGIN,
    notHost: FORBIDDEN_HOST,
    nickname: NICKNAME,
    trust: TRUST_FLAGS,
    databases: nssDatabases(result.home).map((dir) => `sql:${dir}`),
    manual: checklist(),
    ...result
  };
}

function checklist() {
  return [
    "Install libnss3-tools when certutil is missing. apt-get first; if that mirror fails, download libnss3-tools from the Debian security pool and then the Debian pool, using the installed libnss3 version with the epoch stripped.",
    `Trust ${NICKNAME} with certutil -A -t "C,," in sql:$HOME/.pki/nssdb and sql:$HOME/.local/share/pki/nssdb. Verify each database shows devcert with trust C,,.`,
    "Serve the add-on at https://localhost:5241. Do not use 127.0.0.1.",
    "Leave chrome://flags/#local-network-access-check enabled. When Chrome asks to look for devices on the local network, click Allow. Do not set the flag to Disabled.",
    "In Adobe Express, enable Add-on Development. Then open Your add-ons, Add-on testing, connect to https://localhost:5241, and launch the add-on from In development.",
    "The person signs in to Adobe Express. This command did not open Adobe Express and it never types a password."
  ];
}
