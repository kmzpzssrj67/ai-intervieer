export type AvatarState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "mbp"
  | "aa"
  | "ee"
  | "oh"
  | "oo"
  | "fv"
  | "sh"
  | "ldt";

export type Viseme = "rest" | "closed" | "open" | "wide" | "round";

export interface VisemeEvent {
  time: number;
  viseme: Viseme;
}
