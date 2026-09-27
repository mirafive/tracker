import { afterEach, expect, test, vi } from "vitest"

import { flushed, names, open, snippet } from "./helpers.ts"
import type { Page } from "./helpers.ts"

let page: Page | undefined

afterEach(async () => {
  await page?.close()
  page = undefined
})

const full = { "data-mode": "full" }

test("the queue is drained in order, then window.mirafive is the command function", async () => {
  page = await open({ before: snippet("mirafive('track','first',{n:1})", "mirafive('track','second')") })

  expect((page.window["mirafive"] as { q?: unknown }).q).toBeUndefined()
  page.mirafive("track", "third")

  expect(names(await flushed(page, 1))).toEqual(["first", "second", "$pageview", "third"])
  expect(page.batches[0]!.events[0]!.properties).toEqual({ n: 1 })
})

test("verbs waiting for identity are replayed in call order once it arrives", async () => {
  page = await open({
    attributes: full,
    before: snippet(
      "mirafive('identify','u_1',{plan:'pro'})",
      "mirafive('consent',true)",
      "mirafive('track','signup')"
    )
  })
  await page.until(() => page!.chunks.includes("identity"))

  const events = (await flushed(page, 1)).flatMap((batch) => batch.events)

  // track ran in the drain and the landing pageview a microtask later, both held; identify waited for identity.
  // The grant released all three, with the user the page identified.
  expect(events.map((event) => event.name)).toEqual(["signup", "$pageview", "$identify"])
  expect(events.every((event) => event.userId === "u_1" && event.anonymousId)).toBe(true)
  expect(events[1]!.properties).toEqual({ $boot: 1 })
  expect(events[2]!.properties).toEqual({ plan: "pro" })
})

test("core verbs called while identity is on its way are not dropped", async () => {
  page = await open({ attributes: full })
  page.mirafive("consent", true)
  page.mirafive("track", "signup")
  await page.until(() => page!.chunks.includes("identity"))

  const events = (await flushed(page, 1)).flatMap((batch) => batch.events)

  expect(events.map((event) => event.name)).toEqual(["$pageview", "signup"])
  // Answered after the page drew: no $boot.
  expect(events[0]!.properties).toBeUndefined()
  expect(page.batches[0]!.mode).toBe("full")
  expect(Object.keys(page.batches[0]!.context).toSorted()).toEqual(["locale", "screen", "sdk", "timezone"])
})

test("anonymousId answers through its callback", async () => {
  page = await open()

  const consentless = vi.fn()

  page.mirafive("anonymousId", consentless)
  expect(consentless).toHaveBeenCalledWith(undefined)
  await page.close()

  page = await open({ attributes: full })

  const early = vi.fn()
  const later = vi.fn()

  page.mirafive("anonymousId", early)
  expect(early).toHaveBeenCalledWith(undefined)
  page.mirafive("consent", true)
  page.mirafive("anonymousId", later)
  expect(later).not.toHaveBeenCalled()
  await page.until(() => later.mock.calls.length)

  expect(later.mock.calls[0]![0]).toMatch(/^[0-9a-f-]{36}$/)
})

test("flag and config answer the fallback until flags load; the flags listener is replayed", async () => {
  page = await open()

  const listener = vi.fn()

  expect(page.mirafive("flag", "new-checkout", false)).toBe(false)
  expect(page.mirafive("config", "limits", { max: 1 })).toEqual({ max: 1 })
  page.mirafive("flagProperties", { plan: "pro" })
  page.mirafive("flags", listener)
  await page.until(() => listener.mock.calls.length)

  expect(page.chunks).toEqual(["flags"])
  expect(page.mirafive("flag", "new-checkout", false)).toBe(true)
  expect(page.mirafive("config", "limits", { max: 1 })).toEqual({ max: 3 })
  expect(page.flagRequests).toHaveLength(1)
  expect(page.flagRequests[0]).toMatch(
    /^GET https:\/\/events\.mirafive\.io\/v1\/flags\/mf_ab12cd34_website\?view=values$/
  )
})

test("search, pageview and flush map to the client", async () => {
  page = await open({
    attributes: { ...full, "data-site-search": "" },
    before: snippet("mirafive('consent', true)", "mirafive('search', 'red shoes')")
  })
  await page.until(() => page!.chunks.includes("search"))

  const events = (await flushed(page, 1)).flatMap((batch) => batch.events)

  expect(events.find((event) => event.name === "$search")?.properties).toEqual({ query: "red shoes" })
})

test("identity verbs are silent in consentless mode", async () => {
  page = await open({ url: "http://localhost/", attributes: { "data-track-localhost": "" } })
  page.mirafive("consent", true)
  page.mirafive("identify", "u_1")

  expect(page.warnings).toEqual([])
  expect(page.chunks).toEqual([])
})

test("unknown verbs warn in development only", async () => {
  page = await open({ url: "http://localhost/", attributes: { "data-track-localhost": "" } })
  expect(page.mirafive("event", "x")).toBeUndefined()
  expect(page.warnings).toEqual(["[mirafive] unknown verb event"])
  await page.close()

  page = await open()
  page.mirafive("event", "x")
  expect(page.warnings).toEqual([])
})

test("a second loader on the page stays out of the way", async () => {
  page = await open()

  const first = page.window["mirafive"]
  const again = page.window.document.createElement("script")

  again.src = "https://cdn.mirafive.io/v1/mira.js"
  again.dataset["key"] = "mf_ab12cd34_website"
  page.window.document.head.append(again)
  await new Promise((resolve) => setTimeout(resolve, 20))

  expect(page.window["mirafive"]).toBe(first)
  expect(names(await flushed(page, 1))).toEqual(["$pageview"])
})

test("pageviews and events while identity downloads are held and sent with ids, the landing pageview once", async () => {
  page = await open({
    attributes: full,
    before: snippet("mirafive('consent', true)"),
    delay: { identity: 100 }
  })

  // Identity was requested in the drain and is still on its way.
  expect(page.chunks).toEqual(["identity"])
  page.window.history.pushState({}, "", "/checkout")
  await new Promise((resolve) => setTimeout(resolve, 0))
  page.window.eval("mirafive('track', 'clicked')")
  await page.until(() => page!.mirafive("anonymousId", () => {}) !== undefined)

  const events = (await flushed(page, 1)).flatMap((batch) => batch.events)

  expect(events.map((event) => [event.name, event.page?.url])).toEqual([
    ["$pageview", "https://shop.example/pricing?utm_source=news"],
    ["$pageview", "https://shop.example/checkout"],
    ["clicked", "https://shop.example/checkout"]
  ])
  expect(events.every((event) => event.anonymousId)).toBe(true)
})
