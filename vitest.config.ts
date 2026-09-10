import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Live-fire tests talk to Neon, Lithic and Increase over the network, in
    // sequence, under a 1 RPS simulate cap. 5s is the vitest default and it was
    // failing three attacks with 'Test timed out in 5000ms' and nothing else -
    // a red suite that said nothing about the system under test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "src/**/__tests__/**/*.{test,spec}.ts"],
    reporters: ["default"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // TEST ONLY. See test/server-only-stub.ts for why this is safe.
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
    },
  },
});
