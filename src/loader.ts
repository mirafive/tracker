import { createMira } from "@mirafive/sdk-browser"
import type { MiraCore } from "@mirafive/sdk-browser"
import { pageviews } from "@mirafive/sdk-browser/pageviews"

import { KEY_PATTERN } from "./protocol/key.ts"
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

// Setup problems: shown everywhere, unlike the core's development-only warnings.
// oxlint-disable-next-line no-console -- a broken install would otherwise look like one that works
const alert = (message: string): void => console.warn("[mirafive] " + message)

const stored = (): boolean | void => {
  try {
    return Object.keys(localStorage).some((name) => name.startsWith("mirafive:"))
  } catch {
    // Blocked storage holds nothing to forget.
  }
}

// A present attribute is on unless it says off or false.
const on = (value: string | undefined): boolean => value !== undefined && !/^(off|false)$/i.test(value.trim())

const start = (script: HTMLScriptElement, key: string): void => {
  const w = window as Window & TrackerGlobals
  const d = document
  const data = script.dataset
  const full = data["mode"] === "full"
  const hash = on(data["hash"])
  const searching = full && on(data["siteSearch"])
  const parameters = data["siteSearch"]
    ?.split(",")
    .map((name) => name.trim())
    .filter((name) => name && !/^(on|true)$/i.test(name))
  const factories: Partial<Record<Feature, Factory>> = {}
  const requested: Partial<Record<Feature, 1>> = {}
  const applied: Partial<Record<Feature, 1>> = {}
  let waiting: [Feature, Args][] = []
  let holding: 0 | 1 = 0
  let core = undefined as MiraCore | undefined

  const mira = createMira({
    key,
    ...(data["host"] ? { host: data["host"] } : {}),
    mode: full ? "full" : "consentless",
    trackLocalhost: on(data["trackLocalhost"]),
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
      ...(on(data["manual"]) ? [] : [pageviews({ hash })])
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

  const answer = (args: Args, value?: unknown): void => {
    const callback = args[args.length - 1]

    if (typeof callback === "function") {
      callback(value)
    }
  }

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
      // Network, SRI or CSP: a later need retries; what waited for this chunk is settled now.
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- our own element, one handler
      element.onerror = () => {
        const settled = waiting.filter(([waits]) => waits === feature)

        delete requested[feature]
        waiting = waiting.filter(([waits]) => waits !== feature)
        alert(feature + " chunk failed")

        if (feature === "identity") {
          holding = 0
          c.release(false)
        }

        // With identity no longer on its way, anonymousId answers undefined.
        settled.forEach(([, args]) => args[0] === "anonymousId" && safe(args))
      }
      d.head.append(element)
    }
  }

  // Identity comes with the first grant. A decline loads it only to forget ids a past visit stored;
  // otherwise the decline is recorded here, so flags stop drawing for an unanswered visitor.
  const answered = (given: unknown): void => {
    const granted = given === true || Object.values(given || 0).some(Boolean)

    if (granted && !applied.identity && !holding) {
      // Events until identity arrives are kept; identity releases them.
      holding = 1
      c.hold()
    }

    if (granted || stored()) {
      load("identity")
    } else if (!requested.identity) {
      state.consent = {}
      c.emit("consent", {})
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
    // Held events reach the queue only when identity releases them, so flush waits for it.
    const feature = own || (index === 2 && holding && !applied.identity ? "identity" : "")
    let result: unknown

    if (index < 0) {
      return c.warn("unknown verb " + name)
    }

    if (index === 6) {
      rest.pop()
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
        return void waiting.push([feature, args])
      }
    } else {
      result = client[methods[name] ?? name]?.(...rest)
    }

    if (index === 6) {
      answer(args, result)
    }

    return result
  }

  // One bad call (a throwing callback, a bad argument) must not stop the calls after it.
  const safe = (args: Args): unknown => {
    try {
      return run(args)
    } catch (error) {
      return c.warn(`${String(args[0])}: ${String(error)}`)
    }
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
        mira.use(
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only siteSearch reads it
          ready({ parameters: parameters?.length ? parameters : undefined } as never)
        )
        // In call order; whatever still waits for another chunk queues again.
        waiting = []
        queued.forEach(([, args]) => safe(args))
      }
    }
  }

  if (full && w.__mirafive_consent !== undefined) {
    answered(w.__mirafive_consent)
  }

  if (on(data["autocapture"])) {
    load("autocapture")
  }

  if (on(data["flags"]) || d.getElementById("mirafive-flags")) {
    load("flags")
  }

  const entries = (w.__mirafive_experiments ??= [])
  const { push } = entries

  if (entries.length) {
    snippet()
  }

  entries.push = (...added) => (snippet(), push.apply(entries, added))

  const stub = w.mirafive

  // Swapped first: whatever the drain does, the page never keeps the stub.
  w.mirafive = (...args) => safe(args)
  stub?.q?.forEach(safe)
}

const script = document.currentScript
const key = script instanceof HTMLScriptElement ? script.dataset["key"] : undefined

if (!(script instanceof HTMLScriptElement)) {
  alert("no script tag")
} else if (!key) {
  alert("no data-key")
} else {
  if (!KEY_PATTERN.test(key) && !/^mira_ik_[\w-]+$/.test(key)) {
    alert("bad key")
  }

  start(script, key)
}
