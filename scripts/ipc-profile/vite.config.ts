import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root,
  resolve: { alias: { "@": path.resolve(root, "../../src") } },
  define: {
    __OARLOCK_IPC_BASE_URL__: JSON.stringify(process.env.OARLOCK_IPC_BASE_URL),
    __OARLOCK_IPC_TREE__: JSON.stringify(process.env.OARLOCK_IPC_TREE),
  },
  build: {
    target: "es2022",
    outDir: process.env.OARLOCK_IPC_DIST,
    emptyOutDir: true,
  },
});
