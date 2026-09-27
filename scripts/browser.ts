/**
 * Real-browser smoke test: serves dist/ and test pages from a local server with stub ingest and flag
 * endpoints, drives the installed Chrome headless (playwright-core, no browser download), and checks the
 * scenarios unit tests cannot: real SRI, real sendBeacon, real history, real storage.
 *
 *   bun run test:browser        (builds first)
 *
 * CHROME_PATH overrides the browser; otherwise Playwright's "chrome" channel finds the installed one.
 */
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { chromium } from "playwright-core"
import type { Page } from "playwright-core"

interface Received {
  path: string
  beacon: boolean
  body: {
    mode: string
    context: Record<string, unknown>
    events: { name: string; page?: { url: string }; anonymousId?: string; properties?: object }[]
  }
}

const key = "mf_ab12cd34_website"
const batches: Received[] = []
const chunkRequests: string[] = []
const flagRequests: string[] = []
let tamper = false
let slowIdentity = 0

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost")
  const cors = { "access-control-allow-origin": "*" }

  if (url.pathname.startsWith("/dist/")) {
    if (slowIdentity && url.pathname.includes("/identity.")) {
      setTimeout(() => {
        slowIdentity = 0
        server.emit("request", request, response)
      }, slowIdentity)
      return
    }

    let body = readFileSync("." + url.pathname, "utf8")

    if (url.pathname.includes("/chunks/")) {
      chunkRequests.push(url.pathname.split("/").pop()!.split(".")[0]!)
      body += tamper ? "\n;" : ""
    }

    response.writeHead(200, { "content-type": "text/javascript", ...cors })
    response.end(body)
    return
  }

  if (url.pathname.startsWith("/v1/batch/")) {
    let text = ""

    request.on("data", (part: Buffer) => (text += part.toString()))
    request.on("end", () => {
      batches.push({
        path: url.pathname,
        beacon: url.searchParams.has("beacon"),
        body: JSON.parse(text) as Received["body"]
      })
      response.writeHead(202, { "content-type": "application/json", ...cors })
      response.end('{"accepted":1,"dropped":0}')
    })
    return
  }

  if (url.pathname.startsWith("/v1/flags/")) {
    flagRequests.push(request.method + " " + url.pathname + url.search)
    response.writeHead(200, { "content-type": "application/json", ...cors })
    response.end(JSON.stringify({ v: 1, at: Date.now(), values: { "new-checkout": ["on"] } }))
    return
  }

  if (url.pathname.startsWith("/page")) {
    response.writeHead(200, { "content-type": "text/html" })
    response.end(
      `<!doctype html><title>${url.pathname}</title>
<script>window.mirafive=window.mirafive||function(){(mirafive.q=mirafive.q||[]).push(arguments)}</script>
<script defer src="http://cdn.test:${port()}/dist/mira.js" data-key="${key}" data-host="http://site.test:${port()}" ${url.searchParams.get("attributes") ?? ""}></script>`
    )
    return
  }

  response.writeHead(404)
  response.end()
})

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

function port(): number {
  return (server.address() as AddressInfo).port
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env["CHROME_PATH"] ? { executablePath: process.env["CHROME_PATH"] } : { channel: "chrome" }),
  // Real host names, so the tracker runs its production path (no localhost opt-in, no dev warnings).
  args: [`--host-resolver-rules=MAP site.test 127.0.0.1, MAP cdn.test 127.0.0.1`]
})
const context = await browser.newContext()
const results: [string, boolean, string | undefined][] = []

