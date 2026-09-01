import { LipSyncController } from "./LipSyncController";
import type { AvatarState, Viseme } from "./types";

export type AvatarControllerListener = (state: AvatarState, viseme?: Viseme) => void;

export class AvatarController {
  private lipSyncController: LipSyncController | null = null;
  private listener: AvatarControllerListener | null = null;

  startSpeaking(audioElement: HTMLAudioElement | null, listener: AvatarControllerListener): void {
    this.listener = listener;

    if (!audioElement) {
      this.stopSpeaking();
      return;
    }

    if (!this.lipSyncController) {
      this.lipSyncController = new LipSyncController();
    }

    this.lipSyncController.attach(audioElement, (viseme) => {
      console.log("[Avatar] Frame:", viseme);
      listener("speaking", viseme);
    });

    console.log("[Avatar] State: SPEAKING");
  }

  stopSpeaking(): void {
    this.lipSyncController?.stop();
    console.log("[Avatar] Audio ended");
    this.listener?.("idle");
  }

  dispose(): void {
    this.lipSyncController?.dispose();
    this.lipSyncController = null;
  }
}
