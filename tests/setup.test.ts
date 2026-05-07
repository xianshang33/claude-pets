import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudePetHookEvents,
  createHookCommand,
  installBundledPets,
  installClaudePetHooks,
  isSupportedNodeMajor,
  runSetup
} from "../scripts/setup";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("source setup", () => {
  it("supports Node 22 and newer source runtimes", () => {
    expect(isSupportedNodeMajor(20)).toBe(false);
    expect(isSupportedNodeMajor(22)).toBe(true);
    expect(isSupportedNodeMajor(24)).toBe(true);
  });

  it("adds Claude Pets hooks without removing unrelated settings", () => {
    const command = createHookCommand("/repo/claude-pet");

    const result = installClaudePetHooks(
      {
        theme: "dark",
        hooks: {
          Notification: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "node /other/hook.js" }]
            }
          ]
        }
      },
      command
    );

    expect(result.changed).toBe(true);
    expect(result.settings.theme).toBe("dark");
    const hooks = result.settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.Notification).toHaveLength(2);
    for (const eventName of claudePetHookEvents) {
      expect(hooks[eventName].some((entry) => entry.hooks.some((hook) => hook.command === command))).toBe(true);
    }
  });

  it("does not duplicate an already-installed hook command", () => {
    const command = createHookCommand("/repo/claude-pet");
    const once = installClaudePetHooks({}, command);
    const twice = installClaudePetHooks(once.settings, command);

    expect(twice.changed).toBe(false);
    const hooks = twice.settings.hooks as Record<string, unknown[]>;
    for (const eventName of claudePetHookEvents) {
      expect(hooks[eventName]).toHaveLength(1);
    }
  });

  it("updates existing Claude Pets hook commands instead of adding duplicates", () => {
    const packagedCommand = "\"/Applications/Claude Pets.app/Contents/MacOS/Claude Pets\" --claude-hook";
    const result = installClaudePetHooks(
      {
        hooks: {
          PermissionRequest: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "node /repo/claude-pet/hooks/claude-pet-hook.js" }]
            }
          ]
        }
      },
      packagedCommand
    );

    expect(result.changed).toBe(true);
    const hooks = result.settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.PermissionRequest).toHaveLength(1);
    expect(hooks.PermissionRequest[0]?.hooks).toEqual([{ type: "command", command: packagedCommand }]);
  });

  it("treats quoted and unquoted hook paths as the same command", () => {
    const command = createHookCommand("/repo/claude-pet");
    const result = installClaudePetHooks(
      {
        hooks: {
          PreToolUse: [
            {
              hooks: [{ type: "command", command: "node /repo/claude-pet/hooks/claude-pet-hook.js" }]
            }
          ]
        }
      },
      command
    );

    const hooks = result.settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
  });

  it("writes settings and creates the pet directory", async () => {
    await withNodeVersion("22.0.0", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "claude-pet-setup-"));
      tempDirectories.push(directory);

      const result = await runSetup({ repositoryRoot: "/repo/claude-pet", claudeDirectory: directory });

      expect(result.changed).toBe(true);
      const settings = JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8")) as { hooks: Record<string, unknown[]> };
      expect(settings.hooks.PermissionRequest).toHaveLength(1);
      expect(result.hookCommand).toBe(createHookCommand("/repo/claude-pet"));
      expect(result.petsDirectory).toBe(path.join(directory, "pets"));
    });
  });

  it("rejects source setup on Node versions older than 22", async () => {
    await withNodeVersion("20.11.1", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "claude-pet-setup-"));
      tempDirectories.push(directory);
      const allowNonNode22 = process.env.CLAUDE_PET_SETUP_ALLOW_NON_NODE22;
      delete process.env.CLAUDE_PET_SETUP_ALLOW_NON_NODE22;

      try {
        await expect(runSetup({ repositoryRoot: "/repo/claude-pet", claudeDirectory: directory })).rejects.toThrow(
          "Claude Pets source setup requires Node 22 or newer"
        );
      } finally {
        if (allowNonNode22 === undefined) {
          delete process.env.CLAUDE_PET_SETUP_ALLOW_NON_NODE22;
        } else {
          process.env.CLAUDE_PET_SETUP_ALLOW_NON_NODE22 = allowNonNode22;
        }
      }
    });
  });

  it("uses a packaged hook command and can skip the source Node version gate", async () => {
    await withNodeVersion("20.11.1", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "claude-pet-setup-"));
      tempDirectories.push(directory);
      const hookCommand = "\"/Applications/Claude Pet.app/Contents/MacOS/Claude Pet\" --claude-hook";

      const result = await runSetup({
        repositoryRoot: "/repo/claude-pet",
        claudeDirectory: directory,
        hookCommand,
        skipNodeVersionCheck: true
      });

      expect(result.hookCommand).toBe(hookCommand);
      const settings = JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8")) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      expect(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toBe(hookCommand);
    });
  });

  it("skips existing bundled pet directories without overwriting them", async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "claude-pet-repo-"));
    const claudeDirectory = await mkdtemp(path.join(os.tmpdir(), "claude-pet-home-"));
    tempDirectories.push(repositoryRoot, claudeDirectory);
    const sourcePetDirectory = path.join(repositoryRoot, "pets", "moss");
    const targetPetDirectory = path.join(claudeDirectory, "pets", "moss");
    await mkdir(sourcePetDirectory, { recursive: true });
    await mkdir(targetPetDirectory, { recursive: true });
    await writeFile(path.join(sourcePetDirectory, "pet.json"), "{\"name\":\"bundled\"}\n");
    await writeFile(path.join(targetPetDirectory, "pet.json"), "{\"name\":\"existing\"}\n");

    const result = await installBundledPets(repositoryRoot, path.join(claudeDirectory, "pets"));

    expect(result).toEqual({ installedPets: [], skippedPets: ["moss"] });
    await expect(readFile(path.join(targetPetDirectory, "pet.json"), "utf8")).resolves.toBe("{\"name\":\"existing\"}\n");
  });
});

async function withNodeVersion<T>(nodeVersion: string, callback: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
  Object.defineProperty(process.versions, "node", {
    configurable: true,
    enumerable: true,
    value: nodeVersion
  });

  try {
    return await callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(process.versions, "node", descriptor);
    }
  }
}
