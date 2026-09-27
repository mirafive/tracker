import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Every test opens its own happy-dom Window and runs the built dist/ files in it.
    include: ["test/**/*.test.ts"]
  }
})