// Records every read of what consentless code must never read.
await context.addInitScript(() => {
  const reads: string[] = ((window as unknown as { mirafiveReads: string[] }).mirafiveReads = [])
  const spy = (target: object, name: string, label: string): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name)!

    Object.defineProperty(target, name, {
      ...descriptor,
      ...(descriptor.get
        ? {
            get(this: unknown) {
              reads.push(label)
              return descriptor.get!.call(this)
            }
          }
        : {
            value(this: unknown, ...args: unknown[]) {
              reads.push(label)
              return (descriptor.value as (...args: unknown[]) => unknown).apply(this, args)
            }
          })
    })
  }

  spy(Navigator.prototype, "language", "language")
  spy(Screen.prototype, "width", "screen")
  spy(Intl.DateTimeFormat.prototype, "resolvedOptions", "timezone")
  spy(Storage.prototype, "setItem", "storage")

  // A closing page reports no requests and plain http gets no Sec-Fetch headers: the beacon marks its URL.
  const beacon = Navigator.prototype.sendBeacon

  Navigator.prototype.sendBeacon = function (url, data) {
    return beacon.call(this, String(url) + "?beacon", data)
  }
})

const check = (name: string, ok: boolean, detail?: unknown): void => {
  results.push([name, ok, ok ? undefined : JSON.stringify(detail)])
}

