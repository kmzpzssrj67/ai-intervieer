"use client";

declare module "*.css";

import { useEffect, useState } from "react";
import "./Avatar.css";
import type { AvatarState } from "./types";

export type { AvatarState } from "./types";

export type AvatarProps = {
  state: AvatarState;
  visemeState?: AvatarState;
  audioElement?: HTMLAudioElement | null;
  isSpeaking?: boolean;
};

const ASSET_BY_STATE: Record<AvatarState, string> = {
  idle: "/avatar/idle.png",
  listening: "/avatar/idle.png",
  thinking: "/avatar/thinking.png",
  speaking: "/avatar/mouth/aa.png",
  mbp: "/avatar/mouth/mbp.png",
  aa: "/avatar/mouth/aa.png",
  ee: "/avatar/mouth/ee.png",
  oh: "/avatar/mouth/oh.png",
  oo: "/avatar/mouth/oo.png",
  fv: "/avatar/mouth/fv.png",
  sh: "/avatar/mouth/sh.png",
  ldt: "/avatar/mouth/ldt.png",
};

const PRELOAD_ASSETS = [
  ASSET_BY_STATE.idle,
  ASSET_BY_STATE.mbp,
  ASSET_BY_STATE.aa,
  ASSET_BY_STATE.ee,
  ASSET_BY_STATE.oh,
  ASSET_BY_STATE.oo,
  ASSET_BY_STATE.fv,
  ASSET_BY_STATE.sh,
  ASSET_BY_STATE.ldt,
] as const;

export default function Avatar({ state, visemeState }: AvatarProps) {
  const [baseSrc, setBaseSrc] = useState<string>(ASSET_BY_STATE.idle);
  const [mouthSrc, setMouthSrc] = useState<string | null>(null);

  useEffect(() => {
    if (state === "speaking") {
      const nextBase = ASSET_BY_STATE.idle;
      const nextMouth = ASSET_BY_STATE[visemeState ?? "mbp"] ?? ASSET_BY_STATE.mbp;
      setBaseSrc((current) => (current === nextBase ? current : nextBase));
      setMouthSrc((current) => (current === nextMouth ? current : nextMouth));
      return;
    }

    const nextBase = ASSET_BY_STATE[state] ?? ASSET_BY_STATE.idle;
    setBaseSrc((current) => (current === nextBase ? current : nextBase));
    setMouthSrc(null);
  }, [state, visemeState]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    void Promise.all(
      PRELOAD_ASSETS.map(async (source) => {
        const img = new window.Image();
        img.decoding = "sync";
        img.src = source;

        if (typeof img.decode === "function") {
          try {
            await img.decode();
          } catch {
            // Ignore individual decode failures; the browser will still keep the image available.
          }
        }
      }),
    );
  }, []);

  return (
    <div className={`avatar-shell avatar-state-${state}`}>
      <img className="avatar-base" src={baseSrc} alt={`Avatar ${state}`} />
      {mouthSrc && (
        <>
          <img className="avatar-mouth" src={mouthSrc} alt="" aria-hidden="true" />
          <img className="avatar-face-restore" src={ASSET_BY_STATE.idle} alt="" aria-hidden="true" />
        </>
      )}
    </div>
  );
}

