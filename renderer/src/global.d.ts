import type { ClaudePetApi } from "../../electron/types";

declare global {
  interface Window {
    claudePet: ClaudePetApi;
  }
}

export {};
