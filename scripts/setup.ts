import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const claudePetHookEvents = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "PermissionRequest"
] as const;

type JsonRecord = Record<string, unknown>;

export type SetupResult = {
  settingsPath: string;
  petsDirectory: string;
  hookCommand: string;
  changed: boolean;
  configuredEvents: string[];
  nodeMajor: number;
  installedPets: string[];
  skippedPets: string[];
};

export type RunSetupOptions = {
  repositoryRoot?: string;
  claudeDirectory?: string;
  hookCommand?: string;
  skipNodeVersionCheck?: boolean;
};

export function createHookCommand(repositoryRoot: string): string {
  return `node ${JSON.stringify(path.join(repositoryRoot, "hooks", "claude-pet-hook.js"))}`;
}

export function isSupportedNodeMajor(nodeMajor: number): boolean {
  return nodeMajor >= 22;
}

export function installClaudePetHooks(settings: unknown, hookCommand: string): { settings: JsonRecord; changed: boolean } {
  const next = isRecord(settings) ? { ...settings } : {};
  const hooks = isRecord(next.hooks) ? { ...next.hooks } : {};
  let changed = !isRecord(next.hooks);

  for (const eventName of claudePetHookEvents) {
    const currentEntries = Array.isArray(hooks[eventName]) ? [...hooks[eventName]] : [];
    if (!Array.isArray(hooks[eventName])) {
      changed = true;
    }

    const { entries, found } = updateExistingClaudePetHookCommands(currentEntries, hookCommand);
    const nextEntries = [...entries];
    if (entries !== currentEntries) {
      changed = true;
    }

    if (!found) {
      nextEntries.push({
        matcher: "",
        hooks: [
          {
            type: "command",
            command: hookCommand
          }
        ]
      });
      changed = true;
    }

    hooks[eventName] = nextEntries;
  }

  next.hooks = hooks;
  return { settings: next, changed };
}

export async function runSetup(options: RunSetupOptions = {}): Promise<SetupResult> {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!options.skipNodeVersionCheck && !isSupportedNodeMajor(nodeMajor) && process.env.CLAUDE_PET_SETUP_ALLOW_NON_NODE22 !== "1") {
    throw new Error(`Claude Pets source setup requires Node 22 or newer. Current Node is ${process.versions.node}. Run: nvm use 22`);
  }

  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const claudeDirectory = options.claudeDirectory ?? path.join(os.homedir(), ".claude");
  const settingsPath = path.join(claudeDirectory, "settings.json");
  const petsDirectory = path.join(claudeDirectory, "pets");
  const hookCommand = options.hookCommand ?? createHookCommand(repositoryRoot);

  await mkdir(claudeDirectory, { recursive: true });
  await mkdir(petsDirectory, { recursive: true });
  const { installedPets, skippedPets } = await installBundledPets(repositoryRoot, petsDirectory);

  const existingSettings = await readSettings(settingsPath);
  const { settings, changed } = installClaudePetHooks(existingSettings, hookCommand);

  if (changed) {
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  return {
    settingsPath,
    petsDirectory,
    hookCommand,
    changed,
    configuredEvents: [...claudePetHookEvents],
    nodeMajor,
    installedPets,
    skippedPets
  };
}

export async function installBundledPets(repositoryRoot: string, petsDirectory: string): Promise<{ installedPets: string[]; skippedPets: string[] }> {
  const bundledPetsDirectory = path.join(repositoryRoot, "pets");
  const installedPets: string[] = [];
  const skippedPets: string[] = [];

  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(bundledPetsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { installedPets, skippedPets };
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const sourceDirectory = path.join(bundledPetsDirectory, entry.name);
    const targetDirectory = path.join(petsDirectory, entry.name);

    if (!(await fileExists(path.join(sourceDirectory, "pet.json")))) {
      continue;
    }

    if (await fileExists(targetDirectory)) {
      skippedPets.push(entry.name);
      continue;
    }

    await cp(sourceDirectory, targetDirectory, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (source) => path.basename(source) !== ".DS_Store"
    });
    installedPets.push(entry.name);
  }

  return { installedPets, skippedPets };
}

async function readSettings(settingsPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Could not parse ${settingsPath}. Fix the JSON syntax and rerun setup.`);
    }
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function containsHookCommand(entry: unknown, hookCommand: string): boolean {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
    return false;
  }

  return entry.hooks.some((hook) => {
    if (!isRecord(hook) || hook.type !== "command" || typeof hook.command !== "string") {
      return false;
    }
    return normalizeCommand(hook.command) === normalizeCommand(hookCommand);
  });
}

function updateExistingClaudePetHookCommands(entries: unknown[], hookCommand: string): { entries: unknown[]; found: boolean } {
  let found = false;
  let changed = false;
  const nextEntries = entries.map((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      return entry;
    }

    const nextHooks = entry.hooks.map((hook) => {
      if (!isRecord(hook) || hook.type !== "command" || typeof hook.command !== "string") {
        return hook;
      }

      if (normalizeCommand(hook.command) === normalizeCommand(hookCommand)) {
        found = true;
        return hook;
      }

      if (!isClaudePetHookCommand(hook.command)) {
        return hook;
      }

      found = true;
      changed = true;
      return {
        ...hook,
        command: hookCommand
      };
    });

    return nextHooks === entry.hooks
      ? entry
      : {
          ...entry,
          hooks: nextHooks
        };
  });

  return {
    entries: changed ? nextEntries : entries,
    found
  };
}

function isClaudePetHookCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  return normalized.includes("hooks/claude-pet-hook.js") || normalized.includes(` ${"--claude-hook"}`);
}

function normalizeCommand(command: string): string {
  return command.replaceAll("\\", "/").replace(/(["'])(.*?)\1/g, "$2").replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function main(): Promise<void> {
  const result = await runSetup();
  const status = result.changed ? "updated" : "already configured";
  console.log(`Claude Pets setup ${status}.`);
  console.log(`Settings: ${result.settingsPath}`);
  console.log(`Pet directory: ${result.petsDirectory}`);
  if (result.installedPets.length > 0) {
    console.log(`Installed bundled pets: ${result.installedPets.join(", ")}`);
  }
  if (result.skippedPets.length > 0) {
    console.log(`Already installed pets: ${result.skippedPets.join(", ")}`);
  }
  console.log(`Hook command: ${result.hookCommand}`);
  console.log(`Events: ${result.configuredEvents.join(", ")}`);
  console.log("Start with: npm start");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
