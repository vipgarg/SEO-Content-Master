import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["dotenv/config"],
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
