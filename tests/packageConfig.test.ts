import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

type PackageJson = {
  scripts?: Record<string, string>;
  build?: {
    electronDist?: string;
    extraResources?: Array<{
      from?: string;
      to?: string;
      filter?: string[];
    }>;
    files?: string[];
    mac?: {
      icon?: string;
      target?: string[];
      identity?: string | null;
    };
  };
  devDependencies?: Record<string, string>;
};

describe("package config", () => {
  it("defines a local macOS dmg package that includes first-launch setup assets", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as PackageJson;

    expect(packageJson.scripts?.["package:dmg"]).toBe("npm run build && tsx scripts/package-dmg.ts");
    expect(packageJson.devDependencies).toHaveProperty("electron-builder");
    expect(packageJson.build?.electronDist).toBe("node_modules/electron/dist");
    expect(packageJson.build?.mac?.target).toContain("dmg");
    expect(packageJson.build?.mac?.icon).toBe("build/icon.icns");
    expect(packageJson.build?.mac?.identity).toBe("-");
    expect(packageJson.build?.files).toEqual(
      expect.arrayContaining([
        "dist-electron/**/*",
        "dist-renderer/**/*",
        "package.json"
      ])
    );
    expect(packageJson.build?.extraResources).toEqual(
      expect.arrayContaining([
        { from: "hooks", to: "hooks", filter: ["claude-pet-hook.js"] },
        { from: "pets", to: "pets", filter: ["**/*"] }
      ])
    );
  });

  it("preserves Electron framework symlinks when staging the dmg app", async () => {
    const packageDmgScript = await readFile(path.join(process.cwd(), "scripts", "package-dmg.ts"), "utf8");

    expect(packageDmgScript).toContain("verbatimSymlinks: true");
  });
});
