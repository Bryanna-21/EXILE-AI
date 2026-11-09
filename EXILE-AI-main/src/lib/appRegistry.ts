/** User-added apps that EXILE can launch (web apps, deep links, local protocols). */

export interface ExileApp {
  id: string;
  name: string;
  url: string;
  emoji: string;
  addedAt: number;
}

const KEY = "exile.apps";

export function listApps(): ExileApp[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function addApp(app: Omit<ExileApp, "id" | "addedAt">): ExileApp {
  const next: ExileApp = { ...app, id: crypto.randomUUID(), addedAt: Date.now() };
  localStorage.setItem(KEY, JSON.stringify([...listApps(), next]));
  return next;
}

export function removeApp(id: string) {
  localStorage.setItem(KEY, JSON.stringify(listApps().filter((a) => a.id !== id)));
}

/** Schemes that can run script or read local files; never opened from a saved link. */
const BLOCKED_SCHEMES = new Set(["javascript", "data", "vbscript", "file", "blob"]);

export function linkProblem(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  if (m && BLOCKED_SCHEMES.has(m[1].toLowerCase())) return `Links that start with "${m[1].toLowerCase()}:" are not allowed.`;
  return null;
}

export function launchApp(app: ExileApp): { ok: boolean; message?: string } {
  const problem = linkProblem(app.url);
  if (problem) return { ok: false, message: problem };
  window.open(app.url, "_blank", "noopener,noreferrer");
  return { ok: true };
}
