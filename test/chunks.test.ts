import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import { afterEach, expect, test } from "vitest"

import { flagDocument, flushed, manifest, open } from "./helpers.ts"
import type { Page } from "./helpers.ts"

let page: Page | undefined

afterEach(async () => {
  await page?.close()
  page = undefined
})

const settle = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))
const full = { "data-mode": "full" }
const entry = { k: "hero-copy", v: "b", s: "seed", w: [5000, 5000], m: "r", h: "abcdef12", b: 0 }
const sri = (file: string, algorithm: string): string =>
  `${algorithm}-${createHash(algorithm)
    .update(readFileSync("dist/" + file))
    .digest("base64")}`

test("consentless default: no chunk", async () => {
  page = await open()
  page.mirafive("consent", true)
  await settle()

  expect(page.chunks).toEqual([])
})

test("full without consent: no chunk, even with site search", async () => {
  page = await open({ attributes: { ...full, "data-site-search": "" } })
  page.mirafive("identify", "u_1")
  await settle()

  expect(page.chunks).toEqual([])
})

test("full with consent: identity, and search when data-site-search asks", async () => {
  page = await open({ attributes: full })
  page.mirafive("consent", { experiments: true })
  await page.until(() => page!.chunks.length)

  expect(page.chunks).toEqual(["identity"])
  await page.close()

  page = await open({ attributes: { ...full, "data-site-search": "on" } })
  page.mirafive("consent", true)
  await page.until(() => page!.chunks.length === 2)

  expect(page.chunks).toEqual(["identity", "search"])
})

test("full with a pre-set __mirafive_consent: identity at once, landing pageview with $boot 1", async () => {
  page = await open({ attributes: full, before: "window.__mirafive_consent = { statistics: true }" })
  await page.until(() => page!.chunks.length)

  expect(page.chunks).toEqual(["identity"])

  const [batch] = await flushed(page, 1)

  expect(batch!.events).toMatchObject([{ name: "$pageview", properties: { $boot: 1 } }])
  expect(page.window.localStorage.getItem("mirafive:mf_ab12cd34:aid")).toMatch(/^[0-9a-f-]{36}\.\d+$/)
})

test("a decline loads identity only when a past visit stored ids, and then forgets them", async () => {
  page = await open({ attributes: full })
  page.mirafive("consent", false)
  await settle()

  expect(page.chunks).toEqual([])
  await page.close()

  page = await open({
    attributes: full,
    before: "localStorage.setItem('mirafive:mf_ab12cd34:aid', '5f0c1c8e-3e0e-4a57-9d59-3f7f2a6d1e44.1')"
  })
  page.mirafive("consent", false)
  await page.until(() => page!.chunks.length)
  await settle()

  expect(page.chunks).toEqual(["identity"])
  expect(page.window.localStorage.length).toBe(0)
})

test("autocapture by attribute, off and false keep it out", async () => {
  page = await open({ attributes: { "data-autocapture": "" }, body: "<button id='buy'>Buy</button>" })
  await page.until(() => page!.chunks.length)
  ;(page.window.document.getElementById("buy") as unknown as HTMLElement).click()

  const events = (await flushed(page, 1)).flatMap((batch) => batch.events)

  expect(page.chunks).toEqual(["autocapture"])
  expect(events.find((event) => event.name === "$autocapture")?.properties).toMatchObject({ $el_id: "buy" })

  for (const value of ["off", "false"]) {
    await page.close()
    page = await open({ attributes: { "data-autocapture": value } })
    await settle()

    expect(page.chunks).toEqual([])
  }
})

test("flags by attribute, by a bootstrap block, or by the first flag verb", async () => {
  page = await open({ attributes: { "data-flags": "" } })
  await page.until(() => page!.chunks.length)

  expect(page.chunks).toEqual(["flags"])
  await page.close()

  const bootstrap = JSON.stringify({ ...flagDocument, at: Date.now() })

  page = await open({ body: `<script type="application/json" id="mirafive-flags">${bootstrap}</script>` })
  await page.until(() => page!.chunks.length)

  expect(page.chunks).toEqual(["flags"])
  await page.close()

  page = await open()
  await settle()
  expect(page.chunks).toEqual([])
  page.mirafive("flag", "new-checkout", false)
  await page.until(() => page!.chunks.length)

  expect(page.chunks).toEqual(["flags"])
})

test("a snippet decision loads flags, and experiments in full mode, also when pushed after the loader", async () => {
  page = await open({
    attributes: full,
    before: `window.__mirafive_experiments = [${JSON.stringify(entry)}]`
  })
  await page.until(() => page!.chunks.length === 2)

  expect(page.chunks.toSorted()).toEqual(["experiments", "flags"])
  expect(page.mirafive("flag", "hero-copy", "a")).toBe("b")
  await page.close()

  page = await open({ attributes: full })
  await settle()
  expect(page.chunks).toEqual([])
  ;(page.window["__mirafive_experiments"] as unknown[]).push(entry)
  await page.until(() => page!.chunks.length === 2)

  expect(page.chunks.toSorted()).toEqual(["experiments", "flags"])
  await page.close()

  page = await open({ before: `window.__mirafive_experiments = [${JSON.stringify(entry)}]` })
  await page.until(() => page!.chunks.length)
  await settle()

  expect(page.chunks).toEqual(["flags"])
})

test("chunks load from beside the loader with SRI and crossorigin=anonymous", async () => {
  const base = "https://shop.example/assets/mirafive/"

  page = await open({ base, attributes: { "data-flags": "", "data-autocapture": "" } })
  await page.until(() => page!.chunks.length === 2)

  const scripts = page.scripts().filter((script) => script.src.includes("/chunks/"))

  expect(scripts.map((script) => [script.src, script.integrity, script.crossOrigin])).toEqual(
    ["autocapture", "flags"].map((name) => [
      base + manifest.chunks[name]!.file,
      manifest.chunks[name]!.integrity,
      "anonymous"
    ])
  )
})

test("the manifest describes the files: sha256 chunks, sha384 pinned loader identical to mira.js", () => {
  const loader = readFileSync("dist/mira.js", "utf8")

  expect(readFileSync("dist/" + manifest.loader.file, "utf8")).toBe(loader)
  expect(manifest.loader.integrity).toBe(sri(manifest.loader.file, "sha384"))
  expect(Object.keys(manifest.chunks)).toEqual(["identity", "flags", "experiments", "search", "autocapture"])

  for (const chunk of Object.values(manifest.chunks)) {
    const digest = chunk.integrity.slice("sha256-".length)

    expect(chunk.integrity).toBe(sri(chunk.file, "sha256"))
    // The loader derives the file name from the digest it carries.
    expect(chunk.file).toMatch(/^chunks\/[a-z]+\.[\w-]{8}\.js$/)
    expect(chunk.file.split(".")[1]).toBe(Buffer.from(digest, "base64").toString("base64url").slice(0, 8))
    expect(loader).toContain(digest)
  }
})

test("every chunk registers through the private callback and nothing else", async () => {
  page = await open()

  const registered: string[] = []

  page.window["__mirafive_chunk"] = (name: string) => void registered.push(name)

  for (const chunk of Object.values(manifest.chunks)) {
    page.window.eval(readFileSync("dist/" + chunk.file, "utf8"))
  }

  expect(registered).toEqual(Object.keys(manifest.chunks))
})
