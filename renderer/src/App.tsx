import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject
} from "react";
import type {
  ClaudeBridgeStatus,
  ClaudeBridgePetState,
  ClaudePetOverlayBounds,
  InitialState,
  NormalizedClaudeEvent,
  NormalizedPermissionRequest,
  PetPackage,
  PermissionDecisionBehavior
} from "../../electron/types";
import { animationStates, getNextAnimationStatus, type AnimationStatus, type PetAnimationState } from "./pet/animation";
import { PetSprite } from "./pet/PetSprite";
import {
  completePermissionSubmit,
  createPermissionQueueState,
  enqueuePermissionRequest,
  expirePermissionRequest,
  failPermissionSubmit,
  getCurrentPermissionStatus,
  startPermissionSubmit
} from "./permissionQueue";

export type RendererMode = "normal" | "debug";

export const statusNotificationDurationsMs: Record<ClaudeBridgePetState, number> = {
  idle: 0,
  running: 3 * 60 * 1000,
  failed: 60 * 60 * 1000,
  waiting: 24 * 60 * 60 * 1000,
  review: 30 * 1000
};

const hitRegionSelector = "[data-pet-hit-region='true']";
const contextMenuWidth = 190;
const petFlyoutWidth = 218;
const contextMenuViewportPadding = 8;
const contextMenuTargetViewportWidth = 420;
const contextMenuTargetViewportHeight = 520;
const ignoredBoundsSelector = "[data-pet-bounds='ignore']";

type PetContextMenuPlacement = {
  x: number;
  y: number;
  flyoutSide: "left" | "right";
};

export function getRendererMode(search: string, envDebug: string | undefined): RendererMode {
  const params = new URLSearchParams(search);
  const debugParam = params.get("debug");
  if (debugParam === "1" || debugParam === "true") {
    return "debug";
  }

  return envDebug === "1" || envDebug === "true" ? "debug" : "normal";
}

export function createStatusEventKey(event: NormalizedClaudeEvent): string {
  return [event.sessionId ?? "", event.hookEventName, event.receivedAt, event.title, event.body].join("\u0001");
}

export function createStatusActivityKey(event: NormalizedClaudeEvent): string {
  if (event.sessionId) {
    return `session:${event.sessionId}`;
  }
  if (event.sourcePid) {
    return `source:${event.sourcePid}`;
  }
  if (event.agentPid) {
    return `agent:${event.agentPid}`;
  }
  if (event.cwd) {
    return `cwd:${event.cwd}`;
  }

  return "global";
}

export function isPassiveClaudeWaitingEvent(event: NormalizedClaudeEvent): boolean {
  return event.petState === "idle";
}

export function updateStatusHistoryWithEvent(
  history: NormalizedClaudeEvent[],
  event: NormalizedClaudeEvent,
  maxEvents = 20
): NormalizedClaudeEvent[] {
  const activityKey = createStatusActivityKey(event);

  if (isPassiveClaudeWaitingEvent(event)) {
    const nextHistory = history.filter(
      (candidate) => createStatusActivityKey(candidate) !== activityKey || candidate.petState === "review" || candidate.petState === "failed"
    );
    return nextHistory.slice(0, maxEvents);
  }

  const nextHistory = history.filter((candidate) => createStatusActivityKey(candidate) !== activityKey);
  return [event, ...nextHistory].slice(0, maxEvents);
}

export function getStatusEventExpiresAtMs(event: NormalizedClaudeEvent): number | null {
  const receivedAtMs = Date.parse(event.receivedAt);
  if (!Number.isFinite(receivedAtMs)) {
    return null;
  }

  return receivedAtMs + statusNotificationDurationsMs[event.petState];
}

export function isStatusEventVisible(event: NormalizedClaudeEvent, nowMs = Date.now()): boolean {
  const expiresAtMs = getStatusEventExpiresAtMs(event);
  return expiresAtMs === null || nowMs < expiresAtMs;
}

export function getVisibleStatusEvents(
  events: NormalizedClaudeEvent[],
  nowMs = Date.now(),
  dismissedStatusKeys = new Set<string>()
): NormalizedClaudeEvent[] {
  const visibleEvents: NormalizedClaudeEvent[] = [];
  const seenActivityKeys = new Set<string>();

  for (const event of events) {
    const activityKey = createStatusActivityKey(event);
    if (seenActivityKeys.has(activityKey)) {
      continue;
    }
    seenActivityKeys.add(activityKey);

    if (event.petState !== "idle" && !dismissedStatusKeys.has(createStatusEventKey(event)) && isStatusEventVisible(event, nowMs)) {
      visibleEvents.push(event);
    }
  }

  return visibleEvents;
}

