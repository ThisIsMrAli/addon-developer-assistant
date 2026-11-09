# BETA: sideload on Linux

This step is optional. Skip is the default. It sits immediately before the listing and the screenshots.

The fixed rules:

- Do not disable Chrome security flags. Leave `chrome://flags/#local-network-access-check` enabled and click Allow.
- Do not pass `--ignore-certificate-errors`.
- The dev server is `https://localhost:5241`. Never `127.0.0.1`.

`node scripts/setup-express-linux.mjs` trusts the dev CA. It does not open Adobe Express and it does not type a password. `EXPRESS_DEVELOP_SETUP_EXEC=0` plans the same commands and does not run apt or certutil. Tests use that. A real run does not.

## What the setup command does

The CA file is `~/.config/Adobe/CCWebAddOn/devcert/certificate-authority/certificate.cert`. If it is missing, the command exits 2 and says to run `npm run start` once so the add-on tooling can create it.

If `certutil` is missing, it runs `sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libnss3-tools`. If that mirror fails, it reads the installed `libnss3` version, strips the epoch, reads `dpkg --print-architecture`, and downloads `libnss3-tools_<version>_<arch>.deb` from the Debian security pool and then the Debian pool. It installs that package with `sudo dpkg -i`.

It then trusts nickname `adobe-ccweb-devcert` with trust `C,,` in both `sql:$HOME/.pki/nssdb` and `sql:$HOME/.local/share/pki/nssdb`. An empty database is created with `certutil -N --empty-password`. An old nickname is deleted, the CA is added, and `certutil -L` must show `devcert` with trust `C,,`. The success line is: restart Chrome, then open `https://localhost:5241` (not `127.0.0.1`).

## What a person still does in Express

Sign in at `https://new.express.adobe.com`. Enable Add-on Development. Open Your add-ons, then Add-on testing, connect to `https://localhost:5241`, Allow the local-network prompt, and launch from In development. Exercise the feature.

A headless audit that used the SDK stand-in is not this step, and it is not an Express pass.
