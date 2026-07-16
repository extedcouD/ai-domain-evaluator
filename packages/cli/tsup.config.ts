import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2023",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  external: [
    "@evaluator/core",
    "@evaluator/provider-openai",
    "@evaluator/provider-anthropic",
    "@evaluator/reporter",
    "@evaluator/studio",
  ],
});
