import type { Factory, Feature, TrackerGlobals } from "./types.ts"

export const register = (feature: Feature, factory: Factory): void =>
  (window as Window & TrackerGlobals).__mirafive_chunk?.(feature, factory)
