export const animationStates = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review"
] as const;

export type PetAnimationState = (typeof animationStates)[number];

export type DurablePetAnimationState = Exclude<PetAnimationState, "waving" | "jumping">;

export type PetAnimationDefinition = {
  row: number;
  frames: number;
  frameDurationMs: number;
  loop: boolean;
};

export type AnimationStatus = {
  current: PetAnimationState;
  durable: DurablePetAnimationState;
  previousDurable: DurablePetAnimationState | null;
};

export type DragDirection = "left" | "right";

export type AnimationIntent =
  | PetAnimationState
  | "transition-complete"
  | "drag-end"
  | {
      type: "drag";
      direction: DragDirection;
    };

export const animationDefinitions: Record<PetAnimationState, PetAnimationDefinition> = {
  idle: { row: 0, frames: 6, frameDurationMs: 1000, loop: true },
  "running-right": { row: 1, frames: 8, frameDurationMs: 500, loop: true },
  "running-left": { row: 2, frames: 8, frameDurationMs: 500, loop: true },
  waving: { row: 3, frames: 8, frameDurationMs: 500, loop: false },
  jumping: { row: 4, frames: 8, frameDurationMs: 500, loop: false },
  failed: { row: 5, frames: 8, frameDurationMs: 500, loop: true },
  waiting: { row: 6, frames: 6, frameDurationMs: 1000, loop: true },
  running: { row: 7, frames: 6, frameDurationMs: 1000, loop: true },
  review: { row: 8, frames: 6, frameDurationMs: 1000, loop: true }
};

const durableAnimationStates = new Set<PetAnimationState>([
  "idle",
  "running-right",
  "running-left",
  "failed",
  "waiting",
  "running",
  "review"
]);

export function getAnimationDefinition(state: PetAnimationState): PetAnimationDefinition {
  return animationDefinitions[state];
}

export function getAnimationDurationMs(state: PetAnimationState): number {
  const definition = getAnimationDefinition(state);
  return definition.frames * definition.frameDurationMs;
}

export function isDurableAnimationState(state: PetAnimationState): state is DurablePetAnimationState {
  return durableAnimationStates.has(state);
}

export function getNextAnimationStatus(status: AnimationStatus, intent: AnimationIntent): AnimationStatus {
  if (intent === "transition-complete") {
    const restored = status.previousDurable ?? "idle";
    return {
      current: restored,
      durable: restored,
      previousDurable: null
    };
  }

  if (intent === "drag-end") {
    return {
      current: status.durable,
      durable: status.durable,
      previousDurable: null
    };
  }

  if (typeof intent === "object") {
    return {
      current: intent.direction === "left" ? "running-left" : "running-right",
      durable: status.durable,
      previousDurable: status.previousDurable
    };
  }

  if (isDurableAnimationState(intent)) {
    return {
      current: intent,
      durable: intent,
      previousDurable: null
    };
  }

  return {
    current: intent,
    durable: status.durable,
    previousDurable: status.durable
  };
}