const until = async (condition: () => unknown, ms = 3000): Promise<boolean> => {
  for (const start = Date.now(); Date.now() - start < ms;) {
    if (condition()) {
      return true
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  return !!condition()
}

const reset = (): void => {
  batches.length = 0
  chunkRequests.length = 0
  flagRequests.length = 0
}

const visit = async (attributes = "", path = "/page"): Promise<Page> => {
  const page = await context.newPage()

  await page.goto(`http://site.test:${port()}${path}?attributes=${encodeURIComponent(attributes)}`)
  await page.waitForFunction(() => typeof window.mirafive === "function" && !("q" in window.mirafive))
  await page.waitForTimeout(50)

  return page
}

const command = async (page: Page, ...args: unknown[]): Promise<unknown> =>
  page.evaluate((given) => window.mirafive(...given), args)

const events = (): string[] => batches.flatMap((batch) => batch.body.events.map((event) => event.name))

declare global {
  interface Window {
    mirafive: (...args: unknown[]) => unknown
  }
}

try {
  // 1. Consentless: one pageview batch, no device context, no storage, no chunk.
  reset()

  let page = await visit()

  await command(page, "flush")
  await until(() => batches.length)

  const reads = await page.evaluate(() => (window as unknown as { mirafiveReads: string[] }).mirafiveReads)
  const storage = await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])

  check("consentless: pageview batch sent", events().join() === "$pageview", batches)
  check(
    "consentless: batch path and mode",
    batches[0]?.path === `/v1/batch/${key}` && batches[0].body.mode === "consentless",
    batches[0]
  )
  check(
    "consentless: context is only the sdk name",
    JSON.stringify(batches[0]?.body.context) === '{"sdk":"mirafive-tracker/0.5.0"}',
    batches[0]?.body.context
  )
  check(
    "consentless: language, time zone, screen and storage never read or written",
    reads.length === 0,
    reads
  )
  check("consentless: nothing stored, no cookie", storage.join() === "0,0,", storage)
  check("consentless: no chunk loaded", chunkRequests.length === 0, chunkRequests)

  // 2. pushState navigation sends a second pageview.
  reset()
  await page.evaluate(() => history.pushState({}, "", "/page/next"))
  await page.waitForTimeout(50)
  await command(page, "flush")
  await until(() => batches.length)
  check(
    "navigation: pushState sends a second pageview",
    batches[0]?.body.events[0]?.name === "$pageview" &&
      batches[0].body.events[0].page?.url === `http://site.test:${port()}/page/next`,
    batches
  )

  // 3. Page hide flushes through sendBeacon.
  reset()
  await command(page, "track", "leaving")
  await page.close({ runBeforeUnload: true })
  await until(() => batches.length)
  check(
    "hide: closing the page flushes the queue by beacon",
    events().join() === "leaving" && batches[0]?.beacon === true,
    batches
  )

  // 4. Full: nothing before consent, identity chunk and a full batch after.
  reset()
  page = await visit('data-mode="full"')
  await command(page, "track", "before-consent")
  await command(page, "flush")
  await page.waitForTimeout(300)
  check(
    "full: nothing sent and no chunk before consent",
    batches.length === 0 && chunkRequests.length === 0,
    [batches, chunkRequests]
  )

  await command(page, "consent", true)
  await command(page, "track", "after-consent")
  await until(() => chunkRequests.includes("identity"))
  await page.waitForTimeout(100)
  await command(page, "flush")
  await until(() => batches.length)

  const fullBatch = batches[0]?.body
  const stored = await page.evaluate(() => Object.keys(localStorage))

  check("full: identity chunk loaded on consent", chunkRequests.join() === "identity", chunkRequests)
  check(
    "full: landing pageview resent and the event after consent kept",
    events().join() === "$pageview,after-consent",
    events()
  )
  check(
    "full: full batch with locale, timezone, screen and ids",
    fullBatch?.mode === "full" &&
      ["locale", "timezone", "screen"].every((name) => name in fullBatch.context) &&
      fullBatch.events.every((event) => event.anonymousId),
    fullBatch
  )
  check("full: ids stored under the key's namespace", stored.includes("mirafive:mf_ab12cd34:aid"), stored)
  await page.close()

  // 4b. Between the grant and identity's arrival, navigations and events are held, the landing pageview sent once.
  reset()
  page = await visit('data-mode="full"')
  slowIdentity = 500
  await command(page, "consent", true)
  await page.evaluate(() => history.pushState({}, "", "/page/held"))
  await page.waitForTimeout(50)
  await command(page, "track", "held-event")
  await until(() => chunkRequests.includes("identity"), 2000)
  await page.waitForFunction(() => window.mirafive("anonymousId", () => {}) !== undefined)
  await command(page, "flush")
  await until(() => batches.length)

  const held = batches.flatMap((batch) => batch.body.events)

  check(
    "hold: landing pageview once, held navigation and event sent with ids after identity",
    JSON.stringify(held.map((event) => [event.name, event.page?.url.split(String(port()))[1]])) ===
      JSON.stringify([
        ["$pageview", "/page"],
        ["$pageview", "/page/held"],
        ["held-event", "/page/held"]
      ]) && held.every((event) => event.anonymousId),
    held
  )
  await page.close()

  // 5. Flags load from beside the loader and answer; a tampered chunk is blocked by SRI.
  reset()
  page = await visit("data-flags")
  await until(() => flagRequests.length)
  await page.waitForTimeout(100)
  check(
    "flags: chunk loads cross-origin with SRI and answers",
    chunkRequests.join() === "flags" && (await command(page, "flag", "new-checkout", false)) === true,
    [chunkRequests, flagRequests]
  )
  await page.close()

  reset()
  tamper = true
  page = await context.newPage()

  const errors: string[] = []

  const warnings: string[] = []

  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text())
    } else if (message.type() === "warning") {
      warnings.push(message.text())
    }
  })
  await page.goto(`http://site.test:${port()}/page?attributes=data-flags`)
  await page.waitForFunction(() => typeof window.mirafive === "function" && !("q" in window.mirafive))
  await until(() => chunkRequests.length)
  await page.waitForTimeout(300)
  check(
    "sri: a tampered chunk is requested, never runs, and the tracker says so",
    // The flag read below retries the chunk, which is blocked again.
    chunkRequests[0] === "flags" &&
      flagRequests.length === 0 &&
      (await command(page, "flag", "new-checkout", false)) === false &&
      errors.some((text) => /integrity/i.test(text)) &&
      warnings.includes("[mirafive] flags chunk failed"),
    { chunkRequests, flagRequests, errors, warnings }
  )
  tamper = false
  await page.close()
} finally {
  await browser.close()
  server.close()
}

for (const [name, ok, detail] of results) {
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`)
}

if (results.some(([, ok]) => !ok)) {
  process.exit(1)
}
