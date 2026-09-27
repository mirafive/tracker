# @mirafive/tracker

The MIRA FIVE hosted script: one `<script>` tag for privacy-first analytics, feature
flags and A/B tests on any website, hosted in the EU. A small loader that fetches
feature chunks only when a page needs them.

## Size

| File | min + gzip | Loaded when |
|---|---|---|
| `mira.js` (loader: core, pageviews, command queue) | 4.31 kB | always |
| `chunks/identity.<hash>.js` | 1.19 kB | `data-mode="full"`, on the first consent grant |
| `chunks/autocapture.<hash>.js` | 0.92 kB | `data-autocapture` |
| `chunks/search.<hash>.js` | 0.47 kB | `data-site-search`, full mode, after consent |
| `chunks/flags.<hash>.js` | 2.98 kB | `data-flags`, the first flag verb, a bootstrap block, or a page experiment |
| `chunks/experiments.<hash>.js` | 0.54 kB | full mode, and a page experiment snippet decided something |

What a page downloads:

| Page | Bytes |
|---|---|
| Default (consentless, automatic pageviews) | 4.31 kB |
| … with `data-autocapture` | 5.23 kB |
| `data-mode="full"`, visitor has not consented (or declined) | 4.31 kB |
| `data-mode="full"`, visitor consented | 5.50 kB |
| … with `data-site-search` | 5.97 kB |
| Any page reading flags | + 2.98 kB |
| A full-mode page running a page experiment | + 3.52 kB (flags and experiments) |

The loader carries the sha256 SRI digests of all five chunks (and derives each chunk's
file name from its digest); a chunk is never downloaded on a page that does not need it. Each chunk is the matching `@mirafive/sdk-browser` plugin
plus a registration wrapper of about 70 B.

## Install

Paste into every page's `<head>`, with the source's **website key** (`mf_…`):

```html
<script>window.mirafive=window.mirafive||function(){(mirafive.q=mirafive.q||[]).push(arguments)}</script>
<script defer src="https://cdn.mirafive.io/mira.js" data-key="mf_…"></script>
```

The first line is the command queue: calls made before the script arrives wait there.
Leave it out if nothing on the page calls `mirafive(…)` before the script loads.

To host it yourself, the same files are on npm (`npm install @mirafive/tracker`; the
package contains only `dist/`), see [Self-hosting](#self-hosting-and-csp).

Browsers: the loader and chunks are ES2020 syntax (Safari ≥ 14); the flags chunk also
uses `Object.hasOwn` (Safari ≥ 15.4, Chrome ≥ 93). No dependencies.

## Quickstart

```html
<script>window.mirafive=window.mirafive||function(){(mirafive.q=mirafive.q||[]).push(arguments)}</script>
<script defer src="https://cdn.mirafive.io/mira.js" data-key="mf_…"></script>
<script>
  // A custom event, anywhere on the page
  mirafive("track", "signup", { plan: "pro" })

  // A flag: the listener runs once flags have loaded, and again when they change
  mirafive("flags", () => {
    document.body.classList.toggle("new-checkout", mirafive("flag", "new-checkout", false) === true)
  })
</script>
```

Verify it: open the site (not `localhost`, or add `data-track-localhost`), open the
browser's devtools network tab, and call `mirafive("flush")` in the console (batches
otherwise leave after 5 seconds or when the tab is hidden). Look for
`POST https://events.mirafive.io/v1/batch/mf_…` answering `202` with `"accepted": 1`,
then for the pageview in the source's live view in MIRA FIVE.

## Consent & privacy

- **Default mode: consentless.** Identifier-free and needs no consent banner: no
  cookies, no storage, no ids, and the script never reads the browser's language,
  time zone or screen size. A batch carries `mirafive-tracker/0.5.0`, the page (URL
  with only campaign and click-id parameters, title, referrer) and your event
  properties. Identity verbs (`consent`, `identify`, …) do nothing here, silently, so
  CMP wiring can stay in place.
- **`data-mode="full"`** adds an anonymous id, a session id, your user id, and locale,
  time zone and screen size; it unlocks site search, experiments and segment
  targeting. Put it behind your consent management platform (CMP): before a consent
  answer nothing is sent, nothing is stored, and the identity code is not even
  downloaded.
- Pass the answer with `mirafive("consent", …)`:
  - `true`: statistics only.
  - `{ statistics, experiments, targeting }`: by scope; a scope left out keeps its last
    answer.
  - `false`: forgets the ids and the user, clears the queue. When nothing was granted
    on this page, the identity chunk is fetched for this only if the browser still holds
    MIRA FIVE ids from an earlier visit; otherwise the decline is recorded without it,
    so flags stop drawing random-mode experiments for the visitor.
  - A CMP that knows the stored answer before the script runs sets
    `window.__mirafive_consent = { statistics, experiments, targeting }` (or `false`)
    first; the identity chunk then loads at once and the landing pageview counts as
    answered on arrival (`$boot: 1`). An answer queued with the snippet before the
    script ran counts the same way.
