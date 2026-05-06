import { contextBridge, ipcRenderer } from "electron";
import type {
  ClaudeBridgeStatus,
  ClaudePetOverlayBounds,
  ClaudePetApi,
  InitialState,
  NormalizedClaudeEvent,
  NormalizedPermissionRequest,
  OpenEventContextResult
} from "./types";

type IpcInvoker = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void;
  removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => void;
};

export function createPreloadApi(ipc: IpcInvoker): ClaudePetApi {
  return {
    getInitialState: () => ipc.invoke("app:getInitialState") as Promise<InitialState>,
    reloadPets: () => ipc.invoke("app:reloadPets") as Promise<InitialState>,
    selectPet: (petId) => ipc.invoke("app:selectPet", petId) as Promise<InitialState>,
    openPetsDirectory: () => ipc.invoke("app:openPetsDirectory") as Promise<void>,
    closePet: () => ipc.invoke("app:closePet") as Promise<void>,
    getBridgeStatus: () => ipc.invoke("bridge:getStatus") as Promise<ClaudeBridgeStatus>,
    onStateChanged: (handler) => {
      const listener = (_event: unknown, payload: unknown) => {
        handler(payload as InitialState | undefined);
      };
      ipc.on("app:stateChanged", listener);
      return () => ipc.removeListener("app:stateChanged", listener);
    },
    onClaudeEvent: (handler) => {
      const listener = (_event: unknown, payload: unknown) => {
        handler(payload as NormalizedClaudeEvent);
      };
      ipc.on("bridge:claudeEvent", listener);
      return () => ipc.removeListener("bridge:claudeEvent", listener);
    },
    onPermissionRequest: (handler) => {
      const listener = (_event: unknown, payload: unknown) => {
        handler(payload as NormalizedPermissionRequest);
      };
      ipc.on("bridge:permissionRequest", listener);
      return () => ipc.removeListener("bridge:permissionRequest", listener);
    },
    submitPermissionDecision: (requestId, behavior) =>
      ipc.invoke("bridge:submitPermissionDecision", requestId, behavior) as Promise<boolean>,
    openEventContext: (event) => ipc.invoke("app:openEventContext", event) as Promise<OpenEventContextResult>,
    moveWindowBy: (deltaX, deltaY) => ipc.invoke("app:moveWindowBy", deltaX, deltaY) as Promise<void>,
    setOverlayContentBounds: (bounds: ClaudePetOverlayBounds) =>
      ipc.invoke("app:setOverlayContentBounds", bounds) as Promise<void>,
    setDragAnchorBounds: (bounds: ClaudePetOverlayBounds) => ipc.invoke("app:setDragAnchorBounds", bounds) as Promise<void>,
    setPointerInteractivity: (isInteractive) =>
      ipc.invoke("app:setPointerInteractivity", isInteractive) as Promise<void>,
    quit: () => ipc.invoke("app:quit") as Promise<void>
  };
}

if (contextBridge?.exposeInMainWorld) {
  contextBridge.exposeInMainWorld("claudePet", createPreloadApi(ipcRenderer));
}
