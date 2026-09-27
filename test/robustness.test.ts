import { readFileSync } from "node:fs"

import { afterEach, expect, test, vi } from "vitest"

import { flushed, names, open, snippet } from "./helpers.ts"
import type { Page } from "./helpers.ts"

let page: Page | undefined

afterEach(async () => {
  await page?.close()
  page = undefined
})

const settle = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))
const full = { "data-mode": "full" }
const dev = { url: "http://localhost/", attributes: { "data-track-localhost": "" } }
const thrower = "function(){throw new Error('boom')}"

test("a throwing queued call is skipped; the calls after it run and the stub is gone", async () => {
  page = await open({
    ...dev,
    before: snippet(`mirafive('anonymousId', ${thrower})`, "mirafive('track','after')")
  })

  expect("q" in (page.window["mirafive"] as object)).toBe(false)
  expect(names(await flushed(page, 1))).toEqual(["after", "$pageview"])
  expect(page.warnings).toEqual(["[mirafive] anonymousId: Error: boom"])
})

test("a throwing live call returns undefined instead of throwing into the page", async () => {
  page = await open()

  expect(
    page.mirafive("anonymousId", () => {
      throw new Error("boom")
    })
  ).toBeUndefined()
  page.mirafive("track", "after")

  expect(names(await flushed(page, 1))).toEqual(["$pageview", "after"])
})

test("a throwing call replayed on chunk arrival does not stop the replay", async () => {
  page = await open({
    attributes: full,
    before: snippet(
      "mirafive('consent', true)",
      `mirafive('anonymousId', ${thrower})`,
      "mirafive('track','after')"
    )
  })
  await page.until(() => page!.chunks.includes("identity"))

  // "after" was called in the drain, before the landing pageview; both were held.
  expect(names(await flushed(page, 1))).toEqual(["after", "$pageview"])
})

test("a chunk that fails to load warns, settles what waited for it and is retried on the next need", async () => {
  const fail = ["flags"]
  const listener = vi.fn()

  page = await open({ fail })
  page.mirafive("flags", listener)
  page.mirafive("flagProperties", { plan: "pro" })
  await page.until(() => page!.warnings.length)

  expect(page.warnings).toEqual(["[mirafive] flags chunk failed"])

  fail.length = 0
  expect(page.mirafive("flag", "new-checkout", false)).toBe(false)
  page.mirafive("flags", listener)
  await page.until(() => listener.mock.calls.length)

  expect(page.chunks).toEqual(["flags", "flags"])
  expect(listener).toHaveBeenCalledTimes(1)
  expect(page.mirafive("flag", "new-checkout", false)).toBe(true)
})

test("a failed identity chunk answers waiting anonymousId callbacks with undefined", async () => {
  const callback = vi.fn()

  page = await open({ attributes: full, fail: ["identity"] })
  page.mirafive("consent", true)
  page.mirafive("anonymousId", callback)
  page.mirafive("track", "lost")
  await page.until(() => callback.mock.calls.length)

  expect(callback).toHaveBeenCalledWith(undefined)
  expect(page.warnings).toEqual(["[mirafive] identity chunk failed"])
})

test("a data-key that is not a website key warns everywhere; the page still sends", async () => {
  page = await open({ attributes: { "data-key": "sk_live_123" } })

  expect(page.warnings).toEqual(["[mirafive] bad key"])
  expect(names(await flushed(page, 1))).toEqual(["$pageview"])
  await page.close()

  page = await open({ attributes: { "data-key": "mira_ik_legacy01" } })
  expect(page.warnings).toEqual([])
})

test("without document.currentScript it says so", async () => {
  page = await open()
  page.window.eval(readFileSync("dist/mira.js", "utf8"))

  expect(page.warnings).toEqual(["[mirafive] no script tag"])
})

test("a decline without stored ids reaches the flags chunk without loading identity", async () => {
  const experiment = {
    s: "3f9a1c0b7e2d",
    t: "m",
    u: "b",
    d: "a",
    e: "r",
    c: "b",
    r: [
      {
        w: [
          ["a", 5000],
          ["b", 5000]
        ]
      }
    ]
  }
  const flags = { v: 1, at: Date.now(), flags: { "pricing-test": experiment } }
  const listener = vi.fn()

  page = await open({ attributes: { ...full, "data-flags": "" }, flags })
  page.mirafive("flags", listener)
  await page.until(() => listener.mock.calls.length)
  page.mirafive("flag", "pricing-test", "a")

  // Unanswered: random mode draws on a pending id.
  expect(page.window["__mirafive_aid_next"]).toMatch(/^[0-9a-f-]{36}$/)
  await page.close()

  page = await open({ attributes: { ...full, "data-flags": "" }, flags })
  page.mirafive("consent", false)
  page.mirafive("flags", listener)
  await page.until(() => listener.mock.calls.length > 1)

  expect(page.mirafive("flag", "pricing-test", "x")).toBe("a")
  expect(page.window["__mirafive_aid_next"]).toBeUndefined()
  expect(page.chunks).toEqual(["flags"])
})

test("boolean attributes read off and false, in any case and with spaces, as off", async () => {
  page = await open({
    attributes: {
      "data-manual": " OFF ",
      "data-flags": "False",
      "data-autocapture": "false",
      "data-hash": "off",
      "data-track-localhost": "off"
    }
  })
  await settle()

  expect(page.chunks).toEqual([])
  expect(names(await flushed(page, 1))).toEqual(["$pageview"])
})

test("site-search parameter names are trimmed; only documented attributes become options", async () => {
  page = await open({
    url: "https://shop.example/find?term=boots",
    attributes: { ...full, "data-site-search": " term , k ", "data-flush-at": "1", "data-secret-key": "x" },
    before: snippet("mirafive('consent', true)")
  })
  await page.until(() => page!.chunks.includes("search"))
  await settle()

  // data-flush-at is not an option: nothing has been sent before the explicit flush.
  expect(page.batches).toEqual([])

  const events = (await flushed(page, 1)).flatMap((batch) => batch.events)

  expect(events.find((event) => event.name === "$search")?.properties).toEqual({ query: "boots" })
})