- The landing pageview is sent when consent is first granted, so a visitor who
  accepts on the first page still counts that page.
- Do Not Track, Global Privacy Control, `window.__mirafive_ignore = true` (for your
  own visits) and prerendering send nothing. `localhost`, `127.*`, `[::1]`, `*.local`
  and `file:` send nothing unless `data-track-localhost`.
- Full mode stores, in `localStorage` only (never cookies), `mirafive:{namespace}:aid`
  (anonymous id, 365 days since last seen), `:sid` (session, 30 minutes idle) and
  `:uid` (a hash of the user id). The namespace is the key without its last `_…` part.

Wiring common CMPs (statistics is the usual "analytics" category, targeting the
"marketing" one):

```html
<script>
  // Cookiebot
  window.addEventListener("CookiebotOnConsentReady", () => {
    const { statistics, preferences, marketing } = Cookiebot.consent
    mirafive("consent", { statistics, experiments: preferences, targeting: marketing })
  })

  // OneTrust (default group ids: C0002 performance, C0003 functional, C0004 targeting)
  window.OptanonWrapper = () => {
    const groups = window.OnetrustActiveGroups || ""
    mirafive("consent", {
      statistics: groups.includes(",C0002,"),
      experiments: groups.includes(",C0003,"),
      targeting: groups.includes(",C0004,")
    })
  }

  // Your own banner
  acceptButton.onclick = () => mirafive("consent", true)
  declineButton.onclick = () => mirafive("consent", false)
</script>
```

## API reference

### Attributes

| Attribute | | |
|---|---|---|
| `data-key` | required | the source's public website key (`mf_…`) |
| `data-host` | `https://events.mirafive.io` | ingest host, with scheme (a first-party proxy, for example) |
| `data-mode="full"` | consentless | ids and device context after consent; loads identity on the first grant |
| `data-hash` | | the fragment is the route (`#/pricing`): hash changes are pageviews |
| `data-manual` | | no automatic pageviews; send them with `mirafive("pageview")` |
| `data-autocapture` | | clicks, submits and changes as `$autocapture` |
| `data-site-search` | | full mode: `$search` from `q`, `s`, `search`, `query`; `="term, k"` names the parameters |
| `data-flags` | | load flags at once (otherwise on the first flag verb) |
| `data-track-localhost` | | also send from `localhost` and other local hosts |

The on/off attributes (`data-hash` to `data-track-localhost`) are on when present, and
off when absent or set to `off` or `false` (any case), so a template can write
`data-autocapture="{{ enabled }}"`. No other `data-*` attribute is read. A `data-key`
that is not a website key (`mf_…`, or a legacy `mira_ik_…`) logs `[mirafive] bad key`
on every host; the page still sends.

### Verbs

`mirafive(verb, ...args)`:

| Verb | Needs | |
|---|---|---|
| `track`, `name`, `properties?` | | queue an event; names starting with `$` are reserved |
| `pageview`, `{ url?, title?, referrer? }?` | | queue `$pageview` for the current or given page |
| `flush` | | send now |
| `consent`, `true \| false \| { statistics?, experiments?, targeting? }` | full | see above |
| `identify`, `userId`, `traits?` | full | `$identify`, then `userId` on later events |
| `reset` | full | forget ids, user and session |
| `anonymousId`, `callback` | full | `callback(id)`; `undefined` without statistics consent |
| `search`, `query` | full, `data-site-search` | queue `$search` |
| `flag`, `key`, `fallback` | | the variant; `true`/`false` for on/off flags |
| `config`, `key`, `fallback` | | the variant's remote-config value |
| `flags`, `listener` | | runs when flags load or change (at once if loaded) |
| `flagProperties`, `properties` | | facts for targeting rules, never sent |

Unknown verbs warn in development (on a local host) and do nothing.

Verbs whose chunk has not arrived yet wait and run in call order once it has. Between a
consent grant and the identity chunk's arrival, events (automatic pageviews,
autocapture, `track`) are held and sent with their original times and the new ids once
identity applies the answer; a `flush` in that window waits for identity too. A
`flags` listener registered before flags load returns no unsubscribe function.

`flag` and `config` are not replayed (a replayed read would count an experiment
exposure for a value the page never showed). Before `mira.js` has run, the queue
snippet answers them with `undefined`; after it has run and until flags have loaded,
they answer the fallback. Read flags inside a `flags` listener, which runs once they
are loaded and again when they change.

