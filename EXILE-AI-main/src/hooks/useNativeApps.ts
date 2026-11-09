import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { isNativeFailure, nativeApps, nativeAppsAvailable } from "@/lib/nativeApps";
import { closeTab, loadTabs, moveTab, openTab, sanitizeTabs, saveTabs } from "@/lib/appTabs";
import type {
  NativeAppCandidate,
  NativeAppResult,
  NativeAppSupport,
  NativeAppView,
  NativeLaunchHistoryEntry,
} from "@/types/nativeApps";

const POLL_MS = 5000;

export interface DiscoveryState {
  candidates: NativeAppCandidate[];
  skipped: { reason: string; count: number }[];
  scanned: number;
}

export function useNativeApps() {
  const available = nativeAppsAvailable();
  const [apps, setApps] = useState<NativeAppView[]>([]);
  const [support, setSupport] = useState<NativeAppSupport | null>(null);
  const [platform, setPlatform] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(available);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // app id or "global"
  const [history, setHistory] = useState<NativeLaunchHistoryEntry[]>([]);
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null);
  const [tabs, setTabs] = useState<string[]>(() => loadTabs());
  const mounted = useRef(true);

  const apply = useCallback((r: NativeAppResult) => {
    if (!mounted.current) return;
    if (isNativeFailure(r)) return;
    setApps(r.apps);
    setSupport(r.support);
    setPlatform(r.platform);
    setWarning(r.warning);
    setError(null);
    setTabs((t) => {
      const next = sanitizeTabs(t, r.apps.map((a) => a.id));
      return next.length === t.length ? t : next;
    });
  }, []);

  const failure = (r: NativeAppResult): string | null => (isNativeFailure(r) ? r.error.message : null);

  const reload = useCallback(async (quiet = false) => {
    if (!available) return;
    const r = await nativeApps.list();
    if (!mounted.current) return;
    const msg = failure(r);
    if (msg) {
      if (!quiet) setError(msg);
    } else apply(r);
    setLoading(false);
  }, [apply, available]);

  const loadHistory = useCallback(async () => {
    const r = await nativeApps.history();
    if (mounted.current && !isNativeFailure(r)) setHistory(r.history);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    void loadHistory();
    return () => {
      mounted.current = false;
    };
  }, [reload, loadHistory]);

  // Poll while visible so the running indicator stays honest.
  useEffect(() => {
    if (!available) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void reload(true);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [available, reload]);

  // Persist tabs (only once real apps are known, so an empty first load never wipes them).
  useEffect(() => {
    if (!loading && available) saveTabs(tabs);
  }, [tabs, loading, available]);

  /** Runs a mutation, applies the returned snapshot, reports a failure once. */
  const run = useCallback(
    async (key: string, fn: () => Promise<NativeAppResult>, success?: (r: Extract<NativeAppResult, { ok: true }>) => string | null) => {
      setBusy(key);
      const r = await fn();
      if (!mounted.current) return r;
      setBusy(null);
      const msg = failure(r);
      if (msg) {
        toast.error(msg);
        return r;
      }
      apply(r);
      if (!isNativeFailure(r)) {
        if (r.cancelled) return r;
        const text = success ? success(r) : null;
        if (text) toast.success(text);
      }
      return r;
    },
    [apply],
  );

  const launch = useCallback(
    async (id: string) => {
      const r = await run(id, () => nativeApps.launch(id), (s) => s.message ?? "Started.");
      if (!isNativeFailure(r) && !r.cancelled) setTabs((t) => openTab(t, id));
      void loadHistory();
      return r;
    },
    [run, loadHistory],
  );

  const importManual = useCallback(
    () => run("global", () => nativeApps.importManual(), () => "Program added. It was not started."),
    [run],
  );
  const importShortcut = useCallback(
    () => run("global", () => nativeApps.importShortcut(), () => "Shortcut imported. Its program was not started."),
    [run],
  );
  const refresh = useCallback(
    () => run("global", () => nativeApps.refresh(), () => "Checked every program path."),
    [run],
  );
  const update = useCallback(
    (id: string, patch: { name?: string; category?: string; favorite?: boolean; argsText?: string }) =>
      run(id, () => nativeApps.update(id, patch), () => (patch.favorite === undefined ? "Saved." : null)),
    [run],
  );
  const remove = useCallback(
    async (id: string) => {
      const r = await run(id, () => nativeApps.remove(id), () => "Removed from EXILE. The program itself was not touched.");
      setTabs((t) => closeTab(t, id));
      return r;
    },
    [run],
  );
  const relink = useCallback((id: string) => run(id, () => nativeApps.relink(id), () => "Program path updated."), [run]);
  const reorder = useCallback((ids: string[]) => run("global", () => nativeApps.reorder(ids)), [run]);

  const discover = useCallback(async () => {
    setBusy("global");
    const r = await nativeApps.discover();
    if (!mounted.current) return;
    setBusy(null);
    if (isNativeFailure(r)) {
      toast.error(r.error.message);
      return;
    }
    setDiscovery({ candidates: r.candidates, skipped: r.skipped, scanned: r.scanned });
  }, []);

  const importDiscovered = useCallback(
    async (ids: string[]) => {
      const r = await run("global", () => nativeApps.importDiscovered(ids), (s) => {
        const added = s.imported?.length ?? 0;
        const failed = s.failed?.length ?? 0;
        return `Added ${added} program${added === 1 ? "" : "s"}${failed ? `; ${failed} skipped` : ""}. None were started.`;
      });
      if (!isNativeFailure(r)) setDiscovery(null);
      return r;
    },
    [run],
  );

  const clearHistory = useCallback(async () => {
    const r = await nativeApps.clearHistory();
    if (!mounted.current) return;
    if (isNativeFailure(r)) toast.error(r.error.message);
    else setHistory(r.history);
  }, []);

  const closeDiscovery = useCallback(() => setDiscovery(null), []);
  const openTabFor = useCallback((id: string) => setTabs((t) => openTab(t, id)), []);
  const closeTabFor = useCallback((id: string) => setTabs((t) => closeTab(t, id)), []);
  const moveTabFor = useCallback((id: string, delta: number) => setTabs((t) => moveTab(t, id, delta)), []);

  const byId = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);

  return {
    available, apps, byId, support, platform, warning, loading, error, busy, history, discovery, tabs,
    reload, launch, importManual, importShortcut, refresh, update, remove, relink, reorder,
    discover, importDiscovered, closeDiscovery, clearHistory, loadHistory, openTabFor, closeTabFor, moveTabFor,
  };
}
