import type { Plugin } from "@mirafive/sdk-browser"

export type Feature = "identity" | "autocapture" | "search" | "flags" | "experiments"

export type Factory = (options?: never) => Plugin

/** The private handshake: a chunk hands its plugin factory to the loader that requested it. */
export type Register = (feature: Feature, factory: Factory) => void

export interface TrackerGlobals {
  mirafive?: ((...args: unknown[]) => unknown) & { q?: ArrayLike<unknown>[] }
  __mirafive_chunk?: Register
  __mirafive_boot?: unknown
  __mirafive_consent?: unknown
  __mirafive_experiments?: unknown[]
}
