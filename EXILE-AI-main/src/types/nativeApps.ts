/** Shapes returned by the Electron main process for imported native applications. */

export interface NativeAppSupport {
  supported: boolean;
  discovery: boolean;
  manualImport: boolean;
  launch: boolean;
  shortcutImport: boolean;
  /** True when the platform is implemented for development only, not a release target. */
  experimental: boolean;
  executableDescription: string;
}

export type NativeAppAvailability = "available" | "missing" | "inaccessible" | "invalid";

export interface NativeAppView {
  id: string;
  name: string;
  executablePath: string;
  args: string[];
  category: string;
  favorite: boolean;
  source: "manual" | "discovered" | "shortcut";
  addedAt: number;
  lastLaunchedAt: number | null;
  launchCount: number;
  availability: NativeAppAvailability;
  availabilityMessage: string | null;
  /** True only while a process EXILE started is still alive (see limitations in the docs). */
  running: boolean;
  pid: number | null;
  icon: string | null;
}

export interface NativeAppError {
  code: string;
  message: string;
}

export interface NativeAppSnapshot {
  ok: true;
  platform: string;
  support: NativeAppSupport;
  warning: string | null;
  apps: NativeAppView[];
  cancelled?: boolean;
  imported?: string[];
  failed?: { name: string; message: string; duplicate?: boolean }[];
  addedId?: string;
  launched?: boolean;
  alreadyRunning?: boolean;
  pid?: number;
  message?: string;
}

export interface NativeAppFailure {
  ok: false;
  error: NativeAppError;
  status?: NativeAppAvailability;
  duplicateOf?: string;
}

export type NativeAppResult = NativeAppSnapshot | NativeAppFailure;

export interface NativeAppCandidate {
  candidateId: string;
  name: string;
  executablePath: string;
  args: string[];
  alreadyImported: boolean;
}

export type NativeDiscoveryResult =
  | { ok: true; candidates: NativeAppCandidate[]; skipped: { reason: string; count: number }[]; scanned: number }
  | NativeAppFailure;

export interface NativeLaunchHistoryEntry {
  appId: string;
  name: string;
  at: number;
  outcome: "launched" | "failed";
  error: string | null;
}

export type NativeHistoryResult = { ok: true; history: NativeLaunchHistoryEntry[] } | NativeAppFailure;

export interface NativeAppsBridge {
  list: () => Promise<NativeAppResult>;
  discover: () => Promise<NativeDiscoveryResult>;
  importDiscovered: (candidateIds: string[]) => Promise<NativeAppResult>;
  importManual: () => Promise<NativeAppResult>;
  importShortcut: () => Promise<NativeAppResult>;
  update: (
    id: string,
    patch: { name?: string; category?: string; favorite?: boolean; argsText?: string },
  ) => Promise<NativeAppResult>;
  remove: (id: string) => Promise<NativeAppResult>;
  relink: (id: string) => Promise<NativeAppResult>;
  reorder: (orderedIds: string[]) => Promise<NativeAppResult>;
  launch: (id: string) => Promise<NativeAppResult>;
  refresh: () => Promise<NativeAppResult>;
  history: () => Promise<NativeHistoryResult>;
  clearHistory: () => Promise<NativeHistoryResult>;
}
