import { build } from "esbuild";
import path from "node:path";

const root = process.cwd();
const shared = {
  bundle: true,
  platform: "node" as const,
  target: "node20",
  format: "cjs" as const,
  sourcemap: true,
  external: ["electron"]
};

async function main() {
  await Promise.all([
    build({
      ...shared,
      entryPoints: [path.join(root, "electron/main.ts")],
      outfile: path.join(root, "dist-electron/main.cjs")
    }),
    build({
      ...shared,
      entryPoints: [path.join(root, "electron/preload.ts")],
      outfile: path.join(root, "dist-electron/preload.cjs")
    })
  ]);
}

void main();