function getNextStatusEventExpiryMs(
  events: NormalizedClaudeEvent[],
  nowMs: number,
  dismissedStatusKeys: Set<string>
): number | null {
  let nextExpiryMs: number | null = null;

  for (const event of events) {
    if (isPassiveClaudeWaitingEvent(event) || dismissedStatusKeys.has(createStatusEventKey(event))) {
      continue;
    }

    const expiresAtMs = getStatusEventExpiresAtMs(event);
    if (expiresAtMs !== null && expiresAtMs > nowMs && (nextExpiryMs === null || expiresAtMs < nextExpiryMs)) {
      nextExpiryMs = expiresAtMs;
    }
  }

  return nextExpiryMs;
}

function useFloatingWindowPointerInteractivity(
  enabled: boolean,
  interactiveRegionRef: RefObject<HTMLElement | null>,
  isPaused: () => boolean
) {
  useEffect(() => {
    if (!enabled) {
      void window.claudePet.setPointerInteractivity(true);
      return;
    }

    let lastInteractive: boolean | null = null;
    let latestPoint: { x: number; y: number } | null = null;
    let animationFrame: number | null = null;

    const reportInteractive = (isInteractive: boolean) => {
      if (lastInteractive === isInteractive) {
        return;
      }

      lastInteractive = isInteractive;
      void window.claudePet.setPointerInteractivity(isInteractive);
    };

    const isPointInteractive = (point: { x: number; y: number }) => {
      if (isPaused()) {
        return true;
      }

      const root = interactiveRegionRef.current;
      if (!root) {
        return true;
      }

      for (const element of getVisibleHitRegions(root)) {
        if (isPointInsideElement(point, element)) {
          return true;
        }
      }

      return false;
    };

    const flushPoint = () => {
      animationFrame = null;
      if (latestPoint) {
        reportInteractive(isPointInteractive(latestPoint));
      }
    };

    const schedulePointCheck = (point: { x: number; y: number }) => {
      latestPoint = point;
      animationFrame ??= window.requestAnimationFrame(flushPoint);
    };

    const updateFromHover = () => {
      if (isPaused()) {
        reportInteractive(true);
        return;
      }

      const root = interactiveRegionRef.current;
      if (!root) {
        reportInteractive(true);
        return;
      }

      for (const element of getVisibleHitRegions(root)) {
        if (element.matches(":hover")) {
          reportInteractive(true);
          return;
        }
      }

      reportInteractive(!document.documentElement.matches(":hover"));
    };

    const observer = new MutationObserver(() => {
      if (latestPoint) {
        schedulePointCheck(latestPoint);
      } else {
        updateFromHover();
      }
    });
    const onMouseMove = (event: MouseEvent) => schedulePointCheck({ x: event.clientX, y: event.clientY });
    const onWindowMouseLeave = () => reportInteractive(false);

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("resize", updateFromHover);
    window.addEventListener("scroll", updateFromHover, true);
    window.addEventListener("mouseleave", onWindowMouseLeave);
    observer.observe(document.body, {
      attributeFilter: ["aria-hidden", "class", "hidden", "style"],
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
    updateFromHover();

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("resize", updateFromHover);
      window.removeEventListener("scroll", updateFromHover, true);
      window.removeEventListener("mouseleave", onWindowMouseLeave);
      observer.disconnect();
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      void window.claudePet.setPointerInteractivity(true);
    };
  }, [enabled, interactiveRegionRef, isPaused]);
}

function useOverlayContentBounds(
  enabled: boolean,
  overlayRef: RefObject<HTMLElement | null>,
  shouldReserveContextMenuViewport: boolean
) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    let lastPayload = "";
    let animationFrame: number | null = null;
    const resizeObserver = new ResizeObserver(() => scheduleReport());
    const mutationObserver = new MutationObserver(() => scheduleReport());

    const reportBounds = () => {
      animationFrame = null;
      const root = overlayRef.current;
      if (!root) {
        return;
      }

      const bounds = getHitRegionUnionBounds(root);
      if (!bounds) {
        return;
      }

      const payload = {
        ...bounds,
        ...getOverlayMinimumWindowSize(shouldReserveContextMenuViewport)
      };
      const payloadKey = JSON.stringify(payload);
      if (payloadKey === lastPayload) {
        return;
      }

      lastPayload = payloadKey;
      void window.claudePet.setOverlayContentBounds(payload);
    };

    function scheduleReport() {
      animationFrame ??= window.requestAnimationFrame(reportBounds);
    }

    resizeObserver.observe(document.body);
    mutationObserver.observe(document.body, {
      attributeFilter: ["class", "hidden", "style"],
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
    window.addEventListener("resize", scheduleReport);
    scheduleReport();

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", scheduleReport);
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [enabled, overlayRef, shouldReserveContextMenuViewport]);
}

function useDragAnchorBounds(enabled: boolean, overlayRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    let lastPayload = "";
    let animationFrame: number | null = null;
    const resizeObserver = new ResizeObserver(() => scheduleReport());
    const mutationObserver = new MutationObserver(() => scheduleReport());

    const reportBounds = () => {
      animationFrame = null;
      const root = overlayRef.current;
      if (!root) {
        return;
      }

      const bounds = getDragAnchorBounds(root);
      if (!bounds) {
        return;
      }

      const payloadKey = JSON.stringify(bounds);
      if (payloadKey === lastPayload) {
        return;
      }

      lastPayload = payloadKey;
      void window.claudePet.setDragAnchorBounds(bounds);
    };

    function scheduleReport() {
      animationFrame ??= window.requestAnimationFrame(reportBounds);
    }

    resizeObserver.observe(document.body);
    mutationObserver.observe(document.body, {
      attributeFilter: ["class", "hidden", "style"],
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
    window.addEventListener("resize", scheduleReport);
    scheduleReport();

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", scheduleReport);
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [enabled, overlayRef]);
}

function getVisibleHitRegions(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(hitRegionSelector)).filter(isVisibleElement);
}

function getDragAnchorBounds(root: HTMLElement): ClaudePetOverlayBounds | null {
  const element = root.querySelector<HTMLElement>(".pet-stage .pet-sprite, .pet-stage .pet-placeholder, .pet-stage");
  if (!element || !isVisibleElement(element)) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  return {
    left: Math.floor(rect.left),
    top: Math.floor(rect.top),
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height)
  };
}

