import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vivahlens/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@vivahlens/ingest": fileURLToPath(new URL("./packages/ingest/src/index.ts", import.meta.url)),
      "@vivahlens/review": fileURLToPath(new URL("./packages/review/src/index.ts", import.meta.url)),
      "@vivahlens/adapter-lightroom": fileURLToPath(new URL("./packages/lightroom/src/index.ts", import.meta.url)),
      "@vivahlens/testkit": fileURLToPath(new URL("./packages/testkit/src/index.ts", import.meta.url)),
      "@vivahlens/adapter-xmp": fileURLToPath(new URL("./packages/adapter-xmp/src/index.ts", import.meta.url)),
      "@vivahlens/adapter-rawtherapee": fileURLToPath(new URL("./packages/adapter-rawtherapee/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["packages/*/src/**/*.test.ts"] },
});