A call that throws (a callback that throws, say) is skipped with a development
warning; the calls after it still run. A chunk that fails to load (network, SRI
mismatch, CSP) logs `[mirafive] <chunk> chunk failed` on every host, drops the calls
and held events waiting for it (`anonymousId` callbacks get `undefined`), and is
requested again the next time it is needed.

### What loads when

| Chunk | Loaded when |
|---|---|
| identity | `data-mode="full"`, on the first consent grant or a pre-set `window.__mirafive_consent`; a decline only when ids from an earlier visit are stored |
| autocapture | `data-autocapture` |
| search | `data-site-search` in full mode, on the first consent grant |
| flags | `data-flags`, the first `flag`/`config`/`flags`/`flagProperties` verb, a `<script type="application/json" id="mirafive-flags">` bootstrap block, or a page experiment |
| experiments | full mode, and `window.__mirafive_experiments` is non-empty, also when the snippet pushes to it later (a consentless page gets flags only) |

Chunks come from the directory the loader was loaded from (`<dir>/chunks/…`), with
`integrity` (sha256) and `crossorigin="anonymous"`. The loader must be loaded by
`src` (not inlined, not as `type="module"`), because it finds that directory from
its own script tag.

### Build output

```
dist/mira.js                     stable name, changes with every release
dist/mira.<hash>.js              pinned copy of that loader, never changes
dist/chunks/<feature>.<hash>.js  identity, flags, experiments, search, autocapture
dist/manifest.json               { version, loader: { file, integrity }, chunks: { <feature>: { file, integrity } } }
```

`<hash>` is the first 8 characters of the file's sha256 digest, base64url. Chunk
integrity is sha256 (it is baked into the loader, where every byte counts); the pinned
loader's integrity in the manifest is sha384.

## Framework / runtime notes

### Self-hosting and CSP

Serve `dist/` from any static host, keeping its layout, and point the tag at your
copy: `<script defer src="/mirafive/mira.js" data-key="mf_…">`. Headers:

| File | Headers |
|---|---|
| `mira.js` | `Cache-Control: public, max-age=3600` |
| `mira.<hash>.js`, `chunks/*` | `Cache-Control: public, max-age=31536000, immutable` |
| all `.js` | `Content-Type: text/javascript; charset=utf-8`; from another origin also `Access-Control-Allow-Origin: *` (chunks are requested in CORS mode for SRI) |
| `manifest.json` | `Cache-Control: no-cache` |

When you update, add the new files and keep the old chunks: a browser holding the
previous `mira.js` for up to an hour still asks for the chunks it names, and pinned
loaders ask for theirs forever.

Content Security Policy:

```
script-src  https://cdn.mirafive.io       (or your own origin when self-hosting)
connect-src https://events.mirafive.io    (or your data-host)
```

`connect-src` covers both batches and flags. The inline queue snippet needs the page's
`nonce` or its hash in `script-src`. Under `'strict-dynamic'` the host allowlist is
ignored: give the `mira.js` tag the page's `nonce` too; the chunks it inserts are then
allowed through it.

### SRI with the pinned file

`mira.js` cannot carry an `integrity` attribute: it changes with every release. For a
loader that never changes under you, use the pinned copy from `manifest.json`
(`loader.file`, `loader.integrity`):

```html
<script defer src="https://cdn.mirafive.io/mira.<hash>.js"
        integrity="sha384-…" crossorigin="anonymous" data-key="mf_…"></script>
```

The chunk hashes are baked into each loader, so a pinned loader only ever runs the
chunks it was built with.

### Single-page apps

Automatic pageviews follow every same-document navigation (Navigation API, else
`pushState`/`replaceState`/`popstate`; `hashchange` with `data-hash`). With
`data-manual`, call `mirafive("pageview")` after each route change. For a bundled app,
prefer `@mirafive/sdk-browser` or a MIRA FIVE framework package over the script tag.

### Batches