function getHitRegionUnionBounds(root: HTMLElement) {
  const regions = getVisibleHitRegions(root).filter((element) => !element.matches(ignoredBoundsSelector));
  if (regions.length === 0) {
    return null;
  }

  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const element of regions) {
    const rect = element.getBoundingClientRect();
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }

  return {
    left: Math.floor(left),
    top: Math.floor(top),
    width: Math.ceil(right - left),
    height: Math.ceil(bottom - top)
  };
}

function getOverlayMinimumWindowSize(shouldReserveContextMenuViewport: boolean) {
  return shouldReserveContextMenuViewport
    ? { minimumWindowWidth: contextMenuTargetViewportWidth, minimumWindowHeight: contextMenuTargetViewportHeight }
    : {};
}

function isVisibleElement(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none" && rect.width > 0 && rect.height > 0;
}

function isPointInsideElement(point: { x: number; y: number }, element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) {
    return false;
  }

  return document.elementsFromPoint(point.x, point.y).some((candidate) => candidate === element || element.contains(candidate));
}

function clamp(value: number, min: number, max: number): number {
  return min > max ? Math.round((min + max) / 2) : Math.min(Math.max(Math.round(value), min), max);
}

export function getPetMenuInitial(pet: Pick<PetPackage, "displayName" | "id">): string {
  const source = (pet.displayName || pet.id).trim();
  return Array.from(source)[0]?.toLocaleUpperCase() ?? "?";
}

export function getContextMenuPlacement(
  point: { clientX: number; clientY: number },
  rootRect: Pick<DOMRect, "left" | "top">,
  viewport: Pick<Window, "innerWidth" | "innerHeight">
): PetContextMenuPlacement {
  const virtualWidth = Math.max(viewport.innerWidth, contextMenuTargetViewportWidth);
  const virtualHeight = Math.max(viewport.innerHeight, contextMenuTargetViewportHeight);
  const preferredX = point.clientX - rootRect.left;
  const preferredY = point.clientY - rootRect.top;
  const flyoutGapOverlap = 3;
  const rightTotalWidth = contextMenuWidth + petFlyoutWidth - flyoutGapOverlap;
  const hasRoomOnRight = preferredX + rightTotalWidth + contextMenuViewportPadding <= virtualWidth;
  const hasRoomOnLeft = preferredX - petFlyoutWidth + flyoutGapOverlap >= contextMenuViewportPadding;
  const flyoutSide = hasRoomOnRight || !hasRoomOnLeft ? "right" : "left";
  const maxX =
    flyoutSide === "right"
      ? Math.max(contextMenuViewportPadding, virtualWidth - rightTotalWidth - contextMenuViewportPadding)
      : Math.max(contextMenuViewportPadding, virtualWidth - contextMenuWidth - contextMenuViewportPadding);
  const maxY = Math.max(contextMenuViewportPadding, virtualHeight - 188 - contextMenuViewportPadding);

  return {
    x: clamp(preferredX, contextMenuViewportPadding, maxX),
    y: clamp(preferredY, contextMenuViewportPadding, maxY),
    flyoutSide
  };
}

