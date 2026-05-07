import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClaudeBridgeStatus, InitialState } from "./types";
import { scanPetPackages } from "./petPackageLoader";
import { getDefaultAppDataDirectory, loadSelectedPetId, saveSelectedPetId } from "./petSelectionStore";

const defaultBundledPetId = "mianmian";

export type CreateInitialStateOptions = {
  homeDir?: string;
  appDataDir?: string;
  bridgeStatus?: ClaudeBridgeStatus;
};

export function getPetsDirectory(homeDir = os.homedir()): string {
  return path.join(homeDir, ".claude", "pets");
}

export async function createInitialState(options: CreateInitialStateOptions = {}): Promise<InitialState> {
  const homeDir = options.homeDir ?? os.homedir();
  const appDataDir = options.appDataDir ?? getDefaultAppDataDirectory(homeDir);
  const petsDirectory = getPetsDirectory(homeDir);
  await mkdir(petsDirectory, { recursive: true });

  const { pets, warnings } = await scanPetPackages(petsDirectory);
  const selectedPetId = await loadSelectedPetId(appDataDir);
  const selectedPet =
    pets.find((pet) => pet.id === selectedPetId) ?? pets.find((pet) => pet.id === defaultBundledPetId) ?? pets[0] ?? null;

  if (selectedPet && selectedPet.id !== selectedPetId) {
    await saveSelectedPetId(appDataDir, selectedPet.id);
  }

  return {
    petsDirectory,
    petsDirectoryReady: true,
    petCount: pets.length,
    hasPets: pets.length > 0,
    pets,
    selectedPet,
    warnings,
    bridge: options.bridgeStatus ?? {
      listening: false,
      host: "127.0.0.1",
      port: 38987,
      url: "http://127.0.0.1:38987",
      latestEvent: null
    }
  };
}

export async function selectPetById(petId: string, options: CreateInitialStateOptions = {}): Promise<InitialState> {
  const homeDir = options.homeDir ?? os.homedir();
  const appDataDir = options.appDataDir ?? getDefaultAppDataDirectory(homeDir);
  const state = await createInitialState({ ...options, homeDir, appDataDir });

  if (!state.pets.some((pet) => pet.id === petId)) {
    return state;
  }

  await saveSelectedPetId(appDataDir, petId);
  return createInitialState({ ...options, homeDir, appDataDir });
}
