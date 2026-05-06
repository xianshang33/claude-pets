import { spawn } from "node:child_process";
import path from "node:path";
import { build } from "esbuild";
import waitOn from "wait-on";

const root = process.cwd();
const viteUrl = "http://127.0.0.1:5173";
const electronBin = path.join(root, "node_modules", ".bin", "electron");

async function buildElectron() {
  await Promise.all([
    build({
      entryPoints: [path.join(root, "electron/main.ts")],
      outfile: path.join(root, "dist-electron/main.cjs"),
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      sourcemap: true,
      external: ["electron"]
    }),
    build({
      entryPoints: [path.join(root, "electron/preload.ts")],
      outfile: path.join(root, "dist-electron/preload.cjs"),
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      sourcemap: true,
      external: ["electron"]
    })
  ]);
}

async function main() {
  await buildElectron();

  const vite = spawn("npm", ["exec", "vite", "--", "--host", "127.0.0.1"], {
    cwd: root,
    stdio: "inherit"
  });

  await waitOn({ resources: [viteUrl], timeout: 30_000 });

  const electron = spawn(electronBin, ["."], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: viteUrl
    }
  });

  function shutdown(code = 0) {
    vite.kill();
    electron.kill();
    process.exit(code);
  }

  electron.on("exit", (code) => shutdown(code ?? 0));
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

void main();
