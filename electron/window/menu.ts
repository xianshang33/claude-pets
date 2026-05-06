import { app, Menu, shell } from "electron";
import type { InitialState } from "../types";

type MenuActions = {
  getState: () => InitialState | undefined;
  reloadPets: () => Promise<InitialState>;
  selectPet: (petId: string) => Promise<InitialState>;
  showPet: () => Promise<void>;
  closePet: () => void;
};

export function installApplicationMenu(actions: MenuActions): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Claude Pets",
      submenu: [
        {
          label: "Wake Pet",
          click: () => {
            void actions.showPet();
          }
        },
        {
          label: "Close Pet",
          click: () => actions.closePet()
        },
        {
          label: "Reload Pets",
          accelerator: "CommandOrControl+R",
          click: () => {
            void actions.reloadPets();
          }
        },
        {
          label: "Open ~/.claude/pets",
          click: () => {
            const state = actions.getState();
            if (state) {
              void shell.openPath(state.petsDirectory);
            }
          }
        },
        { type: "separator" },
        {
          label: "Quit Claude Pets",
          accelerator: "CommandOrControl+Q",
          click: () => app.quit()
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
