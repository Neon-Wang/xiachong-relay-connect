import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "index.ts",
    "setup-entry": "setup-entry.ts",
    internals: "internals.ts",
  },
  format: ["esm"],
  target: "node20",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
  external: ["openclaw", "openclaw/*"],
  minify: false,
  treeshake: true,
});
