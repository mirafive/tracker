import { createMira } from "@mirafive/sdk-browser"
import type { MiraCore, MiraOptions } from "@mirafive/sdk-browser"
import { pageviews } from "@mirafive/sdk-browser/pageviews"

import type { Factory, Feature, TrackerGlobals } from "./types.ts"

// Each chunk's sha256 digest (base64), in `features` order.
declare const __CHUNKS__: string
declare const __VERSION__: string

type Args = ArrayLike<unknown>

// Core verbs, then identity's, search's and flags'. Methods are named like their verbs but for two.
const verbs =
  "track pageview flush consent identify reset anonymousId search flag config flags flagProperties".split(" ")
const methods: Record<string, string> = { flags: "onFlags", flagProperties: "setFlagProperties" }

// Applied in this order, each after the chunk it needs: flags before experiments, identity before search.
const features: Feature[] = ["identity", "flags", "experiments", "search", "autocapture"]
const needs: Partial<Record<Feature, Feature>> = { experiments: "flags", search: "identity" }
const chunks = __CHUNKS__.split(" ")

const stored = (): boolean | void => {
  try {
    return Object.keys(localStorage).some((name) => name.startsWith("mirafive:"))
  } catch {
    // Blocked storage holds nothing to forget.
  }
}

const on = (value: string | undefined): value is string => value !== undefined && !/^(off|false)$/.test(value)

const start = (script: HTMLScriptElement): void => {
  const w = window as Window & TrackerGlobals
  const d = document
  const data = script.dataset
  const full = data["mode"] === "full"
  const hash = "hash" in data
  const search = data["siteSearch"]
  const searching = full && on(search)
  const parameters = search && !/^(on|true|)$/.test(search) ? search.split(/ *, */) : undefined
  const factories: Partial<Record<Feature, Factory>> = {}
  const requested: Partial<Record<Feature, 1>> = {}
  const applied: Partial<Record<Feature, 1>> = {}
  let waiting: Args[] = []
  let core = undefined as MiraCore | undefined

  const mira = createMira({
    // key, host and mode as given; the other attributes are ignored options (and data-secret-key throws).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- data-key is checked below, the rest is optional
    ...(data as unknown as MiraOptions),
    trackLocalhost: "trackLocalhost" in data,
    plugins: [
      {
        // createMira only checks that a plugin named identity exists; the real one arrives as a chunk.
        name: "identity",
        setup(given) {
          core = given
          given.state.context.sdk = "mirafive-tracker/" + __VERSION__
          given.state.hash = hash
        }
      },
      ...("manual" in data ? [] : [pageviews({ hash })])
    ]
  })

  // Another tracker or sdk-browser client already runs: createMira warned and stays inert.
  if (!core) {
    return
  }

  const c = core
  const { state } = c
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- verbs call members by name
  const client = mira as unknown as Record<string, (...args: unknown[]) => unknown>

  const load = (feature: Feature): void => {
    if (!requested[feature]) {
      const digest = chunks[features.indexOf(feature)] ?? ""
      const element = d.createElement("script")

      requested[feature] = 1
      // The file name carries the digest's first 8 characters, base64url.
      element.src = new URL(
        `chunks/${feature}.${digest.slice(0, 8).replace(/[+/]/g, (char) => (char < "/" ? "-" : "_"))}.js`,
        script.src
      ).href
      element.integrity = "sha256-" + digest
      element.crossOrigin = "anonymous"
      d.head.append(element)
    }
  }

  // Identity comes with the first grant. A decline loads it only to forget ids a past visit stored.
  const answered = (answer: unknown): void => {
    const granted = answer === true || Object.values(answer || 0).some(Boolean)

    if (granted || stored()) {
      load("identity")
    }

    if (granted && searching) {
      load("search")
    }
  }

  const snippet = (): void => {
    load("flags")

    if (full) {
      load("experiments")
    }
  }

  const run = (args: Args): unknown => {
    const [verb, ...rest] = Array.from(args)
    const name = String(verb)
    const index = verbs.indexOf(name)
    const own = index < 3 ? "" : index < 7 ? "identity" : index < 8 ? "search" : "flags"
    // While a granted consent waits for identity, core verbs wait too, or the full-mode gate drops them.
    const feature = own || (full && requested.identity ? "identity" : "")
    const callback = index === 6 && rest.pop()
    let result: unknown

    if (index < 0) {
      return c.warn("unknown verb: " + name)
    }

    if (full && index === 3) {
      // What identity decides when it applies the answer, decided now, when the answer was given.
      state.boot ??= state.page ? 0 : 1
      answered(rest[0])
    }

    if (feature && !applied[feature]) {
      if (own === "flags") {
        load(own)

        // flag and config: a read replayed later would count an exposure for a value the page never showed.
        if (index < 10) {
          return rest[1]
        }
      }

      if (
        own === "flags" ||
        (full && (feature === "search" ? searching : index !== 6 || requested.identity))
      ) {
        return void waiting.push(args)
      }
    } else {
      result = client[methods[name] ?? name]?.(...rest)
    }

    if (typeof callback === "function") {
      callback(result)
    }

    return result
  }

  w.__mirafive_chunk = (feature, factory) => {
    factories[feature] = factory

    for (const next of features) {
      const ready = factories[next]
      const need = needs[next]

      if (ready && (!need || applied[need])) {
        const queued = waiting

        delete factories[next]
        applied[next] = 1
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only siteSearch reads it
        mira.use(ready({ parameters } as never))
        // In call order; whatever still waits for another chunk queues again.
        waiting = []
        queued.forEach(run)
      }
    }
  }

  if (full && w.__mirafive_consent !== undefined) {
    answered(w.__mirafive_consent)
  }

  if (on(data["autocapture"])) {
    load("autocapture")
  }

  if ("flags" in data || d.getElementById("mirafive-flags")) {
    load("flags")
  }

  const entries = (w.__mirafive_experiments ??= [])
  const { push } = entries

  if (entries.length) {
    snippet()
  }

  entries.push = (...added) => (snippet(), push.apply(entries, added))

  w.mirafive?.q?.forEach(run)

  w.mirafive = (...args) => run(args)
}

const script = document.currentScript

if (script instanceof HTMLScriptElement && script.dataset["key"]) {
  start(script)
} else {
  // oxlint-disable-next-line no-console -- a broken install would otherwise look like one that works
  console.warn("[mirafive] mira.js needs data-key")
}
