import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "/tmp/Claude Pets.app/Contents/Resources/app.asar",
    whenReady: () => new Promise<void>(() => undefined),
    on: () => undefined,
    isReady: () => false,
    exit: () => undefined
  },
  BrowserWindow: {
    getAllWindows: () => []
  },
  ipcMain: {
    handle: () => undefined
  },
  net: {
    fetch: () => Promise.resolve(new Response("Not found", { status: 404 }))
  },
  protocol: {
    handle: () => undefined,
    registerSchemesAsPrivileged: () => undefined
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } })
  }
}));

import {
  claudeHookFlag,
  createPackagedHookCommand,
  isClaudeHookMode,
  runPackagedFirstLaunchSetup
} from "../electron/main";

describe("Electron first-launch setup", () => {
  it("skips source startup setup and configures packaged startup with the app executable hook", async () => {
    const runSetup = vi.fn().mockResolvedValue({
      changed: true,
      installedPets: ["mianmian"],
      skippedPets: []
    });
    const execPath = "/Applications/Claude Pets.app/Contents/MacOS/Claude Pets";

    await expect(
      runPackagedFirstLaunchSetup({
        isPackaged: false,
        resourcesPath: "/repo",
        execPath,
        runSetup
      })
    ).resolves.toEqual({ status: "skipped" });
    expect(runSetup).not.toHaveBeenCalled();

    await expect(
      runPackagedFirstLaunchSetup({
        isPackaged: true,
        resourcesPath: "/Applications/Claude Pets.app/Contents/Resources",
        execPath,
        runSetup
      })
    ).resolves.toEqual({
      status: "completed",
      changed: true,
      installedPets: ["mianmian"],
      skippedPets: []
    });
    expect(runSetup).toHaveBeenCalledTimes(1);
    expect(runSetup).toHaveBeenCalledWith({
      repositoryRoot: "/Applications/Claude Pets.app/Contents/Resources",
      hookCommand: `/usr/bin/env ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(execPath)} "/Applications/Claude Pets.app/Contents/Resources/hooks/claude-pet-hook.js"`,
      skipNodeVersionCheck: true
    });
  });

  it("returns a typed setup error instead of rejecting packaged boot", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        runPackagedFirstLaunchSetup({
          isPackaged: true,
          resourcesPath: "/app/Contents/Resources",
          execPath: "/app",
          runSetup: () => Promise.reject(new Error("settings are not writable"))
        })
      ).resolves.toEqual({
        status: "failed",
        message: "settings are not writable"
      });
      expect(consoleError).toHaveBeenCalledWith("Claude Pets first-launch setup failed: settings are not writable");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("formats a Node-mode hook command that runs the external bundled hook script", () => {
    expect(isClaudeHookMode(["/app", claudeHookFlag])).toBe(true);
    expect(isClaudeHookMode(["/app"])).toBe(false);
    expect(
      createPackagedHookCommand(
        "/Applications/Claude Pets.app/Contents/MacOS/Claude Pets",
        "/Applications/Claude Pets.app/Contents/Resources"
      )
    ).toBe(
      `/usr/bin/env ELECTRON_RUN_AS_NODE=1 "/Applications/Claude Pets.app/Contents/MacOS/Claude Pets" "/Applications/Claude Pets.app/Contents/Resources/hooks/claude-pet-hook.js"`
    );
  });
});
