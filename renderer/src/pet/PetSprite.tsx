import { useEffect, useState } from "react";
import type { PetAtlas } from "../../../electron/types";
import {
  getAnimationDefinition,
  getAnimationDurationMs,
  type PetAnimationState
} from "./animation";

type PetSpriteProps = {
  spritesheetPath: string;
  atlas: PetAtlas;
  state: PetAnimationState;
  reducedMotion: boolean;
  onTransitionEnd: () => void;
  scale?: number;
};

export function PetSprite({ spritesheetPath, atlas, state, reducedMotion, onTransitionEnd, scale = 0.72 }: PetSpriteProps) {
  const definition = getAnimationDefinition(state);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    setFrame(0);
  }, [state]);

  useEffect(() => {
    if (reducedMotion) {
      if (!definition.loop) {
        const timeout = window.setTimeout(onTransitionEnd, getAnimationDurationMs(state));
        return () => window.clearTimeout(timeout);
      }
      return;
    }

    if (definition.loop) {
      const interval = window.setInterval(() => {
        setFrame((currentFrame) => (currentFrame + 1) % definition.frames);
      }, definition.frameDurationMs);
      return () => window.clearInterval(interval);
    }

    let transitionTimeout: number | undefined;
    const interval = window.setInterval(() => {
      setFrame((currentFrame) => {
        if (currentFrame >= definition.frames - 1) {
          window.clearInterval(interval);
          transitionTimeout = window.setTimeout(onTransitionEnd, 0);
          return currentFrame;
        }
        return currentFrame + 1;
      });
    }, definition.frameDurationMs);

    return () => {
      window.clearInterval(interval);
      if (transitionTimeout !== undefined) {
        window.clearTimeout(transitionTimeout);
      }
    };
  }, [definition, onTransitionEnd, reducedMotion, state]);

  const width = atlas.cellWidth * scale;
  const height = atlas.cellHeight * scale;

  return (
    <div
      className="pet-sprite"
      aria-label={`${state} animation`}
      style={{
        width,
        height,
        backgroundImage: `url("${spritesheetPath}")`,
        backgroundSize: `${atlas.width * scale}px ${atlas.height * scale}px`,
        backgroundPosition: `${-(frame * atlas.cellWidth * scale)}px ${-(
          definition.row *
          atlas.cellHeight *
          scale
        )}px`
      }}
    />
  );
}