export function App() {
  const [state, setState] = useState<InitialState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [animationStatus, setAnimationStatus] = useState<AnimationStatus>({
    current: "idle",
    durable: "idle",
    previousDurable: null
  });
  const [reducedMotion, setReducedMotion] = useState(false);
  const [permissionQueue, setPermissionQueue] = useState(createPermissionQueueState);
  const [statusHistory, setStatusHistory] = useState<NormalizedClaudeEvent[]>([]);
  const [dismissedStatusKeys, setDismissedStatusKeys] = useState(() => new Set<string>());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [contextMenu, setContextMenu] = useState<PetContextMenuPlacement | null>(null);
  const dragRef = useRef<{ pointerId: number; screenX: number; screenY: number } | null>(null);
  const normalOverlayRef = useRef<HTMLElement | null>(null);
  const selectedPet = state?.selectedPet ?? null;
  const bridge = state?.bridge ?? null;
  const latestEvent = bridge?.latestEvent ?? null;
  const visibleStatusHistory = getVisibleStatusEvents(statusHistory, nowMs, dismissedStatusKeys);
  const visibleLatestEvent =
    latestEvent && !dismissedStatusKeys.has(createStatusEventKey(latestEvent)) && isStatusEventVisible(latestEvent, nowMs)
      ? latestEvent
      : null;
  const currentPermission = getCurrentPermissionStatus(permissionQueue);
  const mode = getRendererMode(
    window.location.search,
    (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_CLAUDE_PET_DEBUG
  );
  const isPointerInteractionPaused = useCallback(() => dragRef.current !== null, []);

  useFloatingWindowPointerInteractivity(mode === "normal", normalOverlayRef, isPointerInteractionPaused);
  useOverlayContentBounds(mode === "normal", normalOverlayRef, contextMenu !== null);
  useDragAnchorBounds(mode === "normal", normalOverlayRef);

  async function reloadPets() {
    setError(null);
    try {
      setState(await window.claudePet.reloadPets());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to reload pets.");
    }
  }

  async function selectPet(petId: string) {
    setError(null);
    try {
      setState(await window.claudePet.selectPet(petId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to switch pets.");
    }
  }

  async function openPetsDirectory() {
    try {
      await window.claudePet.openPetsDirectory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to open pets directory.");
    }
  }

  function closePet() {
    void window.claudePet.closePet();
  }

  useEffect(() => {
    let cancelled = false;

    window.claudePet
      .getInitialState()
      .then((nextState) => {
        if (!cancelled) {
          setState(nextState);
          setNowMs(Date.now());
          setStatusHistory(nextState.bridge.latestEvent ? updateStatusHistoryWithEvent([], nextState.bridge.latestEvent) : []);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to load Claude Pets.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return window.claudePet.onClaudeEvent((event) => {
      setState((current) => (current ? { ...current, bridge: { ...current.bridge, latestEvent: event } } : current));
      setNowMs(Date.now());
      setStatusHistory((current) => updateStatusHistoryWithEvent(current, event));
      setAnimationStatus((current) => getNextAnimationStatus(current, isPassiveClaudeWaitingEvent(event) ? "idle" : event.petState));
    });
  }, []);

  useEffect(() => {
    return window.claudePet.onStateChanged((nextState) => {
      setState(nextState ?? null);
      setNowMs(Date.now());
    });
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };
    const closeOnBlur = () => setContextMenu(null);

    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", closeOnBlur, { once: true });
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [contextMenu]);

  useEffect(() => {
    const nextExpiryMs = getNextStatusEventExpiryMs(statusHistory, nowMs, dismissedStatusKeys);
    if (nextExpiryMs === null) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setNowMs(Date.now());
    }, Math.max(0, nextExpiryMs - nowMs));

    return () => window.clearTimeout(timeout);
  }, [dismissedStatusKeys, nowMs, statusHistory]);

  useEffect(() => {
    return window.claudePet.onPermissionRequest((request) => {
      setPermissionQueue((current) => enqueuePermissionRequest(current, request));
      setAnimationStatus((current) => getNextAnimationStatus(current, "waiting"));
    });
  }, []);

  useEffect(() => {
    if (permissionQueue.order.length === 0) {
      return;
    }

    const timeouts = permissionQueue.order.flatMap((requestId) => {
      const request = permissionQueue.requests[requestId];
      if (!request) {
        return [];
      }

      const expiresAt = Date.parse(request.expiresAt);
      const delay = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - Date.now()) : 0;
      return [
        window.setTimeout(() => {
          setPermissionQueue((current) => expirePermissionRequest(current, requestId).state);
        }, delay)
      ];
    });

    return () => {
      for (const timeout of timeouts) {
        window.clearTimeout(timeout);
      }
    };
  }, [permissionQueue]);

  useEffect(() => {
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateReducedMotion = () => setReducedMotion(motionQuery.matches);

    updateReducedMotion();
    motionQuery.addEventListener("change", updateReducedMotion);
    return () => motionQuery.removeEventListener("change", updateReducedMotion);
  }, []);

  const setAnimation = useCallback((animation: PetAnimationState) => {
    setAnimationStatus((current) => getNextAnimationStatus(current, animation));
  }, []);

  const finishTransition = useCallback(() => {
    setAnimationStatus((current) => getNextAnimationStatus(current, "transition-complete"));
  }, []);

  const dismissStatusEvent = useCallback((event: NormalizedClaudeEvent) => {
    const key = createStatusEventKey(event);
    setDismissedStatusKeys((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
    setStatusHistory((current) => current.filter((candidate) => createStatusEventKey(candidate) !== key));
  }, []);

  const openStatusEventContext = useCallback((event: NormalizedClaudeEvent) => {
    void window.claudePet.openEventContext(event);
  }, []);

  async function submitPermissionDecision(behavior: PermissionDecisionBehavior) {
    const request = currentPermission.request;
    if (!request || currentPermission.submitting) {
      return;
    }

    const requestId = request.requestId;
    setPermissionQueue((current) => startPermissionSubmit(current, requestId).state);
    try {
      const accepted = await window.claudePet.submitPermissionDecision(requestId, behavior);
      if (accepted) {
        setPermissionQueue((current) => completePermissionSubmit(current, requestId, true).state);
        return;
      }

      setPermissionQueue((current) => completePermissionSubmit(current, requestId, false).state);
      window.setTimeout(() => {
        setPermissionQueue((current) => expirePermissionRequest(current, requestId).state);
      }, 900);
    } catch {
      setPermissionQueue((current) => failPermissionSubmit(current, requestId, "Decision failed.").state);
    }
  }

  function handlePetPointerDown(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    dragRef.current = {
      pointerId: event.pointerId,
      screenX: event.screenX,
      screenY: event.screenY
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePetPointerMove(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.screenX - drag.screenX;
    const deltaY = event.screenY - drag.screenY;
    if (deltaX === 0 && deltaY === 0) {
      return;
    }

    dragRef.current = {
      pointerId: event.pointerId,
      screenX: event.screenX,
      screenY: event.screenY
    };
    void window.claudePet.moveWindowBy(deltaX, deltaY);

    if (Math.abs(deltaX) >= 1) {
      setAnimationStatus((current) =>
        getNextAnimationStatus(current, { type: "drag", direction: deltaX < 0 ? "left" : "right" })
      );
    }
  }

  function handlePetPointerEnd(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setAnimationStatus((current) => getNextAnimationStatus(current, "drag-end"));
  }

  function showContextMenu(event: ReactMouseEvent<HTMLElement>) {
    if (mode !== "normal") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const root = normalOverlayRef.current;
    if (!root) {
      return;
    }

    setContextMenu(getContextMenuPlacement(event, root.getBoundingClientRect(), window));
  }

  const petStage = (
    <button
      className="pet-stage"
      data-pet-hit-region="true"
      type="button"
      aria-label="Drag Claude Pets"
      onPointerDown={handlePetPointerDown}
      onPointerMove={handlePetPointerMove}
      onPointerUp={handlePetPointerEnd}
      onPointerCancel={handlePetPointerEnd}
    >
      {selectedPet ? (
        <PetSprite
          spritesheetPath={selectedPet.spritesheetPath}
          atlas={selectedPet.atlas}
          state={animationStatus.current}
          reducedMotion={reducedMotion}
          onTransitionEnd={finishTransition}
          scale={mode === "normal" ? 0.42 : 0.72}
        />
      ) : (
        <div className="pet-placeholder" aria-hidden="true">
          <div className="pet-face">
            <span />
            <span />
          </div>
        </div>
      )}
    </button>
  );

  if (mode === "debug") {
    return (
      <DebugPanel
        animationStatus={animationStatus}
        bridge={bridge}
        currentPermission={currentPermission}
        error={error}
        latestEvent={latestEvent}
        onDecision={submitPermissionDecision}
        onReloadPets={reloadPets}
        onSetAnimation={setAnimation}
        petStage={petStage}
        selectedPet={selectedPet}
        state={state}
      />
    );
  }

  return (
    <main className="pet-window normal-mode">
      <section className="pet-overlay" aria-live="polite" onContextMenu={showContextMenu} ref={normalOverlayRef}>
        <span className="sr-only">Bridge ready</span>
        {petStage}
        {currentPermission.request ? (
          <PermissionBubble
            request={currentPermission.request}
            error={currentPermission.error}
            submitting={currentPermission.submitting}
            pendingCount={currentPermission.pendingCount}
            onDecision={submitPermissionDecision}
          />
        ) : (
          <StatusStack
            selectedPet={selectedPet}
            bridge={bridge}
            latestEvent={visibleLatestEvent}
            statusHistory={visibleStatusHistory}
            error={error}
            nowMs={nowMs}
            onDismissStatus={dismissStatusEvent}
            onOpenStatusContext={openStatusEventContext}
          />
        )}
        {contextMenu ? (
          <PetContextMenu
            placement={contextMenu}
            state={state}
            onClose={() => setContextMenu(null)}
            onClosePet={closePet}
            onOpenPetsDirectory={openPetsDirectory}
            onQuit={() => window.claudePet.quit()}
            onReloadPets={reloadPets}
            onSelectPet={selectPet}
          />
        ) : null}
      </section>
    </main>
  );
}

type DebugPanelProps = {
  animationStatus: AnimationStatus;
  bridge: ClaudeBridgeStatus | null;
  currentPermission: ReturnType<typeof getCurrentPermissionStatus>;
  error: string | null;
  latestEvent: ClaudeBridgeStatus["latestEvent"] | null;
  onDecision: (behavior: PermissionDecisionBehavior) => void;
  onReloadPets: () => void;
  onSetAnimation: (animation: PetAnimationState) => void;
  petStage: ReactNode;
  selectedPet: InitialState["selectedPet"];
  state: InitialState | null;
};

type PetContextMenuProps = {
  placement: PetContextMenuPlacement;
  state: InitialState | null;
  onClose: () => void;
  onClosePet: () => void;
  onOpenPetsDirectory: () => Promise<void>;
  onQuit: () => void;
  onReloadPets: () => Promise<void>;
  onSelectPet: (petId: string) => Promise<void>;
};

function PetContextMenu({
  placement,
  state,
  onClose,
  onClosePet,
  onOpenPetsDirectory,
  onQuit,
  onReloadPets,
  onSelectPet
}: PetContextMenuProps) {
  const menuStyle: CSSProperties = {
    left: placement.x,
    top: placement.y
  };

  const runAction = (action: () => void | Promise<void>) => {
    onClose();
    void action();
  };

  return (
    <>
      <button
        aria-label="Close pet menu"
        className="context-menu-dismiss-layer"
        data-pet-bounds="ignore"
        data-pet-hit-region="true"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <nav
        aria-label="Claude Pets menu"
        className={`pet-context-menu flyout-${placement.flyoutSide}`}
        data-pet-bounds="ignore"
        data-pet-hit-region="true"
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => event.stopPropagation()}
        style={menuStyle}
      >
        <button className="context-menu-item" onClick={() => runAction(onClosePet)} type="button">
          Close Pet
        </button>
        <span className="context-menu-separator" />
        <div className="context-menu-pets">
          <button className="context-menu-item has-flyout" type="button">
            <span>Pets</span>
            <span className="context-menu-arrow" aria-hidden="true">›</span>
          </button>
          <div className="pet-flyout" data-pet-bounds="ignore" data-pet-hit-region="true" role="menu">
            {state?.hasPets ? (
              state.pets.map((pet) => (
                <button
                  className={pet.id === state.selectedPet?.id ? "pet-option selected" : "pet-option"}
                  key={pet.id}
                  onClick={() => runAction(() => onSelectPet(pet.id))}
                  type="button"
                >
                  <PetMenuThumbnail pet={pet} />
                  <span className="pet-option-label">{pet.displayName}</span>
                  {pet.id === state.selectedPet?.id ? <span className="pet-option-check" aria-hidden="true">✓</span> : null}
                </button>
              ))
            ) : (
              <span className="pet-option empty">No pets found</span>
            )}
            <span className="context-menu-separator" />
            <button className="context-menu-item" onClick={() => runAction(onReloadPets)} type="button">
              Reload Pets
            </button>
            <button className="context-menu-item" onClick={() => runAction(onOpenPetsDirectory)} type="button">
              Open ~/.claude/pets
            </button>
          </div>
        </div>
        <button className="context-menu-item" onClick={() => runAction(onReloadPets)} type="button">
          Reload Pets
        </button>
        <button className="context-menu-item" onClick={() => runAction(onOpenPetsDirectory)} type="button">
          Open ~/.claude/pets
        </button>
        <span className="context-menu-separator" />
        <button className="context-menu-item" onClick={() => runAction(onQuit)} type="button">
          Quit Claude Pets
        </button>
      </nav>
    </>
  );
}

function PetMenuThumbnail({ pet }: { pet: PetPackage }) {
  const [imageState, setImageState] = useState<"pending" | "ready" | "failed">("pending");
  const scale = 24 / Math.max(pet.atlas.cellWidth, pet.atlas.cellHeight);
  const frameStyle: CSSProperties = {
    width: pet.atlas.cellWidth * scale,
    height: pet.atlas.cellHeight * scale,
    backgroundImage: `url("${pet.spritesheetPath}")`,
    backgroundSize: `${pet.atlas.width * scale}px ${pet.atlas.height * scale}px`,
    backgroundPosition: "0 0"
  };

  return (
    <span className="pet-thumb" aria-hidden="true">
      <span className="pet-thumb-fallback">{getPetMenuInitial(pet)}</span>
      {imageState === "ready" ? <span className="pet-thumb-frame pet-sprite" style={frameStyle} /> : null}
      {imageState !== "failed" ? (
        <img
          alt=""
          className="pet-thumb-probe"
          draggable={false}
          onError={() => setImageState("failed")}
          onLoad={() => setImageState("ready")}
          src={pet.spritesheetPath}
        />
      ) : null}
    </span>
  );
}

function DebugPanel({
  animationStatus,
  bridge,
  currentPermission,
  error,
  latestEvent,
  onDecision,
  onReloadPets,
  onSetAnimation,
  petStage,
  selectedPet,
  state
}: DebugPanelProps) {
  return (
    <main className="pet-window debug-mode">
      <section className="empty-state" aria-live="polite">
        {petStage}
        <div className="empty-copy">
          <h1>{selectedPet ? selectedPet.displayName : "No pets yet"}</h1>
          <p>
            {selectedPet ? selectedPet.description : "Copy Codex-compatible pet folders into "}
            {!selectedPet ? (
              <button className="path-button" onClick={onReloadPets}>
                {state?.petsDirectory ?? "~/.claude/pets"}
              </button>
            ) : null}
            {!selectedPet ? ", then reload pets." : null}
          </p>
          {selectedPet ? (
            <button className="path-button reload-button" onClick={onReloadPets}>
              Reload pets
            </button>
          ) : null}
          <div className="bridge-status" aria-live="polite">
            <div className="bridge-meta">
              <span className={bridge?.listening ? "bridge-dot online" : "bridge-dot"} aria-hidden="true" />
              <span>{formatBridgeEndpoint(bridge)}</span>
            </div>
            <h2>{latestEvent?.title ?? "Bridge ready"}</h2>
            <p>{latestEvent?.body || bridgeCopy(bridge)}</p>
          </div>
          {currentPermission.request ? (
            <PermissionBubble
              request={currentPermission.request}
              error={currentPermission.error}
              submitting={currentPermission.submitting}
              pendingCount={currentPermission.pendingCount}
              onDecision={onDecision}
            />
          ) : null}
          {selectedPet ? (
            <div className="animation-controls" aria-label="Animation controls">
              {animationStates.map((animation) => (
                <button
                  className={animationStatus.current === animation ? "animation-button active" : "animation-button"}
                  key={animation}
                  onClick={() => onSetAnimation(animation)}
                  type="button"
                >
                  {animation}
                </button>
              ))}
            </div>
          ) : null}
          {error ? <p className="error">{error}</p> : null}
          {state?.warnings.length ? (
            <ul className="warnings" aria-label="Pet package warnings">
              {state.warnings.map((warning) => (
                <li key={`${warning.petId}:${warning.message}`}>
                  {warning.petId}: {warning.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
    </main>
  );
}

type StatusBubbleProps = {
  bridge: ClaudeBridgeStatus | null;
  error: string | null;
  latestEvent: ClaudeBridgeStatus["latestEvent"] | null;
  nowMs?: number;
  onDismissStatus?: (event: NormalizedClaudeEvent) => void;
  onOpenStatusContext?: (event: NormalizedClaudeEvent) => void;
  selectedPet: InitialState["selectedPet"];
  statusHistory?: NormalizedClaudeEvent[];
};

type StatusBubbleView = {
  event: NormalizedClaudeEvent | null;
  title: string;
  body: string | null;
  tone: "default" | "error";
  running: boolean;
};

export function getStatusBubbleViews({
  bridge,
  error,
  latestEvent,
  nowMs = Date.now(),
  selectedPet,
  statusHistory = []
}: StatusBubbleProps): StatusBubbleView[] {
  if (error) {
    return [{
      event: null,
      title: "Pet paused",
      body: error,
      tone: "error",
      running: false
    }];
  }

  const events = getVisibleStatusEvents(statusHistory.length > 0 ? statusHistory : latestEvent ? [latestEvent] : [], nowMs);
  if (events.length > 0) {
    return events.slice(0, 3).map((event) => ({
      event,
      title: event.title,
      body: event.body || null,
      tone: event.petState === "failed" ? "error" : "default",
      running: event.petState === "running"
    }));
  }

  if (!selectedPet) {
    return [{
      event: null,
      title: "No pets yet",
      body: "Add a Codex-compatible pet package.",
      tone: "default",
      running: false
    }];
  }

  if (bridge && !bridge.listening) {
    return [{
      event: null,
      title: "Bridge offline",
      body: "Waiting for Claude events.",
      tone: "default",
      running: false
    }];
  }

  return [];
}

export function getStatusBubbleKey(view: StatusBubbleView, index: number): string {
  return view.event ? createStatusActivityKey(view.event) : `static:${view.title}:${view.body ?? ""}:${index}`;
}

function StatusStack({
  bridge,
  error,
  latestEvent,
  nowMs,
  onDismissStatus,
  onOpenStatusContext,
  selectedPet,
  statusHistory
}: StatusBubbleProps) {
  const views = getStatusBubbleViews({ bridge, error, latestEvent, nowMs, selectedPet, statusHistory });

  return views.length > 0 ? (
    <div className="status-stack" aria-live="polite">
      {views.map((view, index) => {
        const canOpenContext = Boolean(canOpenEventContext(view.event) && onOpenStatusContext);
        return (
          <aside
            aria-label={canOpenContext ? `Open terminal for ${view.title}` : undefined}
            className={`status-bubble${view.tone === "error" ? " error-bubble" : ""}${canOpenContext ? " actionable-status" : ""}`}
            data-pet-hit-region="true"
            key={getStatusBubbleKey(view, index)}
            onClick={canOpenContext ? () => onOpenStatusContext?.(view.event as NormalizedClaudeEvent) : undefined}
            onKeyDown={
              canOpenContext
                ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenStatusContext?.(view.event as NormalizedClaudeEvent);
                    }
                  }
                : undefined
            }
            role={canOpenContext ? "button" : undefined}
            tabIndex={canOpenContext ? 0 : undefined}
          >
            <span className="status-copy">
              <strong>{view.title}</strong>
              {view.body ? <span>{view.body}</span> : null}
            </span>
            {view.running ? (
              <span className="status-spinner" aria-hidden="true" />
            ) : (
              <span className="status-icon" aria-hidden="true">
                ✓
              </span>
            )}
            {view.event && onDismissStatus ? (
              <button
                aria-label={`Dismiss ${view.title}`}
                className="status-dismiss"
                onClick={(event) => {
                  event.stopPropagation();
                  onDismissStatus(view.event as NormalizedClaudeEvent);
                }}
                type="button"
              >
                x
              </button>
            ) : null}
          </aside>
        );
      })}
    </div>
  ) : null;
}

export function canOpenEventContext(event: NormalizedClaudeEvent | null): boolean {
  return Boolean(event?.capabilityProvenance?.openContextCapability && event.capabilityProvenance.openContextCapability !== "none");
}

function formatBridgeEndpoint(bridge: ClaudeBridgeStatus | null): string {
  if (!bridge) {
    return "Bridge starting";
  }

  return `${bridge.host}:${bridge.port}`;
}

function bridgeCopy(bridge: ClaudeBridgeStatus | null): string {
  if (!bridge) {
    return "Waiting for bridge status.";
  }

  return bridge.listening ? "Listening for simulated Claude events." : "Bridge offline.";
}

type PermissionBubbleProps = {
  request: NormalizedPermissionRequest;
  error: string | null;
  submitting: boolean;
  pendingCount: number;
  onDecision: (behavior: PermissionDecisionBehavior) => void;
};

export function formatPermissionTitle(request: Pick<NormalizedPermissionRequest, "toolName">): string {
  return `Allow ${request.toolName}?`;
}

function PermissionBubble({ request, error, submitting, pendingCount, onDecision }: PermissionBubbleProps) {
  return (
    <div className="permission-bubble action-bubble" aria-live="polite" data-pet-hit-region="true">
      <div className="permission-copy">
        <h2>{formatPermissionTitle(request)}</h2>
        <p>{request.body || "Permission requested."}</p>
        {error ? <span className="permission-error">{error}</span> : null}
        {pendingCount > 1 ? <span className="permission-count">{pendingCount - 1} queued</span> : null}
      </div>
      <span
        className="permission-status submitting"
        aria-label={submitting ? "Submitting decision" : "Awaiting decision"}
        role="status"
      />
      <div className="permission-actions">
        <button className="deny" disabled={submitting} onClick={() => onDecision("deny")} type="button">
          Deny
        </button>
        <button className="allow" disabled={submitting} onClick={() => onDecision("allow")} type="button">
          Allow
        </button>
      </div>
    </div>
  );
}
