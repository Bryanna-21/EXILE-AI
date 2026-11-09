/**
 * Renderer-side client for native (desktop) applications.
 *
 * The real work happens in the Electron main process. This module only calls the
 * narrow preload bridge and turns every failure (no bridge, bridge rejected,
 * malformed reply) into a normal { ok:false } result, so the UI never has to
 * handle exceptions or guess whether it is running in the desktop app.
 */

import type {
  NativeAppFailure,
  NativeAppResult,
  NativeAppsBridge,
  NativeAppView,
  NativeDiscoveryResult,
  NativeHistoryResult,
} from "@/types/nativeApps";

export type { NativeAppView } from "@/types/nativeApps";

export const NO_DESKTOP_MESSAGE =
  "Native applications can only be imported and launched in the EXILE desktop app. This browser view cannot start programs on your computer.";

export function getBridge(): NativeAppsBridge | null {
  if (typeof window === "undefined") return null;
  return window.exileDesktop?.nativeApps ?? null;
}

export function nativeAppsAvailable(): boolean {
  return getBridge() !== null;
}

const unavailable = (): NativeAppFailure => ({
  ok: false,
  error: { code: "no-desktop", message: NO_DESKTOP_MESSAGE },
});

const broken = (): NativeAppFailure => ({
  ok: false,
  error: { code: "bridge-error", message: "EXILE could not reach the desktop app. Restart EXILE and try again." },
});

export function isNativeFailure(x: unknown): x is NativeAppFailure {
  return !!x && typeof x === "object" && (x as { ok?: unknown }).ok === false &&
    typeof (x as NativeAppFailure).error?.message === "string";
}

/** Shape check so a malformed reply can never crash the UI. */
function isSnapshot(x: unknown): x is Extract<NativeAppResult, { ok: true }> {
  return !!x && typeof x === "object" && (x as { ok?: unknown }).ok === true && Array.isArray((x as { apps?: unknown }).apps);
}

async function call<T>(fn: (b: NativeAppsBridge) => Promise<T>, check: (x: unknown) => boolean): Promise<T | NativeAppFailure> {
  const bridge = getBridge();
  if (!bridge) return unavailable();
  try {
    const result = await fn(bridge);
    if (isNativeFailure(result) || check(result)) return result;
    return broken();
  } catch {
    return broken();
  }
}

const snapshotCall = (fn: (b: NativeAppsBridge) => Promise<NativeAppResult>) => call<NativeAppResult>(fn, isSnapshot);

export const nativeApps = {
  list: () => snapshotCall((b) => b.list()),
  refresh: () => snapshotCall((b) => b.refresh()),
  discover: () =>
    call<NativeDiscoveryResult>((b) => b.discover(), (x) => !!x && (x as { ok?: boolean }).ok === true && Array.isArray((x as { candidates?: unknown }).candidates)),
  importDiscovered: (ids: string[]) => snapshotCall((b) => b.importDiscovered(ids)),
  importManual: () => snapshotCall((b) => b.importManual()),
  importShortcut: () => snapshotCall((b) => b.importShortcut()),
  update: (id: string, patch: { name?: string; category?: string; favorite?: boolean; argsText?: string }) =>
    snapshotCall((b) => b.update(id, patch)),
  remove: (id: string) => snapshotCall((b) => b.remove(id)),
  relink: (id: string) => snapshotCall((b) => b.relink(id)),
  reorder: (ids: string[]) => snapshotCall((b) => b.reorder(ids)),
  launch: (id: string) => snapshotCall((b) => b.launch(id)),
  history: () =>
    call<NativeHistoryResult>((b) => b.history(), (x) => !!x && (x as { ok?: boolean }).ok === true && Array.isArray((x as { history?: unknown }).history)),
  clearHistory: () =>
    call<NativeHistoryResult>((b) => b.clearHistory(), (x) => !!x && (x as { ok?: boolean }).ok === true && Array.isArray((x as { history?: unknown }).history)),
};

/* ---------------------------- pure view helpers ---------------------------- */

export type AppFilter = "all" | "favorites" | "running" | "unavailable";

export interface AppQuery {
  search: string;
  category: string; // "" = all categories
  filter: AppFilter;
}

/** Search, category and quick filters. Order of the input (the user's own order) is preserved. */
export function filterApps(apps: NativeAppView[], q: AppQuery): NativeAppView[] {
  const needle = q.search.trim().toLowerCase();
  return apps.filter((a) => {
    if (needle) {
      const hay = `${a.name} ${a.category} ${a.executablePath}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    if (q.category && a.category !== q.category) return false;
    if (q.filter === "favorites" && !a.favorite) return false;
    if (q.filter === "running" && !a.running) return false;
    if (q.filter === "unavailable" && a.availability === "available") return false;
    return true;
  });
}

export function categoriesOf(apps: NativeAppView[]): string[] {
  return [...new Set(apps.map((a) => a.category).filter(Boolean))].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: "base" }));
}

/** Move one id by `delta` positions within the full ordered id list. Out-of-range moves are no-ops. */
export function moveId(ids: string[], id: string, delta: number): string[] {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length || delta === 0) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** Render stored argv back to the text form the editor and parser use (quotes only when needed). */
export function argsToText(args: string[]): string {
  return args.map((a) => (a === "" || /[\s"]/.test(a) ? `"${a.replace(/"/g, "")}"` : a)).join(" ");
}

export type AppStatusTone = "ok" | "warn" | "bad" | "idle";

export function describeStatus(a: NativeAppView): { label: string; tone: AppStatusTone; detail: string | null } {
  if (a.availability === "missing") return { label: "Missing", tone: "bad", detail: a.availabilityMessage };
  if (a.availability === "inaccessible") return { label: "Unreadable", tone: "bad", detail: a.availabilityMessage };
  if (a.availability === "invalid") return { label: "Not allowed", tone: "bad", detail: a.availabilityMessage };
  if (a.running) {
    return { label: "Running", tone: "ok", detail: "Started by EXILE and still running. Programs that hand off to another process may show as stopped while their window is open." };
  }
  return { label: "Not running", tone: "idle", detail: "EXILE can only tell whether a program it started is still running." };
}
