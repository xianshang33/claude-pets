import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const selectionFileName = "selection.json";

type SelectionFile = {
  selectedPetId?: unknown;
};

export function getDefaultAppDataDirectory(homeDir = os.homedir()): string {
  return path.join(homeDir, "Library", "Application Support", "Claude Pets");
}

export async function loadSelectedPetId(appDataDir = getDefaultAppDataDirectory()): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(path.join(appDataDir, selectionFileName), "utf8")) as SelectionFile;
    return typeof data.selectedPetId === "string" && data.selectedPetId.length > 0
      ? data.selectedPetId
      : null;
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function saveSelectedPetId(
  appDataDir = getDefaultAppDataDirectory(),
  selectedPetId: string
): Promise<void> {
  await mkdir(appDataDir, { recursive: true });
  await writeFile(
    path.join(appDataDir, selectionFileName),
    `${JSON.stringify({ selectedPetId }, null, 2)}\n`,
    "utf8"
  );
}
