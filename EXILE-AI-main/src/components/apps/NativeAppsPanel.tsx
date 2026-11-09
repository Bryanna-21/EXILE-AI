import { useMemo, useState } from "react";
import {
  AppWindow, ArrowDown, ArrowUp, FolderOpen, History, Link2, Pencil, Play, RefreshCw, Search, Star, Trash2, X, Link as LinkIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Pill, StateBanner } from "@/components/mission/ui";
import { useNativeApps } from "@/hooks/useNativeApps";
import { NO_DESKTOP_MESSAGE, argsToText, isNativeFailure, categoriesOf, describeStatus, filterApps, moveId, type AppFilter } from "@/lib/nativeApps";
import type { NativeAppView } from "@/types/nativeApps";

const FILTERS: { id: AppFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "favorites", label: "Favorites" },
  { id: "running", label: "Running" },
  { id: "unavailable", label: "Unavailable" },
];

const OUTLINE = "border-cyan-500/40 bg-transparent text-cyan-100 hover:bg-cyan-500/10 hover:text-cyan-50 disabled:opacity-40";

const safeIcon = (icon: string | null) => (icon && /^data:image\/(png|jpeg|webp);base64,/i.test(icon) ? icon : null);

const AppIcon = ({ app, size = 28 }: { app: NativeAppView; size?: number }) => {
  const src = safeIcon(app.icon);
  return src ? (
    <img src={src} alt="" width={size} height={size} className="rounded shrink-0" />
  ) : (
    <AppWindow className="shrink-0 text-cyan-300/70" style={{ width: size, height: size }} />
  );
};

