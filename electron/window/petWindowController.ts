import type { BrowserWindow } from "electron";

export type PetWindowLike = Pick<BrowserWindow, "hide" | "isDestroyed" | "once" | "setIgnoreMouseEvents" | "showInactive">;

export function createPetWindowController(
  createWindow: () => Promise<PetWindowLike>,
  resetPointerInteractivity: (window: PetWindowLike) => void = () => undefined
) {
  let petWindow: PetWindowLike | null = null;
  let petWindowCreation: Promise<PetWindowLike> | null = null;
  let shouldShowPetWindow = true;

  async function showPetWindow(): Promise<void> {
    shouldShowPetWindow = true;

    if (petWindow && !petWindow.isDestroyed()) {
      resetPointerInteractivity(petWindow);
      petWindow.showInactive();
      return;
    }

    petWindowCreation ??= createWindow().finally(() => {
      petWindowCreation = null;
    });
    const window = await petWindowCreation;
    if (window.isDestroyed()) {
      return;
    }

    petWindow = window;
    resetPointerInteractivity(window);
    if (shouldShowPetWindow) {
      window.showInactive();
    } else {
      window.hide();
    }
    window.once("closed", () => {
      if (petWindow === window) {
        petWindow = null;
      }
    });
  }

  function closePetWindow(): void {
    shouldShowPetWindow = false;

    if (petWindow && !petWindow.isDestroyed()) {
      resetPointerInteractivity(petWindow);
      petWindow.hide();
    }
  }

  return {
    showPetWindow,
    closePetWindow
  };
}
