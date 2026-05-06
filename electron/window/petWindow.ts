import { app, BrowserWindow, ipcMain, net, protocol, screen, shell } from "electron";
import type { BrowserWindowConstructorOptions, Rectangle } from "electron";
import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ClaudeBridgeStatus,
  ClaudePermissionDecision,
  ClaudePetOverlayBounds,
  InitialState,
  OpenEventContextResult
} from "../types";

const electronDistDir = __dirname;
const maxWindowDelta = 128;
const overlayWindowMargin = 24;
const maxOverlayWindowWidth = 420;
const maxOverlayWindowHeight = 520;
const minOverlayWindowWidth = 136;
const minOverlayWindowHeight = 144;
export const petAssetProtocol = "claude-pet-asset";
const spritesheetAssetHost = "spritesheet";

type PetWindowRuntime = {
  dragAnchorBounds: Rectangle | null;
  mousePassthroughEnabled: boolean;
};

const petWindowRuntime = new WeakMap<BrowserWindow, PetWindowRuntime>();

type PetWindowOptions = {
  getState: () => InitialState | undefined;
  reloadPets: () => Promise<InitialState>;
  selectPet: (petId: string) => Promise<InitialState>;
  showPet: () => Promise<void>;
  closePet: () => void;
  getBridgeStatus?: () => ClaudeBridgeStatus;
  submitPermissionDecision?: (requestId: string, decision: ClaudePermissionDecision) => boolean;
};

export function createPetWindowWebPreferences(preload: string): BrowserWindowConstructorOptions["webPreferences"] {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  };
}

export function createPetWindowBrowserWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    width: 360,
    height: 430,
    minWidth: minOverlayWindowWidth,
    minHeight: minOverlayWindowHeight,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    skipTaskbar: true,
    title: "Claude Pets",
    backgroundColor: "#00000000",
    trafficLightPosition: { x: -100, y: -100 },
    webPreferences: createPetWindowWebPreferences(preload)
  };
}

export function createSpritesheetAssetUrl(absoluteSpritesheetPath: string): string {
  return `${petAssetProtocol}://${spritesheetAssetHost}/${encodeURIComponent(absoluteSpritesheetPath)}`;
}

export function normalizeWindowDelta(delta: unknown): number | null {
  if (typeof delta !== "number" || !Number.isFinite(delta)) {
    return null;
  }

  return Math.max(-maxWindowDelta, Math.min(maxWindowDelta, delta));
}

export function normalizeOverlayContentBounds(value: unknown): ClaudePetOverlayBounds | null {
  if (!isRecord(value)) {
    return null;
  }

  const left = normalizeFiniteNumber(value.left);
  const top = normalizeFiniteNumber(value.top);
  const width = normalizePositiveNumber(value.width);
  const height = normalizePositiveNumber(value.height);
  if (left === null || top === null || width === null || height === null) {
    return null;
  }

  return {
    left,
    top,
    width,
    height,
    minimumWindowWidth: normalizeOptionalPositiveNumber(value.minimumWindowWidth),
    minimumWindowHeight: normalizeOptionalPositiveNumber(value.minimumWindowHeight)
  };
}

export function getOverlayContentWindowBounds(
  currentBounds: Rectangle,
  contentBounds: ClaudePetOverlayBounds,
  options: { preserveWindowTop?: boolean } = {}
): Rectangle {
  const width = clamp(
    Math.ceil(Math.max(contentBounds.width + overlayWindowMargin * 2, contentBounds.minimumWindowWidth ?? 0)),
    minOverlayWindowWidth,
    maxOverlayWindowWidth
  );
  const height = clamp(
    Math.ceil(Math.max(contentBounds.height + overlayWindowMargin * 2, contentBounds.minimumWindowHeight ?? 0)),
    minOverlayWindowHeight,
    maxOverlayWindowHeight
  );
  if (currentBounds.width === width && currentBounds.height === height) {
    return currentBounds;
  }

  const contentCenterX = currentBounds.x + contentBounds.left + contentBounds.width / 2;
  const contentCenterY = currentBounds.y + contentBounds.top + contentBounds.height / 2;

  return {
    x: Math.round(contentCenterX - width / 2),
    y: options.preserveWindowTop ? currentBounds.y : Math.round(contentCenterY - height / 2),
    width,
    height
  };
}