const NativeAppsPanel = () => {
  const n = useNativeApps();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [filter, setFilter] = useState<AppFilter>("all");
  const [editing, setEditing] = useState<NativeAppView | null>(null);
  const [form, setForm] = useState({ name: "", category: "", argsText: "" });
  const [removing, setRemoving] = useState<NativeAppView | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showHistory, setShowHistory] = useState(false);

  const categories = useMemo(() => categoriesOf(n.apps), [n.apps]);
  const shown = useMemo(() => filterApps(n.apps, { search, category, filter }), [n.apps, search, category, filter]);
  const allIds = useMemo(() => n.apps.map((a) => a.id), [n.apps]);
  const canAct = n.available && !!n.support?.supported;
  const filtering = search.trim() !== "" || category !== "" || filter !== "all";

  if (!n.available) {
    return (
      <StateBanner tone="info" title="Desktop app required">
        {NO_DESKTOP_MESSAGE} Web links still work in the “Web links” tab.
      </StateBanner>
    );
  }
  if (n.loading) return <p className="text-xs text-cyan-300/70" role="status">Loading your programs…</p>;

  const openEdit = (a: NativeAppView) => {
    setEditing(a);
    setForm({ name: a.name, category: a.category, argsText: argsToText(a.args) });
  };

  const saveEdit = async () => {
    if (!editing) return;
    const patch: { name?: string; category?: string; argsText?: string } = {};
    if (form.name !== editing.name) patch.name = form.name;
    if (form.category !== editing.category) patch.category = form.category;
    if (form.argsText !== argsToText(editing.args)) patch.argsText = form.argsText;
    if (Object.keys(patch).length === 0) return setEditing(null);
    const r = await n.update(editing.id, patch);
    if (!isNativeFailure(r) && !r.cancelled) setEditing(null);
  };

  const tabApps = n.tabs.map((id) => n.byId.get(id)).filter((a): a is NativeAppView => !!a);

  return (
    <div className="space-y-4">
      {n.support && !n.support.supported && (
        <StateBanner tone="warn" title="This operating system is not supported yet">
          EXILE can import and launch programs on Windows. {n.platform ? `Detected: ${n.platform}.` : ""} Nothing here can start programs on this system.
        </StateBanner>
      )}
      {n.support?.supported && n.support.experimental && (
        <StateBanner tone="warn" title="Experimental on this system">
          Only manual import is available here, and it has not been verified on a real {n.platform} desktop. Windows is the supported platform.
        </StateBanner>
      )}
      {n.warning && <StateBanner tone="warn" title="Saved list">{n.warning}</StateBanner>}
      {n.error && <StateBanner tone="bad" title="Could not load programs" action={<Button size="sm" variant="outline" className={OUTLINE} onClick={() => void n.reload()}>Retry</Button>}>{n.error}</StateBanner>}

      <p className="text-[11px] text-cyan-300/70">
        Programs open in their own windows outside EXILE; they are not embedded here. EXILE reads shortcuts and file locations
        but never starts a program until you press Launch.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" className={OUTLINE} disabled={!canAct || !n.support?.discovery || n.busy === "global"} onClick={() => void n.discover()}>
          <Search className="w-3.5 h-3.5 mr-1.5" /> Find installed programs
        </Button>
        <Button size="sm" variant="outline" className={OUTLINE} disabled={!canAct || !n.support?.manualImport || n.busy === "global"} onClick={() => void n.importManual()}>
          <FolderOpen className="w-3.5 h-3.5 mr-1.5" /> Browse for program…
        </Button>
        <Button size="sm" variant="outline" className={OUTLINE} disabled={!canAct || !n.support?.shortcutImport || n.busy === "global"} onClick={() => void n.importShortcut()}>
          <Link2 className="w-3.5 h-3.5 mr-1.5" /> Import shortcut…
        </Button>
        <Button size="sm" variant="outline" className={OUTLINE} disabled={n.busy === "global"} onClick={() => void n.refresh()}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Check paths
        </Button>
      </div>

      {tabApps.length > 0 && (
        <section aria-label="Open applications" className="rounded-md border border-cyan-500/25 bg-slate-900/50 p-2">
          <div className="text-[10px] tracking-widest uppercase text-cyan-500/70 mb-1.5">Open applications</div>
          <ul className="flex flex-wrap gap-1.5">
            {tabApps.map((a) => {
              const st = describeStatus(a);
              return (
                <li key={a.id} className="flex items-center gap-1 rounded border border-cyan-500/30 bg-slate-950/60 pl-1.5 pr-0.5 py-0.5">
                  <AppIcon app={a} size={14} />
                  <span className="text-[11px] text-cyan-100 max-w-[9rem] truncate">{a.name}</span>
                  <Pill tone={st.tone === "bad" ? "bad" : st.tone === "ok" ? "ok" : "idle"} title={st.detail ?? undefined}>{st.label}</Pill>
                  <button aria-label={`Move ${a.name} tab left`} className="p-0.5 text-cyan-400/70 hover:text-cyan-200" onClick={() => n.moveTabFor(a.id, -1)}><ArrowUp className="w-3 h-3 -rotate-90" /></button>
                  <button aria-label={`Move ${a.name} tab right`} className="p-0.5 text-cyan-400/70 hover:text-cyan-200" onClick={() => n.moveTabFor(a.id, 1)}><ArrowDown className="w-3 h-3 -rotate-90" /></button>
                  <button aria-label={`Launch ${a.name}`} disabled={a.availability !== "available" || a.running || n.busy === a.id} className="p-0.5 text-cyan-300 hover:text-cyan-100 disabled:opacity-40" onClick={() => void n.launch(a.id)}><Play className="w-3 h-3" /></button>
                  <button aria-label={`Close ${a.name} tab`} className="p-0.5 text-slate-400 hover:text-slate-200" onClick={() => n.closeTabFor(a.id)}><X className="w-3 h-3" /></button>
                </li>
              );
            })}
          </ul>
          <p className="text-[10px] text-cyan-400/60 mt-1.5">
            A tab is a shortcut to a program running in its own window. Closing a tab does not close the program.
          </p>
        </section>
      )}

      {n.apps.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search programs" aria-label="Search programs" className="h-8 w-48 bg-slate-950 border-cyan-500/30 text-cyan-100 text-xs" />
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category" className="h-8 rounded-md border border-cyan-500/30 bg-slate-950 px-2 text-xs text-cyan-100">
            <option value="">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <div className="flex gap-1" role="group" aria-label="Quick filters">
            {FILTERS.map((f) => (
              <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
                className={`rounded border px-2 py-1 text-[10px] uppercase tracking-widest ${filter === f.id ? "border-cyan-300/60 bg-cyan-500/20 text-cyan-100" : "border-cyan-500/20 text-cyan-400/70"}`}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {n.apps.length === 0 ? (
        <p className="text-xs text-cyan-400/60">
          No programs yet. Use “Find installed programs” to read your Start Menu shortcuts, or browse for a program or shortcut.
          Nothing is started while importing.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-xs text-cyan-400/60">No programs match your search or filters.</p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((a) => {
            const st = describeStatus(a);
            const unavailable = a.availability !== "available";
            const idx = allIds.indexOf(a.id);
            return (
              <li key={a.id} className={`rounded-md border p-2.5 ${unavailable ? "border-red-400/30 bg-red-500/5" : "border-cyan-500/25 bg-slate-900/50"}`}>
                <div className="flex items-center gap-2.5">
                  <AppIcon app={a} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm text-cyan-100 truncate">{a.name}</span>
                      <Pill tone="info">desktop app</Pill>
                      <Pill tone={st.tone} title={st.detail ?? undefined}>{st.label}</Pill>
                      {a.category && <span className="text-[10px] text-cyan-400/70">{a.category}</span>}
                    </div>
                    <div className="text-[10px] text-cyan-400/60 truncate" title={a.executablePath}>{a.executablePath}</div>
                    {a.args.length > 0 && <div className="text-[10px] text-cyan-400/60 truncate">Arguments: {argsToText(a.args)}</div>}
                    {unavailable && a.availabilityMessage && <div className="text-[11px] text-red-300 mt-0.5">{a.availabilityMessage}</div>}
                    <div className="text-[10px] text-cyan-500/60">
                      {a.launchCount > 0 ? `Launched ${a.launchCount}× · last ${new Date(a.lastLaunchedAt ?? 0).toLocaleString()}` : "Never launched from EXILE"}
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button aria-label={a.favorite ? `Unpin ${a.name}` : `Pin ${a.name}`} aria-pressed={a.favorite} onClick={() => void n.update(a.id, { favorite: !a.favorite })} className="p-1.5 text-amber-300/80 hover:text-amber-200">
                      <Star className="w-4 h-4" fill={a.favorite ? "currentColor" : "none"} />
                    </button>
                    {unavailable ? (
                      <Button size="sm" variant="outline" className={OUTLINE} disabled={n.busy === a.id} onClick={() => void n.relink(a.id)}>
                        <LinkIcon className="w-3.5 h-3.5 mr-1" /> Relink…
                      </Button>
                    ) : (
                      <Button size="sm" disabled={n.busy === a.id || a.running} onClick={() => void n.launch(a.id)} className="bg-cyan-500/20 border border-cyan-400/40 text-cyan-100">
                        <Play className="w-3.5 h-3.5 mr-1" /> {a.running ? "Running" : "Launch"}
                      </Button>
                    )}
                    <button aria-label={`Edit ${a.name}`} onClick={() => openEdit(a)} className="p-1.5 text-cyan-300/80 hover:text-cyan-100"><Pencil className="w-3.5 h-3.5" /></button>
                    {!filtering && (
                      <>
                        <button aria-label={`Move ${a.name} up`} disabled={idx <= 0} onClick={() => void n.reorder(moveId(allIds, a.id, -1))} className="p-1 text-cyan-300/70 disabled:opacity-30"><ArrowUp className="w-3.5 h-3.5" /></button>
                        <button aria-label={`Move ${a.name} down`} disabled={idx >= allIds.length - 1} onClick={() => void n.reorder(moveId(allIds, a.id, 1))} className="p-1 text-cyan-300/70 disabled:opacity-30"><ArrowDown className="w-3.5 h-3.5" /></button>
                      </>
                    )}
                    <button aria-label={`Remove ${a.name}`} onClick={() => setRemoving(a)} className="p-1.5 text-red-300/70 hover:text-red-200"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {filtering && n.apps.length > 0 && <p className="text-[10px] text-cyan-500/60">Reordering is available when no search or filter is active.</p>}

      <section className="rounded-md border border-cyan-500/20 p-2.5">
        <button onClick={() => { setShowHistory((v) => !v); if (!showHistory) void n.loadHistory(); }} className="flex items-center gap-1.5 text-[11px] tracking-widest uppercase text-cyan-400/80" aria-expanded={showHistory}>
          <History className="w-3.5 h-3.5" /> Launch history ({n.history.length})
        </button>
        {showHistory && (
          <div className="mt-2">
            {n.history.length === 0 ? <p className="text-[11px] text-cyan-500/60">No launches yet.</p> : (
              <>
                <ul className="space-y-0.5 max-h-48 overflow-auto">
                  {n.history.map((h, i) => (
                    <li key={`${h.appId}-${h.at}-${i}`} className="text-[11px] text-cyan-200/80 flex gap-2">
                      <span className="text-cyan-500/60 shrink-0">{new Date(h.at).toLocaleString()}</span>
                      <span className="truncate">{h.name}</span>
                      <span className={h.outcome === "launched" ? "text-emerald-300" : "text-red-300"}>{h.outcome === "launched" ? "started" : `failed${h.error ? `: ${h.error}` : ""}`}</span>
                    </li>
                  ))}
                </ul>
                <Button size="sm" variant="ghost" className="mt-1 text-[10px]" onClick={() => void n.clearHistory()}>Clear history</Button>
              </>
            )}
          </div>
        )}
      </section>

      {/* Discovery */}
      <Dialog open={!!n.discovery} onOpenChange={(o) => { if (!o) { n.closeDiscovery(); setPicked(new Set()); } }}>
        <DialogContent className="max-w-lg bg-slate-950 border-cyan-500/30 text-cyan-100">
          <DialogHeader>
            <DialogTitle>Programs found</DialogTitle>
            <DialogDescription>
              Read from Start Menu shortcuts ({n.discovery?.scanned ?? 0} scanned). Nothing was started. Microsoft Store apps are not detected; add those with “Browse for program” if they have an .exe.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-72 overflow-auto space-y-1">
            {n.discovery?.candidates.length === 0 && <p className="text-xs text-cyan-400/60">No new programs were found.</p>}
            {n.discovery?.candidates.map((c) => (
              <label key={c.candidateId} className={`flex items-start gap-2 rounded border border-cyan-500/20 p-2 ${c.alreadyImported ? "opacity-50" : ""}`}>
                <Checkbox
                  checked={c.alreadyImported || picked.has(c.candidateId)}
                  disabled={c.alreadyImported}
                  onCheckedChange={(v) => setPicked((p) => { const next = new Set(p); if (v) next.add(c.candidateId); else next.delete(c.candidateId); return next; })}
                />
                <span className="min-w-0">
                  <span className="block text-xs text-cyan-100 truncate">{c.name}{c.alreadyImported ? " (already added)" : ""}</span>
                  <span className="block text-[10px] text-cyan-400/60 truncate" title={c.executablePath}>{c.executablePath}</span>
                </span>
              </label>
            ))}
            {n.discovery && n.discovery.skipped.length > 0 && (
              <p className="text-[10px] text-cyan-500/60 pt-1">
                Skipped: {n.discovery.skipped.map((s) => `${s.count} ${s.reason}`).join(", ")}.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { n.closeDiscovery(); setPicked(new Set()); }}>Cancel</Button>
            <Button disabled={picked.size === 0 || n.busy === "global"} onClick={async () => { await n.importDiscovered([...picked]); setPicked(new Set()); }}>
              Add {picked.size || ""} selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit */}
      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className="max-w-md bg-slate-950 border-cyan-500/30 text-cyan-100">
          <DialogHeader>
            <DialogTitle>Edit program</DialogTitle>
            <DialogDescription>
              Changing launch arguments asks you to confirm in a separate system window, because arguments control what the program does.
            </DialogDescription>
          </DialogHeader>
          <label className="block text-[11px] text-cyan-300/80">Name
            <Input value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1 bg-slate-900 border-cyan-500/30" />
          </label>
          <label className="block text-[11px] text-cyan-300/80">Category
            <Input value={form.category} maxLength={40} list="native-app-categories" onChange={(e) => setForm({ ...form, category: e.target.value })} className="mt-1 bg-slate-900 border-cyan-500/30" />
            <datalist id="native-app-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label className="block text-[11px] text-cyan-300/80">Arguments
            <Input value={form.argsText} onChange={(e) => setForm({ ...form, argsText: e.target.value })} placeholder='e.g. --profile "Work"' className="mt-1 bg-slate-900 border-cyan-500/30 font-mono text-xs" />
            <span className="text-[10px] text-cyan-500/60">Split on spaces; use double quotes to keep spaces together. Nothing is expanded or run through a shell.</span>
          </label>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={!form.name.trim() || n.busy === editing?.id} onClick={() => void saveEdit()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove */}
      <AlertDialog open={!!removing} onOpenChange={(o) => { if (!o) setRemoving(null); }}>
        <AlertDialogContent className="bg-slate-950 border-cyan-500/30 text-cyan-100">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>It is removed from EXILE only. The program stays installed and is not closed if it is running.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (removing) void n.remove(removing.id); setRemoving(null); }}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default NativeAppsPanel;
