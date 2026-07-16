import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every package keeps its tests in `tests/`. No globals — suites import from "vitest"
    // explicitly, so the pure library never depends on an ambient test type.
    include: ["packages/*/tests/**/*.test.{ts,tsx}"],
    // The engine tests spin up REAL node:http servers that lie on demand; give them room.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