export function clampBoundsToVisibleRect(bounds: Rectangle, visibleRect: Rectangle, displayBounds: Rectangle): Rectangle {
  const width = Math.min(bounds.width, displayBounds.width);
  const height = Math.min(bounds.height, displayBounds.height);
  const x = clamp(
    bounds.x,
    displayBounds.x - visibleRect.x,
    displayBounds.x + displayBounds.width - visibleRect.x - visibleRect.width
  );
  const y = clamp(
    bounds.y,
    displayBounds.y - visibleRect.y,
    displayBounds.y + displayBounds.height - visibleRect.y - visibleRect.height
  );

  return {
    x,
    y,
    width,
    height
  };
}

export function getEventContextCwd(value: unknown): string | null {
  if (!isRecord(value) || typeof value.cwd !== "string" || !value.cwd.trim()) {
    return null;
  }

  const cwd = path.normalize(value.cwd.trim());
  return path.isAbsolute(cwd) ? cwd : null;
}

export function getEventContextTerminalApp(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.terminal) || typeof value.terminal.appName !== "string") {
    return "Terminal";
  }

  const appName = value.terminal.appName.trim();
  return appName ? appName : "Terminal";
}

export function getEventContextPidCandidates(value: unknown): number[] {
  if (!isRecord(value)) {
    return [];
  }

  const candidates: number[] = [];
  appendPositiveInteger(candidates, value.sourcePid);
  if (Array.isArray(value.pidChain)) {
    for (const pid of value.pidChain.slice(0, 4)) {
      appendPositiveInteger(candidates, pid);
    }
  }

  return candidates;
}

export async function openEventContext(value: unknown): Promise<OpenEventContextResult> {
  return openEventContextWithActions(value, {
    focus: focusEventContextProcess,
    openCwd: openTerminalAtEventCwd
  });
}

export async function openEventContextWithActions(
  value: unknown,
  actions: {
    focus: (value: unknown) => Promise<boolean>;
    openCwd: (value: unknown) => Promise<boolean>;
  }
): Promise<OpenEventContextResult> {
  const hasPidCandidates = getEventContextPidCandidates(value).length > 0;
  const focused = await actions.focus(value);
  if (focused) {
    return { outcome: "focused-session", method: "pid" };
  }

  const openedCwd = await actions.openCwd(value);
  if (openedCwd) {
    return {
      outcome: "opened-cwd-fallback",
      method: "cwd",
      ...(hasPidCandidates ? { reason: "process-focus-failed" } : {})
    };
  }

  const reason = hasPidCandidates ? "process-focus-and-cwd-open-failed" : "missing-context";
  return { outcome: "unavailable", reason };
}

export async function focusEventContextProcess(value: unknown): Promise<boolean> {
  const pidCandidates = getEventContextPidCandidates(value);
  if (pidCandidates.length === 0) {
    return false;
  }

  if (process.platform === "darwin") {
    return focusMacProcessByPid(pidCandidates);
  }

  if (process.platform === "linux") {
    return focusLinuxProcessByPid(pidCandidates[0]);
  }

  return false;
}

export async function openTerminalAtEventCwd(value: unknown): Promise<boolean> {
  const cwd = getEventContextCwd(value);
  if (!cwd) {
    return false;
  }

  try {
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  const terminalAppName = getEventContextTerminalApp(value);
  if (terminalAppName !== "Terminal" && (await openTerminalAppAtCwd(terminalAppName, cwd))) {
    return true;
  }

  return openTerminalAppAtCwd("Terminal", cwd);
}

function openTerminalAppAtCwd(appName: string, cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("open", ["-a", appName, cwd], { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

function focusMacProcessByPid(pidCandidates: number[]): Promise<boolean> {
  const pidList = pidCandidates.slice(0, 4).join(", ");
  const script = `
    tell application "System Events"
      repeat with targetPid in {${pidList}}
        set pidValue to contents of targetPid
        set pList to every process whose unix id is pidValue
        if (count of pList) > 0 then
          set frontmost of item 1 of pList to true
          return "ok"
        end if
      end repeat
    end tell`;

  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 1500 }, (error) => resolve(!error));
  });
}

function focusLinuxProcessByPid(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("wmctrl", ["-lp"], { timeout: 1000 }, (error, stdout) => {
      if (error || !stdout) {
        resolve(false);
        return;
      }

      const match = String(stdout)
        .split(/\r?\n/)
        .find((line) => {
          const parts = line.trim().split(/\s+/);
          return parts.length >= 3 && Number(parts[2]) === pid;
        });
      const windowId = match?.trim().split(/\s+/)[0];
      if (!windowId) {
        resolve(false);
        return;
      }

      execFile("wmctrl", ["-i", "-a", windowId], { timeout: 1000 }, (activateError) => resolve(!activateError));
    });
  });
}

