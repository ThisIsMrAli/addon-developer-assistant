# Provenance

- Package: `@babel/parser`
- Version: `7.28.5`
- License: MIT. The copyright and permission notice are in `LICENSE` in this directory.
- Registry tarball: `https://registry.npmjs.org/@babel/parser/-/parser-7.28.5.tgz`
- Integrity: `sha512-KKBU1VGYR7ORr3At5HAtUQ+TV3SzRCXmA/8OdDZiLDBIZxVyzXuztPjfLd3BV1PRAQGCMWWSHYhL0F8d5uHBDQ==`
- Repository: `https://github.com/babel/babel` (`packages/babel-parser`)
- File kept: `lib/index.js` (the published build)

The published `lib/index.js` has no runtime `require()`. `@babel/types` is a type dependency only and is not included.

This copy lives inside the skill so a folder installed with `npx skills add` or copied by hand can parse decorators and TypeScript. It does not depend on `npm install`.