`text/plain` POSTs to `{host}/v1/batch/{key}` (no CORS preflight), after 20 events or
5 seconds, and by `navigator.sendBeacon` when the page is hidden or closed.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Nothing arrives | On `localhost` add `data-track-localhost`; check Do Not Track, Global Privacy Control and `__mirafive_ignore`; with `data-mode="full"`, `mirafive("consent", true)` must have run; batches leave after 5 s or on tab hide (`mirafive("flush")` sends now). |
| `[mirafive] no data-key` | The tag has no `data-key`. |
| `[mirafive] bad key` | `data-key` is not a website key (`mf_…`); a secret key, or a typo. |
| `[mirafive] no script tag` | The loader was inlined, loaded as `type="module"` or run through `eval`; load it by `src`. |
| `[mirafive] <chunk> chunk failed` | The chunk was blocked: network, a CSP without the CDN origin (or without the loader's nonce under `'strict-dynamic'`), or an SRI mismatch. |
| `403 secret_key_in_path` / `website_key_as_bearer` | You pasted a secret key. Use the website key (`mf_…` of a website source). |
| `403 origin_not_allowed` | Add the site's origin to the source's allowed origins in MIRA FIVE. |
| `400 collection_mode_not_allowed` | `data-mode="full"` on a consentless source: switch the source to full or drop the attribute. |
| A chunk is blocked ("Failed to find a valid digest in the 'integrity' attribute") | A proxy or CDN rewrote the file, or a self-hosted copy mixes files of two builds. Serve `dist/` unchanged. |
| A flag always returns its fallback | Read before flags loaded: read it inside `mirafive("flags", …)`. Otherwise not in this source's flags, a segment rule without `targeting` consent, or a user flag before `identify`. |

## For AI agents

Copy-paste setup prompt:

```text
Add MIRA FIVE analytics to this website with the hosted script.
1. Get the source's website key (mf_…). Never use a secret key (MIRAFIVE_SECRET_KEY) in a page.
2. Into the <head> of every page (the shared layout or template), add exactly:
     <script>window.mirafive=window.mirafive||function(){(mirafive.q=mirafive.q||[]).push(arguments)}</script>
     <script defer src="https://cdn.mirafive.io/mira.js" data-key="WEBSITE_KEY"></script>
   Put the key in the template from the project's config or env (MIRAFIVE_WEBSITE_KEY) if it
   has one; the key is public, so a literal is acceptable.
3. Keep the default consentless mode: it needs no banner. Only if the site already has a consent
   manager (CMP) and the owner wants ids: add data-mode="full" to the tag and call
   mirafive("consent", { statistics, experiments, targeting }) from the CMP's consent callback
   (or set window.__mirafive_consent before the tag when the answer is known server-side).
4. If the site sends a Content-Security-Policy, add https://cdn.mirafive.io to script-src and
   https://events.mirafive.io to connect-src, and give the inline snippet the page's nonce. If
   script-src uses 'strict-dynamic', the mira.js tag needs the page's nonce as well.
5. Verify: load a page (not localhost), run mirafive("flush") in the console, and check the network
   tab for POST https://events.mirafive.io/v1/batch/<key> answering 202; report what you changed.
Do not add other analytics libraries, cookies or consent banners.
```

Facts for agents:

- The tag: `<script defer src="https://cdn.mirafive.io/mira.js" data-key="mf_…">`,
  preceded by the one-line queue snippet. Attributes: `data-key`, `data-host`,
  `data-mode="full"`, `data-hash`, `data-manual`, `data-autocapture`,
  `data-site-search`, `data-flags`, `data-track-localhost`. Nothing else is read.
- Only the source's public **website key** goes in the page. A secret key in a page is
  refused and marked exposed. Env var names: `MIRAFIVE_WEBSITE_KEY` (public),
  `MIRAFIVE_HOST` (optional, for `data-host`).
- `data-mode="full"` only behind a CMP: without `mirafive("consent", …)` a full-mode
  page sends nothing at all. Consentless mode needs no consent call and no banner.
- Verbs: `track`, `pageview`, `flush`, `consent`, `identify`, `reset`, `anonymousId`
  (callback), `search`, `flag`, `config`, `flags` (listener), `flagProperties`. Read
  flags inside a `flags` listener: before `mira.js` runs `flag` returns `undefined`,
  and until flags load it returns the fallback.
- Server frameworks: `mirafive/sdk-laravel` renders this tag with `@mirafiveScript`,
  `mirafive/sdk-symfony` with `mirafive_script()`. Bundled apps use
  `@mirafive/sdk-browser` or a framework package instead of the tag.
- Nothing throws. Setup problems (`[mirafive] no data-key`, `bad key`, `no script tag`,
  `<chunk> chunk failed`) are logged on every host; everything else warns on local
  hosts only.
- Verify an install in devtools: Network shows `mira.js` (200), then after
  `mirafive("flush")` a `POST …/v1/batch/{key}` with a `text/plain` body whose
  `context.sdk` is `mirafive-tracker/0.5.0`, answered `202 { "accepted": n, "dropped": 0 }`.
  In full mode nothing is posted before consent; `chunks/identity.….js` appears on the
  first grant.
- Wire contract: [mirafive/protocol](https://github.com/mirafive/protocol).

## License

[MIT](LICENSE) © 2026 Cloo GmbH
