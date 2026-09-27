import { readFileSync } from "node:fs"

import { Window } from "happy-dom"

export const CDN = "https://cdn.mirafive.io/v1/"
export const HOST = "https://events.mirafive.io"
export const KEY = "mf_ab12cd34_website"

export interface Manifest {
  version: string
  loader: { file: string; integrity: string }
  chunks: Record<string, { file: string; integrity: string }>
}

export interface Batch {
  v: number
  mode: string
  context: Record<string, unknown>
  events: {
    name: string
    properties?: Record<string, unknown>
    anonymousId?: string
    userId?: string
    page?: { url: string }
  }[]
}

export const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8")) as Manifest

type Command = (...args: unknown[]) => unknown

export interface Page {
  window: Window & Record<string, unknown>
  mirafive: Command
  /** Chunk names in the order they were requested. */
  chunks: string[]
  batches: Batch[]
  batchUrls: string[]
  flagRequests: string[]
  warnings: string[]
  /** The loader's own and every chunk's script element. */
  scripts: () => HTMLScriptElement[]
  until: (condition: () => unknown) => Promise<void>
  close: () => Promise<void>
}

export interface OpenOptions {
  attributes?: Record<string, string>
  /** Runs in the page before the loader (the queue snippet, consent presets, experiment snippets). */
  before?: string
  /** HTML put into <body> before the loader runs. */
  body?: string
  url?: string
  /** Where the loader is served from; chunks come from beside it. */
  base?: string
  /** Load the loader and do not wait for it to take over `window.mirafive`. */
  noWait?: boolean
  /** Chunk names answered with a 404 (a network, SRI or CSP failure looks the same to the page). */
  fail?: string[]
  /** Milliseconds a chunk's response is held back, by chunk name. */
  delay?: Record<string, number>
  /** What /v1/flags answers. */
  flags?: object
}

const chunkName = (url: string, base: string): string | undefined =>
  Object.entries(manifest.chunks).find(([, chunk]) => url === base + chunk.file)?.[0]

const reply = (context: { window: { Response: unknown } }, text: string, status: number): Response => {
  const { Response: HappyResponse } = context.window as unknown as { Response: typeof Response }

  return new HappyResponse(text, {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
  })
}

export const flagDocument = {
  v: 1,
  at: Date.now(),
  values: { "new-checkout": ["on"], limits: ["pro", { max: 3 }] }
}

export const open = async ({
  attributes = {},
  before = "",
  body = "",
  url = "https://shop.example/pricing?utm_source=news&secret=1",
  base = CDN,
  noWait = false,
  fail = [],
  delay = {},
  flags = flagDocument
}: OpenOptions = {}): Promise<Page> => {
  const chunks: string[] = []
  const batches: Batch[] = []
  const batchUrls: string[] = []
  const flagRequests: string[] = []
  const warnings: string[] = []
  const window = new Window({
    url,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      suppressCodeGenerationFromStringsWarning: true,
      fetch: {
        disableSameOriginPolicy: true,
        interceptor: {
          beforeAsyncRequest: async (context) => {
            const { request } = context
            const respond = (text: string, status = 200): Response => reply(context, text, status)

            if (request.url.startsWith(base)) {
              const name = chunkName(request.url, base)

              if (name) {
                chunks.push(name)

                await new Promise((resolve) => setTimeout(resolve, delay[name] ?? 0))

                if (fail.includes(name)) {
                  return respond("", 404) as never
                }
              }

              return respond(readFileSync("dist/" + request.url.slice(base.length), "utf8")) as never
            }

            if (request.url.includes("/v1/batch/")) {
              batchUrls.push(request.url)
              batches.push(JSON.parse(await request.text()) as Batch)

              return respond('{"accepted":1,"dropped":0}', 202) as never
            }

            if (request.url.startsWith(HOST + "/v1/flags/")) {
              flagRequests.push(request.method + " " + request.url)

              return respond(JSON.stringify(flags)) as never
            }

            return respond("{}", 404) as never
          }
        }
      }
    }
  }) as unknown as Window & Record<string, unknown>
  const { document } = window

  const append = document.head.append.bind(document.head)

  // Browsers load an inserted script async; happy-dom would fetch it synchronously without the attribute.
  document.head.append = (...nodes) => {
    for (const node of nodes) {
      if (node instanceof window.HTMLScriptElement && node.src) {
        node.async = true
      }
    }

    append(...nodes)
  }
  ;(window.console as Console).warn = (message: string) => void warnings.push(message)
  document.body.innerHTML = body

  if (before) {
    const inline = document.createElement("script")

    inline.textContent = before
    document.head.append(inline)
  }

  const script = document.createElement("script")

  script.src = base + "mira.js"
  script.defer = true
  script.dataset["key"] = KEY

  for (const [name, value] of Object.entries(attributes)) {
    script.setAttribute(name, value)
  }

  const page = {
    window,
    mirafive: (...args: unknown[]) => (window["mirafive"] as Command)(...args),
    chunks,
    batches,
    batchUrls,
    flagRequests,
    warnings,
    scripts: () => [...document.querySelectorAll("script[src]")] as unknown as HTMLScriptElement[],
    until: async (condition: () => unknown) => {
      for (let tries = 0; !condition(); tries++) {
        if (tries > 200) {
          throw new Error("timed out waiting for " + condition.toString())
        }

        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
    close: async () => {
      // happy-dom's abort() hangs on a script fetch still in flight.
      await new Promise((resolve) => setTimeout(resolve, 30))
      await window.happyDOM.abort()
      await window.happyDOM.close()
    }
  }

  document.head.append(script)

  if (noWait) {
    await new Promise((resolve) => setTimeout(resolve, 20))

    return page
  }

  await page.until(() => typeof window["mirafive"] === "function" && !("q" in (window["mirafive"] as object)))
  // The landing pageview goes out a microtask after the loader ran.
  await new Promise((resolve) => setTimeout(resolve, 0))

  return page
}

/** The queue snippet from the README, and whatever the page calls before the loader. */
export const snippet = (...calls: string[]): string =>
  "window.mirafive=window.mirafive||function(){(mirafive.q=mirafive.q||[]).push(arguments)};" +
  calls.join(";")

export const flushed = async (page: Page, count: number): Promise<Batch[]> => {
  await page.mirafive("flush")
  await page.until(() => page.batches.length >= count)

  return page.batches
}

export const names = (batches: Batch[]): string[] =>
  batches.flatMap((batch) => batch.events.map((e) => e.name))
