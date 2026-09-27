import { afterEach, expect, test } from "vitest"

import { flushed, KEY, names, open, snippet } from "./helpers.ts"
import type { Page } from "./helpers.ts"

let page: Page | undefined

afterEach(async () => {
  await page?.close()
  page = undefined
})

test("a bare tag sends a consentless pageview as mirafive-tracker, cleaned, with no device context", async () => {
  page = await open()

  const [batch] = await flushed(page, 1)

  expect(page.batchUrls).toEqual([`https://events.mirafive.io/v1/batch/${KEY}`])
  expect(batch).toMatchObject({ v: 1, mode: "consentless", context: { sdk: "mirafive-tracker/1.0.0" } })
  expect(Object.keys(batch!.context)).toEqual(["sdk"])
  expect(batch!.events).toMatchObject([
    { name: "$pageview", page: { url: "https://shop.example/pricing?utm_source=news" } }
  ])
  expect(batch!.events[0]).not.toHaveProperty("anonymousId")
  expect(page.window.localStorage.length).toBe(0)
  expect(page.window.document.cookie).toBe("")
})

test("without data-key it warns, collects nothing and leaves the queue alone", async () => {
  page = await open({
    attributes: { "data-key": "" },
    before: snippet("mirafive('track','x')"),
    noWait: true
  })

  expect(page.warnings).toEqual(["[mirafive] no data-key"])
  expect((page.window["mirafive"] as { q?: unknown[] }).q).toHaveLength(1)
  expect(page.batches).toEqual([])
})

test("data-host sends batches to that host", async () => {
  page = await open({ attributes: { "data-host": "https://stats.shop.example/" } })
  await flushed(page, 1)

  expect(page.batchUrls).toEqual([`https://stats.shop.example/v1/batch/${KEY}`])
})

test("data-manual sends no automatic pageviews, the pageview verb still works", async () => {
  page = await open({ attributes: { "data-manual": "" } })

  page.window.history.pushState({}, "", "/checkout")
  await new Promise((resolve) => setTimeout(resolve, 10))
  page.mirafive("pageview", { url: "https://shop.example/virtual" })

  expect(names(await flushed(page, 1))).toEqual(["$pageview"])
  expect(page.batches[0]!.events[0]!.page!.url).toBe("https://shop.example/virtual")
})

test("pushState navigations are pageviews; data-hash keeps the fragment", async () => {
  page = await open({ attributes: { "data-hash": "" }, url: "https://shop.example/#/start" })

  page.window.history.pushState({}, "", "/#/cart")
  await new Promise((resolve) => setTimeout(resolve, 10))

  const [batch] = await flushed(page, 1)

  expect(batch!.events.map((event) => event.page!.url)).toEqual([
    "https://shop.example/#/start",
    "https://shop.example/#/cart"
  ])
})

test("localhost sends nothing and warns, unless data-track-localhost", async () => {
  page = await open({ url: "http://localhost:3000/" })
  await page.mirafive("flush")

  expect(page.batches).toEqual([])
  expect(page.warnings).toContain("[mirafive] local host: set trackLocalhost")
  await page.close()

  page = await open({ url: "http://localhost:3000/", attributes: { "data-track-localhost": "" } })

  expect(names(await flushed(page, 1))).toEqual(["$pageview"])
})

test("data-mode=full sends nothing before consent", async () => {
  page = await open({ attributes: { "data-mode": "full" } })
  page.mirafive("track", "signup")
  await page.mirafive("flush")
  await new Promise((resolve) => setTimeout(resolve, 20))

  expect(page.batches).toEqual([])
  expect(page.chunks).toEqual([])
})

test("data-site-search with parameters reads those parameters", async () => {
  page = await open({
    url: "https://shop.example/find?term=boots",
    attributes: { "data-mode": "full", "data-site-search": "term, k" },
    before: snippet("mirafive('consent', true)")
  })
  await page.until(() => page!.chunks.includes("search"))
  await new Promise((resolve) => setTimeout(resolve, 30))

  const batches = await flushed(page, 1)
  const search = batches.flatMap((batch) => batch.events).find((event) => event.name === "$search")

  expect(search?.properties).toEqual({ query: "boots" })
})
