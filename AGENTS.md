# Agents working in mirafive/tracker

`@mirafive/tracker`: the hosted script (`mira.js` loader plus lazily loaded feature
chunks), built from `@mirafive/sdk-browser`. Part of the MIRA FIVE SDK family; the wire
contract, flag semantics and public API live in
[mirafive/protocol](https://github.com/mirafive/protocol) (PROTOCOL.md, FLAGS.md,
API.md, section `@mirafive/tracker`).

## Commands

```sh
bun install --frozen-lockfile
bun run check            # format, lint, typecheck, build, test, publint, size-limit
bun run build            # dist/: chunks, loader with their SRI baked in, pinned copy, manifest
bun run test             # vitest: each test runs the built dist/ files in its own happy-dom Window
bun run test:browser     # build, then drive the installed Chrome against a local stub server
bun run size             # size-limit against the limits in package.json
bun run vendor:protocol  # refresh src/protocol from ../protocol (or MIRAFIVE_PROTOCOL)
```

Tests run the built files, so build before `bun run test`. `test:browser` uses
playwright-core with the installed Chrome (`CHROME_PATH` overrides it); it downloads no
browser.

## Rules

- API.md is the contract for the attributes, verbs, load rules and build output. Do not
  change them without changing API.md first.
- `src/protocol/` is vendored (`package.json#mirafive.protocol`). Never edit it; change
  mirafive/protocol and run `bun run vendor:protocol`.
- The tracker is built from `@mirafive/sdk-browser` and must not reimplement a feature:
  the loader reads attributes, runs the queue and loads chunks; each chunk is one
  sdk-browser plugin entry plus `register()`. A behaviour change belongs in sdk-browser.
- sdk-browser is the published `^1.0.0` devDependency. To try an unreleased change,
  `bun link` it from `../sdk-browser`; never commit a `file:` path.
- Chunks register only through `window.__mirafive_chunk`. Their sha256 digests are baked into the loader at build time and the file names derive from them; never hand-edit `dist/`.
- The CDN keeps old chunks and pinned loaders: a cached `mira.js` (one hour) and every
  pinned copy still ask for the chunks they were built with.
- Bundle size is the headline goal: every file has a size-limit entry, set to the
  measured size plus about 3 %. A change that grows one explains why.
- The loader output must stay ES2020 syntax; the build fails on newer operators.
- Setup problems (no script tag, no or malformed `data-key`, a chunk that fails to load)
  warn on every host; everything else uses the core's development-only warnings. A
  throwing call never stops the queue.
- Consentless pages never load a chunk they did not ask for, and full-mode pages never
  load identity before a consent grant; `test/chunks.test.ts` and the browser test
  assert both.
- Comments only for a non-obvious constraint, one or two lines.
- Do not run git write commands unless asked; the maintainer commits.

## Releasing

To release, bump `version` in `package.json` (and any SDK version constant), add a `## X.Y.Z — YYYY-MM-DD` section to `CHANGELOG.md`, commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml` checks both, runs `bun run check`, stages it on npm through trusted publishing (no token) and creates the GitHub release from the changelog section. The version goes live only after a maintainer approves it with 2FA on npmjs.com (`npm stage approve`). Never `npm publish` from a laptop.

## Hosting (cdn.mirafive.io)

`cdn/Dockerfile` builds the tracker and serves `dist/` from nginx (`cdn/nginx.conf`): `mira.js`
for an hour, content-hashed files forever, `manifest.json` for five minutes, CORS on all of them,
gzip precompressed, anything else 404. Coolify builds the `cdn` branch, which the release
workflow moves to each release tag, so the CDN always serves the last release. `cdn/history.ts` also copies the pinned loaders and
chunks of every earlier release from npm into the image, so pinned loaders and an hour-old
`mira.js` keep finding their chunks. `cdn/legacy/` holds the pre-1.0 `c.js`/`f.js` exactly as they were served; delete
it and its two nginx locations once the app no longer accepts their wire.
