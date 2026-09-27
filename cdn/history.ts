// Copies the pinned loaders and chunks of every released version (from npm) into the site, so a
// pinned loader or an hour-old mira.js still finds the chunks it was built with.
import { spawnSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const site = process.argv[2] ?? "/site"
const registry = "https://registry.npmjs.org/@mirafive%2ftracker"

const copyRelease = async (version: string, tarballUrl: string): Promise<void> => {
  const work = await mkdtemp(join(tmpdir(), "tracker-"))
  const tarball = join(work, "package.tgz")

  await writeFile(tarball, new Uint8Array(await (await fetch(tarballUrl)).arrayBuffer()))
  if (spawnSync("tar", ["-xzf", tarball, "-C", work]).status !== 0) {
    throw new Error(`could not unpack ${version}`)
  }

  const from = join(work, "package", "dist")
  const [top, chunks] = await Promise.all([readdir(from), readdir(join(from, "chunks"))])
  const pinned = top.filter((name) => /^mira\.[A-Za-z0-9_-]{8}\.js$/.test(name))

  await Promise.all([
    ...pinned.map((name) => copyFile(join(from, name), join(site, name))),
    ...chunks.map((name) => copyFile(join(from, "chunks", name), join(site, "chunks", name)))
  ])
  await rm(work, { recursive: true, force: true })
  process.stdout.write(`${version}: ${pinned.length} loader, ${chunks.length} chunks\n`)
}

const response = await fetch(registry)
if (!response.ok) {
  throw new Error(`npm registry answered ${response.status}`)
}
const body: unknown = await response.json()
const versions: unknown =
  typeof body === "object" && body !== null && "versions" in body ? body.versions : undefined
if (typeof versions !== "object" || versions === null) {
  throw new Error("npm registry answered without versions")
}

const tarballOf = (manifest: unknown): string => {
  const dist: unknown =
    typeof manifest === "object" && manifest !== null && "dist" in manifest ? manifest.dist : null
  const url: unknown = typeof dist === "object" && dist !== null && "tarball" in dist ? dist.tarball : null
  if (typeof url !== "string") {
    throw new Error("a release without a tarball")
  }
  return url
}

await mkdir(join(site, "chunks"), { recursive: true })
await Promise.all(
  Object.entries(versions)
    .filter(([version]) => Number(version.split(".")[0]) >= 1)
    .map(([version, manifest]) => copyRelease(version, tarballOf(manifest)))
)
