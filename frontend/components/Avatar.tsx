"use client";

declare module "*.css";

import "./Avatar.css";
import type { AvatarState } from "./types";
import type { AudioPlaybackController } from "./avatar/local/AudioPlaybackController";
import LocalAvatarCanvas from "./avatar/local/LocalAvatarCanvas";
import type { VisemeEvent } from "./avatar/local/LipSyncTimeline";

export type { AvatarState } from "./types";

export type AvatarProps = {
  state: AvatarState;
  visemeState?: AvatarState;
  playbackController?: AudioPlaybackController | null;
  timeline?: VisemeEvent[];
};

export default function Avatar({ state, playbackController, timeline }: AvatarProps) {
  const isThinking = state === "thinking";

  return (
    <div className={`avatar-shell avatar-state-${state}`}>
      <div
        className="avatar-canvas-wrapper"
        style={{ width: "100%", height: "100%", display: isThinking ? "none" : "block" }}
      >
        <LocalAvatarCanvas state={state} playbackController={playbackController} timeline={timeline} />
      </div>
      {isThinking && (
        <img
          src="/avatar/thinking.png"
          alt="Avatar thinking"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", borderRadius: "1rem" }}
        />
      )}
    </div>
  );
}
