import { app, BrowserWindow } from "electron";
import { createClaudeBridgeServer, parsePreferredBridgePort } from "./bridge/server";
import { createInitialState, selectPetById } from "./petsDirectory";
import type { InitialState } from "./types";
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

let initialState: InitialState | undefined;
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

registerPetAssetProtocolScheme();

async function reloadPets(): Promise<InitialState> {
  initialState = await createInitialState({ bridgeStatus: bridgeServer.getStatus() });
  return initialState;
}

async function reloadPetsAndNotify(): Promise<InitialState> {
  const state = await reloadPets();
  notifyStateChanged();
  return state;
}

async function selectPetAndNotify(petId: string): Promise<InitialState> {
  initialState = await selectPetById(petId, { bridgeStatus: bridgeServer.getStatus() });
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
  initialState = await createInitialState({ bridgeStatus: bridgeServer.getStatus() });
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
