import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const source =
  process.env.OARLOCK_PROFILE_SOURCE_ROOT ?? path.resolve(root, "../..");
export default defineConfig({
  root,
  resolve: {
    alias: [
      { find: "@", replacement: path.join(source, "src") },
      {
        find: "@oarlock/ghostty-core/adapted",
        replacement: path.join(
          source,
          "packages/ghostty-core/lib/adapted/index.ts",
        ),
      },
      {
        find: "@oarlock/ghostty-core/protocol",
        replacement: path.join(source, "packages/ghostty-core/lib/protocol.ts"),
      },
    ],
  },
  build: {
    target: "es2022",
    outDir: process.env.OARLOCK_RENDERER_DIST ?? path.join(root, "dist"),
    emptyOutDir: true,
  },
});
