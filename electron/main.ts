import path from "node:path";
import { app, BrowserWindow } from "electron";
import { runSetup, type RunSetupOptions, type SetupResult } from "../scripts/setup";
import { createClaudeBridgeServer, parsePreferredBridgePort } from "./bridge/server";
import { createInitialState, selectPetById } from "./petsDirectory";
import type { AppSetupStatus, InitialState } from "./types";
import { installApplicationMenu } from "./window/menu";
import { createPetWindowController } from "./window/petWindowController";
import {
  applyPointerInteractivity,
  createPetWindow,
  installPetAssetProtocol,
  installWindowIpc,
  registerPetAssetProtocolScheme,
  toRendererInitialState
} from "./window/petWindow";

export const claudeHookFlag = "--claude-hook";

type RunSetup = (options: RunSetupOptions) => Promise<SetupResult>;

export type PackagedFirstLaunchSetupOptions = {
  isPackaged: boolean;
  resourcesPath: string;
  execPath: string;
  runSetup: RunSetup;
};

let initialState: InitialState | undefined;
let setupStatus: AppSetupStatus = { status: "skipped" };
const petWindowController = createPetWindowController(
  () => createPetWindow(getPetWindowOptions()),
  (window) => applyPointerInteractivity(window as BrowserWindow, true, { forceCursorRefresh: true })
);
const bridgeServer = createClaudeBridgeServer({
  defaultPort: parsePreferredBridgePort(process.env.CLAUDE_PET_BRIDGE_PORT),
  onEvent: (event) => {
    syncBridgeState();
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("bridge:claudeEvent", event);
      window.webContents.send("bridge:statusChanged", bridgeServer.getStatus());
    }
  },
  onPermissionRequest: (request) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("bridge:permissionRequest", request);
    }
  }
});

export function isClaudeHookMode(argv = process.argv): boolean {
  return argv.includes(claudeHookFlag);
}

export function createPackagedHookCommand(execPath = process.execPath, resourcesPath = process.resourcesPath): string {
  return `/usr/bin/env ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(execPath)} ${JSON.stringify(path.join(resourcesPath, "hooks", "claude-pet-hook.js"))}`;
}

export async function runPackagedFirstLaunchSetup(options: PackagedFirstLaunchSetupOptions): Promise<AppSetupStatus> {
  if (!options.isPackaged) {
    return { status: "skipped" };
  }

  try {
    const result = await options.runSetup({
      repositoryRoot: options.resourcesPath,
      hookCommand: createPackagedHookCommand(options.execPath, options.resourcesPath),
      skipNodeVersionCheck: true
    });

    return {
      status: "completed",
      changed: result.changed,
      installedPets: result.installedPets,
      skippedPets: result.skippedPets
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Claude Pets first-launch setup failed: ${message}`);
    return {
      status: "failed",
      message
    };
  }
}

function withSetupStatus(state: InitialState): InitialState {
  return {
    ...state,
    setup: setupStatus
  };
}

async function reloadPets(): Promise<InitialState> {
  initialState = withSetupStatus(await createInitialState({ bridgeStatus: bridgeServer.getStatus() }));
  return initialState;
}

async function reloadPetsAndNotify(): Promise<InitialState> {
  const state = await reloadPets();
  notifyStateChanged();
  return state;
}

async function selectPetAndNotify(petId: string): Promise<InitialState> {
  initialState = withSetupStatus(await selectPetById(petId, { bridgeStatus: bridgeServer.getStatus() }));
  notifyStateChanged();
  return initialState;
}

function getState(): InitialState | undefined {
  return initialState;
}

function getPetWindowOptions() {
  return {
    getState,
    reloadPets: reloadPetsAndNotify,
    selectPet: selectPetAndNotify,
    showPet: petWindowController.showPetWindow,
    closePet: petWindowController.closePetWindow,
    getBridgeStatus: () => bridgeServer.getStatus(),
    submitPermissionDecision: (requestId: string, decision: Parameters<typeof bridgeServer.submitPermissionDecision>[1]) =>
      bridgeServer.submitPermissionDecision(requestId, decision)
  };
}

async function boot(): Promise<void> {
  setupStatus = await runPackagedFirstLaunchSetup({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    runSetup
  });
  initialState = withSetupStatus(await createInitialState({ bridgeStatus: bridgeServer.getStatus() }));
  await bridgeServer.start();
  syncBridgeState();
  installPetAssetProtocol({ getState });
  const petWindowOptions = getPetWindowOptions();
  installWindowIpc(petWindowOptions);
  installApplicationMenu(petWindowOptions);
  await petWindowController.showPetWindow();
}

function syncBridgeState(): void {
  if (!initialState) {
    return;
  }

  initialState = {
    ...initialState,
    bridge: bridgeServer.getStatus()
  };
}

function notifyStateChanged(): void {
  const rendererState = toRendererInitialState(initialState);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("app:stateChanged", rendererState);
  }
}

function startPetApp(): void {
  registerPetAssetProtocolScheme();

  app.whenReady().then(() => {
    void boot();
  });

  app.on("window-all-closed", () => {
    // Keep the bridge alive when the pet overlay is tucked away. Use the Quit menu item for true app exit.
  });

  app.on("activate", () => {
    if (app.isReady()) {
      void petWindowController.showPetWindow();
    }
  });
}

startPetApp();
