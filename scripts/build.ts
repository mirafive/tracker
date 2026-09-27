/**
 * Builds the hosted script: each feature chunk first (content-hashed, SRI computed), then the loader
 * with those names and hashes baked in, its pinned copy and the manifest.
 *
 *   bun scripts/build.ts
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { gzipSync } from "node:zlib"

import { rolldown } from "rolldown"

import type { Feature } from "../src/types.ts"

// The loader's order; its chunk table is positional.
const features: Feature[] = ["identity", "flags", "experiments", "search", "autocapture"]
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string }

interface Built {
  file: string
  integrity: string
  bytes: number
  gzip: number
}

const bundle = async (input: string, define: Record<string, string> = {}): Promise<string> => {
  const build = await rolldown({ input, platform: "browser", transform: { target: "es2020", define } })
  const { output } = await build.generate({ format: "iife", minify: true, comments: false })

  await build.close()

  const code = output[0].code

  // The loader is promised as ES2020; a newer operator slipping through the transform breaks older Safari.
  if (/\?\?=|\|\|=|&&=/.test(code)) {
    throw new Error(`${input}: output is newer than ES2020`)
  }

  return code
}

const write = (name: string, code: string, algorithm = "sha384"): Built => {
  // The name carries the first 8 characters of the sha256 digest, base64url: the loader derives it.
  const hash = createHash("sha256").update(code).digest("base64url").slice(0, 8)
  const file = `${name}.${hash}.js`

  writeFileSync(`dist/${file}`, code)

  return {
    file,
    integrity: `${algorithm}-${createHash(algorithm).update(code).digest("base64")}`,
    bytes: Buffer.byteLength(code),
    gzip: gzipSync(code, { level: 9 }).length
  }
}

rmSync("dist", { recursive: true, force: true })
mkdirSync("dist/chunks", { recursive: true })

const chunks = {} as Record<Feature, Built>

for (const feature of features) {
  // sha256 for chunks: their digests sit in the loader, where every byte is incompressible.
  const built = write(`chunks/${feature}`, await bundle(`src/chunks/${feature}.ts`), "sha256")

  chunks[feature] = { ...built, file: built.file.slice("chunks/".length) }
}

const loader = await bundle("src/loader.ts", {
  __CHUNKS__: JSON.stringify(
    features.map((feature) => chunks[feature].integrity.slice("sha256-".length)).join(" ")
  ),
  __VERSION__: JSON.stringify(version)
})

writeFileSync("dist/mira.js", loader)

const pinned = write("mira", loader)
const manifest = {
  version,
  loader: { file: pinned.file, integrity: pinned.integrity },
  chunks: Object.fromEntries(
    features.map((feature) => [
      feature,
      { file: `chunks/${chunks[feature].file}`, integrity: chunks[feature].integrity }
    ])
  )
}

writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2) + "\n")

for (const [name, built] of [
  ["mira.js", pinned],
  ...features.map((feature) => [feature, chunks[feature]])
] as [string, Built][]) {
  console.log(
    `${name.padEnd(12)} ${String(built.bytes).padStart(6)} B  gzip ${String(built.gzip).padStart(5)} B`
  )
}