function appendPositiveInteger(target: number[], value: unknown): void {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && !target.includes(value)) {
    target.push(value);
  }
}

export function isAllowedDevServerUrl(value: string | undefined, isPackaged = app.isPackaged): value is string {
  if (!value || isPackaged) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

export function isDebugUiEnabled(value = process.env.CLAUDE_PET_DEBUG_UI): boolean {
  return value === "1" || value === "true";
}

export function withDebugQuery(rendererUrl: string): string {
  const url = new URL(rendererUrl);
  url.searchParams.set("debug", "1");
  return url.toString();
}

export function registerPetAssetProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: petAssetProtocol,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true
      }
    }
  ]);
}

export function installPetAssetProtocol(options: Pick<PetWindowOptions, "getState">): void {
  protocol.handle(petAssetProtocol, (request) => {
    const spritesheetPath = parseSpritesheetAssetUrl(request.url);
    const state = options.getState();

    if (!spritesheetPath || !state?.pets.some((pet) => pet.spritesheetPath === spritesheetPath)) {
      return new Response("Not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(spritesheetPath).toString());
  });
}

export async function createPetWindow(options: PetWindowOptions): Promise<BrowserWindow> {
  const window = new BrowserWindow(createPetWindowBrowserWindowOptions(path.join(electronDistDir, "preload.cjs")));

  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const debugUi = isDebugUiEnabled();

  if (isAllowedDevServerUrl(process.env.VITE_DEV_SERVER_URL)) {
    await window.loadURL(debugUi ? withDebugQuery(process.env.VITE_DEV_SERVER_URL) : process.env.VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(
      path.join(electronDistDir, "../dist-renderer/index.html"),
      debugUi ? { query: { debug: "1" } } : undefined
    );
  }
  return window;
}

export function installWindowIpc(options: PetWindowOptions): void {
  ipcMain.handle("app:getInitialState", () => toRendererInitialState(options.getState()));
  ipcMain.handle("app:reloadPets", async () => toRendererInitialState(await options.reloadPets()));
  ipcMain.handle("app:selectPet", async (_event, petId: unknown) => {
    if (typeof petId !== "string" || !petId.trim()) {
      return toRendererInitialState(options.getState());
    }

    return toRendererInitialState(await options.selectPet(petId));
  });
  ipcMain.handle("app:openPetsDirectory", async () => {
    const state = options.getState();
    if (!state) {
      return;
    }

    await shell.openPath(state.petsDirectory);
  });
  ipcMain.handle("app:closePet", () => {
    options.closePet();
  });
  ipcMain.handle("bridge:getStatus", () => options.getBridgeStatus?.() ?? options.getState()?.bridge);
  ipcMain.handle("bridge:submitPermissionDecision", (_event, requestId: unknown, behavior: unknown) => {
    if (typeof requestId !== "string" || (behavior !== "allow" && behavior !== "deny")) {
      return false;
    }

    return (
      options.submitPermissionDecision?.(requestId, {
        behavior,
        ...(behavior === "deny" ? { message: "Denied in Claude Pets.", interrupt: true } : {})
      }) ?? false
    );
  });
  ipcMain.handle("app:openEventContext", (_event, rawEvent: unknown) => openEventContext(rawEvent));
  ipcMain.handle("app:moveWindowBy", (event, deltaX: unknown, deltaY: unknown) => {
    const normalizedDeltaX = normalizeWindowDelta(deltaX);
    const normalizedDeltaY = normalizeWindowDelta(deltaY);

    if (normalizedDeltaX === null || normalizedDeltaY === null) {
      return;
    }

    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return;
    }

    const currentBounds = window.getContentBounds();
    const targetBounds = {
      ...currentBounds,
      x: Math.round(currentBounds.x + normalizedDeltaX),
      y: Math.round(currentBounds.y + normalizedDeltaY)
    };
    const dragAnchorBounds = getPetWindowRuntime(window).dragAnchorBounds;
    const nextBounds = dragAnchorBounds ? clampBoundsToVisibleDisplay(targetBounds, dragAnchorBounds) : targetBounds;
    window.setPosition(nextBounds.x, nextBounds.y, false);
  });
  ipcMain.handle("app:setOverlayContentBounds", (event, rawBounds: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const contentBounds = normalizeOverlayContentBounds(rawBounds);
    if (!window || !contentBounds) {
      return;
    }

    applyOverlayContentBounds(window, contentBounds);
  });
  ipcMain.handle("app:setDragAnchorBounds", (event, rawBounds: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const dragAnchorBounds = normalizeOverlayContentBounds(rawBounds);
    if (!window || !dragAnchorBounds) {
      return;
    }

    getPetWindowRuntime(window).dragAnchorBounds = toRectangle(dragAnchorBounds);
  });
  ipcMain.handle("app:setPointerInteractivity", (event, isInteractive: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || typeof isInteractive !== "boolean") {
      return;
    }

    applyPointerInteractivity(window, isInteractive);
  });
  ipcMain.handle("app:quit", () => {
    app.quit();
  });
}

export function applyOverlayContentBounds(window: BrowserWindow, contentBounds: ClaudePetOverlayBounds): void {
  if (window.isDestroyed()) {
    return;
  }

  const currentBounds = window.getContentBounds();
  const dragAnchorBounds = getPetWindowRuntime(window).dragAnchorBounds;
  const targetBounds = getOverlayContentWindowBounds(currentBounds, contentBounds, {
    preserveWindowTop: dragAnchorBounds !== null
  });
  if (targetBounds.width === currentBounds.width && targetBounds.height === currentBounds.height) {
    return;
  }

  const clampedBounds = clampBoundsToVisibleDisplay(targetBounds, dragAnchorBounds ?? toRectangle(contentBounds));
  if (!rectanglesEqual(currentBounds, clampedBounds)) {
    window.setContentBounds(clampedBounds, false);
  }
}

export function applyPointerInteractivity(
  window: BrowserWindow,
  isInteractive: boolean,
  options: { forceCursorRefresh?: boolean } = {}
): void {
  if (window.isDestroyed()) {
    return;
  }

  const runtime = getPetWindowRuntime(window);
  const shouldPassThrough = !isInteractive;
  if (runtime.mousePassthroughEnabled === shouldPassThrough) {
    if (isInteractive && options.forceCursorRefresh) {
      refreshCursorAtCurrentMousePosition(window);
    }
    return;
  }

  runtime.mousePassthroughEnabled = shouldPassThrough;
  if (shouldPassThrough) {
    window.setIgnoreMouseEvents(true, { forward: true });
    return;
  }

  window.setIgnoreMouseEvents(false);
  refreshCursorAtCurrentMousePosition(window);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPetWindowRuntime(window: BrowserWindow): PetWindowRuntime {
  const runtime = petWindowRuntime.get(window);
  if (runtime) {
    return runtime;
  }

  const nextRuntime = { dragAnchorBounds: null, mousePassthroughEnabled: false };
  petWindowRuntime.set(window, nextRuntime);
  return nextRuntime;
}

function refreshCursorAtCurrentMousePosition(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }

  const cursor = screen.getCursorScreenPoint();
  const bounds = window.getContentBounds();
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) {
    return;
  }

  window.webContents.sendInputEvent({ type: "mouseMove", x, y, movementX: 0, movementY: 0 });
}

