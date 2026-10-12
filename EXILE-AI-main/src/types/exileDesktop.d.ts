export {};

declare global {
  interface Window {
    exileDesktop?: {
      openDashboard: () => void;
      minimizeCompanion: () => void;
      closeCompanion: () => void;
      synthesizeVenom: (text: string) => Promise<string | null>;
    };
  }
}
