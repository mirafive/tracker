# Changelog

## 0.5.0 — unreleased

First release on the v1 ingest protocol, rebuilt from scratch on
`@mirafive/sdk-browser` 0.5.0.

- `mira.js` loader (4.31 kB): the sdk-browser core and pageviews, the
  `window.mirafive` command queue, and the script-tag attributes `data-key`,
  `data-host`, `data-mode="full"`, `data-hash`, `data-manual`, `data-autocapture`,
  `data-site-search`, `data-flags`, `data-track-localhost`. Reports
  `mirafive-tracker/0.5.0`.
- Feature chunks loaded on demand from beside the loader, content-hashed, with sha256
  SRI baked into the loader: identity (full mode, on the first consent grant), autocapture,
  search, flags (attribute, first flag verb, bootstrap block or page experiment) and
  experiments (page-experiment snippet decisions, full mode).
- Verbs arriving before their chunk wait and replay in call order; events between a
  consent grant and identity's arrival are held (`core.hold()`) and sent with ids. A
  throwing call is skipped; a chunk that fails to load warns, settles its waiting calls
  and is retried when needed.
- Build output: `dist/mira.js`, pinned `dist/mira.<hash>.js`, `dist/chunks/*`,
  `dist/manifest.json`.
