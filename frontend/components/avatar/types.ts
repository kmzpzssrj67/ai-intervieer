export type AvatarProvider = "local" | "simli";

export type SpeechAbortReason =
  | "user_skip"
  | "user_exit"
  | "component_unmount"
  | "new_utterance"
  | "stale_generation"
  | "transport_closed"
  | "provider_stop"
  | "provider_error"
  | "provider_rate_limit"
  | "idle_expired"
  | "session_expired"
  | "pacing_drift"
  | "recovery_started";

export type SpeakResult =
  | { status: "completed" }
  | { status: "cancelled"; reason: SpeechAbortReason }
  | { status: "recoverable_failure"; reason: SpeechAbortReason | string }
  | { status: "fatal_failure"; reason: SpeechAbortReason | string };

export interface AvatarRendererHandle {
  connect(): Promise<void>;
  speak(audioBlob: Blob, turnId?: string): Promise<SpeakResult>;
  stopSpeaking(): void;
  disconnect(reason?: string): Promise<void>;
}
