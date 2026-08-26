"use client";

import { useEffect, useRef, useState } from "react";

export type AvatarState = "idle" | "speaking" | "listening" | "thinking";

interface AvatarProps {
  state: AvatarState;
}

const CLIP_FILE: Record<AvatarState, string> = {
  idle: "idle.mp4",
  speaking: "speaking.mp4",
  listening: "listening.mp4",
  thinking: "thinking.mp4",
};

const clipSrc = (state: AvatarState) => "/" + encodeURIComponent(CLIP_FILE[state]);
const STATES: AvatarState[] = ["idle", "speaking", "listening", "thinking"];
const SPEAKING_START_SECONDS = 1;
const SPEAKING_END_SECONDS = 3;
const SPEAKING_PLAYBACK_RATE = 0.85;

export default function Avatar({ state }: AvatarProps) {
  const refs = useRef<Record<AvatarState, HTMLVideoElement | null>>({
    idle: null,
    speaking: null,
    listening: null,
    thinking: null,
  });
  const [active, setActive] = useState<AvatarState>(state);
  const [composited, setComposited] = useState<Set<AvatarState>>(() => new Set(["idle", state]));
  const activeRef = useRef<AvatarState>(state);

  function playClip(clip: AvatarState) {
    setComposited((current) => {
      if (current.has(clip)) return current;
      const next = new Set(current);
      next.add(clip);
      return next;
    });

    const video = refs.current[clip];
    try {
      if (clip === "speaking" && video) video.playbackRate = SPEAKING_PLAYBACK_RATE;
      video?.play()?.catch?.(() => {});
    } catch {
      /* autoplay can be blocked during hydration */
    }

    const previous = activeRef.current;
    activeRef.current = clip;
    setActive(clip);

    if (previous && previous !== clip && previous !== "idle") {
      window.setTimeout(() => {
        if (activeRef.current !== previous) {
          try {
            const outgoing = refs.current[previous];
            outgoing?.pause();
            if (outgoing) outgoing.currentTime = 0;
          } catch {
            /* noop */
          }
          setComposited((current) => {
            if (!current.has(previous)) return current;
            const next = new Set(current);
            next.delete(previous);
            return next;
          });
        }
      }, 420);
    }
  }

  useEffect(() => {
    playClip(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    try {
      refs.current.idle?.play?.()?.catch?.(() => {});
    } catch {
      /* noop */
    }
  }, []);

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-md border border-cyan/20 bg-[#08101e] p-6 shadow-2xl">
      <div className="absolute inset-0 bg-black" />
      {STATES.map((clip) => {
        const isIdle = clip === "idle";
        const visible = active === clip || (isIdle && active === "idle");
        const isComposited = isIdle || composited.has(clip);
        const isSpeaking = clip === "speaking";
        return (
          <video
            key={clip}
            ref={(el) => {
              refs.current[clip] = el;
            }}
            src={clipSrc(clip)}
            muted
            playsInline
            preload="auto"
            loop={!isSpeaking}
            onLoadedMetadata={(event) => {
              if (isSpeaking) {
                event.currentTarget.playbackRate = SPEAKING_PLAYBACK_RATE;
                event.currentTarget.currentTime = SPEAKING_START_SECONDS;
              }
            }}
            onTimeUpdate={(event) => {
              if (isSpeaking && event.currentTarget.currentTime >= SPEAKING_END_SECONDS) {
                event.currentTarget.currentTime = SPEAKING_START_SECONDS;
                event.currentTarget.play().catch(() => {});
              }
            }}
            className="absolute inset-0 h-full w-full object-cover"
            style={{
              opacity: visible ? 1 : 0,
              visibility: isComposited ? "visible" : "hidden",
              transition: "opacity 320ms ease",
              zIndex: active === clip ? 20 : isIdle ? 0 : 10,
            }}
          />
        );
      })}
    </div>
  );
}


