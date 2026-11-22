import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vivahlens/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@vivahlens/ingest": fileURLToPath(new URL("./packages/ingest/src/index.ts", import.meta.url)),
      "@vivahlens/delivery": fileURLToPath(new URL("./packages/delivery/src/index.ts", import.meta.url)),
      "@vivahlens/review": fileURLToPath(new URL("./packages/review/src/index.ts", import.meta.url)),
      "@vivahlens/adapter-lightroom": fileURLToPath(new URL("./packages/lightroom/src/index.ts", import.meta.url)),
      "@vivahlens/testkit": fileURLToPath(new URL("./packages/testkit/src/index.ts", import.meta.url)),
      "@vivahlens/video": fileURLToPath(new URL("./packages/video/src/index.ts", import.meta.url)),
      "@vivahlens/cloud-api": fileURLToPath(new URL("./packages/cloud-api/src/index.ts", import.meta.url)),
      "@vivahlens/adapter-xmp": fileURLToPath(new URL("./packages/adapter-xmp/src/index.ts", import.meta.url)),
      "@vivahlens/adapter-rawtherapee": fileURLToPath(new URL("./packages/adapter-rawtherapee/src/index.ts", import.meta.url)),
      "@vivahlens/adapter-darktable": fileURLToPath(new URL("./packages/adapter-darktable/src/index.ts", import.meta.url)),
      "@vivahlens/render": fileURLToPath(new URL("./packages/render/src/index.ts", import.meta.url)),
    },
  },
  // Several tests drive the real Windows ACL and DPAPI tools (about 0.1-0.6 s per call), which a loaded machine can stretch past the 5 s default.
  test: { include: ["packages/*/src/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
