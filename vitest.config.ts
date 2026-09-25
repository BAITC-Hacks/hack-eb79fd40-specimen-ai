import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  oxc: {
    jsx: { runtime: "automatic" },
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // The full suite includes CPU-heavy PDF/eval work and shell harnesses that
    // fan out subprocesses. Bounding file workers prevents scheduler pressure
    // from exhausting the existing 5 s per-test hang detector.
    maxWorkers: 2,
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["lib/**"],
      reporter: ["text", "json-summary"],
    },
  },
});