function clampBoundsToVisibleDisplay(bounds: Rectangle, visibleRect: Rectangle = { x: 0, y: 0, width: bounds.width, height: bounds.height }): Rectangle {
  const displayBounds = screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + visibleRect.x + visibleRect.width / 2),
    y: Math.round(bounds.y + visibleRect.y + visibleRect.height / 2)
  }).bounds;

  return clampBoundsToVisibleRect(bounds, visibleRect, displayBounds);
}

function rectanglesEqual(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeOptionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function toRectangle(bounds: ClaudePetOverlayBounds): Rectangle {
  return {
    x: bounds.left,
    y: bounds.top,
    width: bounds.width,
    height: bounds.height
  };
}

function clamp(value: number, min: number, max: number): number {
  return min > max ? Math.round((min + max) / 2) : Math.min(Math.max(Math.round(value), min), max);
}

function parseSpritesheetAssetUrl(assetUrl: string): string | null {
  try {
    const url = new URL(assetUrl);
    if (url.protocol !== `${petAssetProtocol}:` || url.hostname !== spritesheetAssetHost) {
      return null;
    }

    const encodedPath = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
    if (encodedPath === "") {
      return null;
    }

    return decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

export function toRendererInitialState(state: InitialState | undefined): InitialState | undefined {
  if (!state) {
    return state;
  }

  return {
    ...state,
    pets: state.pets.map((pet) => ({
      ...pet,
      spritesheetPath: createSpritesheetAssetUrl(pet.spritesheetPath)
    })),
    selectedPet: state.selectedPet
      ? {
          ...state.selectedPet,
          spritesheetPath: createSpritesheetAssetUrl(state.selectedPet.spritesheetPath)
        }
      : null
  };
}
