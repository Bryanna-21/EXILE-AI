import type { NativeAppsBridge } from "./nativeApps";

export {};

declare global {
  interface Window {
    exileDesktop?: {
      openDashboard: () => void;
      minimizeCompanion: () => void;
      closeCompanion: () => void;
      synthesizeVenom: (text: string, profileId?: "jarvis" | "venom") => Promise<string | null>;
      /** Present only in desktop builds that include native application support. */
      nativeApps?: NativeAppsBridge;
    };
  }
}
