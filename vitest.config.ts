import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // src/db/typeParsers.ts must run before any test's first pg query —
    // several test files create their own `new Pool()` rather than
    // going through src/db/pool.ts, and pg's type-parser registry is
    // global (shared across every Pool instance in the process), so
    // registering it once here covers all of them.
    setupFiles: ["dotenv/config", "./src/db/typeParsers.ts"],
    testTimeout: 10_000,
    // These tests share one real Postgres and one real Redis instance
    // (deliberately — see README) rather than mocking either. Running
    // test files in parallel workers means their timing-sensitive
    // assertions (token bucket windows, BullMQ job processing latency)
    // compete for the same DB/Redis round-trip time, which showed up
    // as an occasional flake under full-suite load that never happened
    // running a file alone. Serializing removes the contention instead
    // of just padding timeouts to paper over it.
    fileParallelism: false,
  },
});
