/**
 * Application tabs: the ordered list of native apps the user has opened in EXILE.
 *
 * A tab is a handle for a program that runs in its OWN window outside EXILE; EXILE does not
 * embed native programs. Tabs persist locally across restarts and are always reconciled
 * against the apps that still exist, so a removed app can never leave a dead tab behind.
 */

export const TABS_KEY = "exile.nativeAppTabs.v1";
export const MAX_TABS = 20;

export function sanitizeTabs(raw: unknown, validIds: ReadonlySet<string> | string[]): string[] {
  const valid = validIds instanceof Set ? validIds : new Set(validIds);
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const id of raw) {
    if (typeof id === "string" && valid.has(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_TABS) break;
  }
  return out;
}

export function openTab(tabs: string[], id: string): string[] {
  if (tabs.includes(id)) return tabs;
  return [...tabs, id].slice(-MAX_TABS);
}

export function closeTab(tabs: string[], id: string): string[] {
  return tabs.filter((t) => t !== id);
}

export function moveTab(tabs: string[], id: string, delta: number): string[] {
  const from = tabs.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= tabs.length || delta === 0) return tabs;
  const next = [...tabs];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

export function loadTabs(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): string[] {
  try {
    const raw = storage?.getItem(TABS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, MAX_TABS) : [];
  } catch {
    return [];
  }
}

export function saveTabs(tabs: string[], storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(TABS_KEY, JSON.stringify(tabs.slice(0, MAX_TABS)));
  } catch {
    /* storage unavailable: tabs simply will not persist */
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
