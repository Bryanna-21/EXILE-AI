import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Boxes, Download, FileOutput, Loader2, MessageSquare, RefreshCw, Send, Sparkles, Trash2, Wand2, Package,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pill, StateBanner } from "@/components/mission/ui";
import { artifactClient } from "@/lib/artifactClient";
import { describeArtifactError, isFail, type Res } from "@/lib/artifactApi";
import { STAGE_LABEL } from "@/lib/artifactIntent";
import { buildSpec, CONTENT_HINTS, conversionTargets, KIND_TEXT_EDITABLE } from "@/lib/artifactSpec";
import { downloadBlob } from "@/lib/chat/dom";
import { formatBytes } from "@/lib/chat/files";
import type {
  ArtifactCapabilities, ArtifactDetail, ArtifactPreview, ArtifactProgress, ArtifactResult, ArtifactSummary,
} from "@/types/artifacts";

const card = "rounded-xl border border-cyan-500/20 bg-slate-950/60 p-4";
const label = "text-[10px] uppercase tracking-widest text-slate-400";
const select = "h-9 rounded-md border border-cyan-500/30 bg-slate-900 px-2 text-sm text-cyan-100";
const area = "w-full rounded-md border border-cyan-500/30 bg-slate-900 p-2 text-sm text-cyan-50 placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400";

type Mode = "describe" | "content";
type Busy = null | { what: string };

function ProgressLog({ events, running }: { events: ArtifactProgress[]; running: boolean }) {
  if (!events.length) return null;
  return (
    <ol className="space-y-1 text-xs" aria-live="polite" data-testid="artifact-progress">
      {events.map((e, i) => {
        const last = i === events.length - 1;
        const failed = e.stage === "failed";
        return (
          <li key={`${e.t}-${i}`} className={`flex items-center gap-2 ${failed ? "text-red-300" : last && running ? "text-cyan-200" : "text-slate-300"}`}>
            {last && running ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
            <span className="font-medium">{STAGE_LABEL[e.stage] ?? e.stage}</span>
            <span className="truncate text-slate-400">{e.message}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ValidationView({ result }: { result: ArtifactResult }) {
  const v = result.validation;
  if (!v) return null;
  return (
    <details className="text-xs text-slate-300" open={!v.passed}>
      <summary className="cursor-pointer text-cyan-200">{v.passed ? `Verified: ${v.checks.length} checks passed` : `Failed ${v.failures.length} check${v.failures.length === 1 ? "" : "s"}`}</summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {v.checks.map((c) => <li key={c}>{c}</li>)}
        {v.failures.map((c) => <li key={c} className="text-red-300">{c}</li>)}
      </ul>
      {v.skipped.length > 0 && (
        <p className="mt-1 text-amber-200/90">Not checked on this computer: {v.skipped.join("; ")}.</p>
      )}
    </details>
  );
}

function PreviewView({ id, version, refreshKey }: { id: string; version?: number; refreshKey: number }) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    setPreview(null); setUrl(null); setError(null);
    (async () => {
      const p = await artifactClient.preview(id, version);
      if (!live) return;
      if (isFail(p)) return setError(p.error);
      setPreview(p.value);
      if (["image", "pdf", "audio", "video"].includes(p.value.kind)) {
        const d = await artifactClient.download(id, version);
        if (!live) return;
        if (isFail(d)) return setError(d.error);
        objectUrl = URL.createObjectURL(d.value.blob);
        setUrl(objectUrl);
      }
    })();
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, version, refreshKey]);

  if (error) return <StateBanner tone="bad" title="Preview unavailable">{error}</StateBanner>;
  if (!preview) return <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="h-3 w-3 animate-spin" /> Loading preview…</div>;
  if (preview.kind === "image" && url) return <img src={url} alt={preview.name} className="max-h-80 w-auto rounded border border-cyan-500/20 bg-white/5" />;
  if (preview.kind === "pdf" && url) return <iframe src={url} title={`Preview of ${preview.name}`} className="h-[55vh] w-full rounded border border-cyan-500/20 bg-white" />;
  if (preview.kind === "audio" && url) return <audio controls src={url} className="w-full" />;
  if (preview.kind === "video" && url) return <video controls src={url} className="max-h-80 w-full rounded bg-black" />;
  if (preview.kind === "text" || preview.kind === "html") {
    return <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border border-cyan-500/20 bg-slate-900 p-3 text-xs text-slate-200">{preview.text}{preview.truncated ? "\n… (truncated)" : ""}</pre>;
  }
  if (preview.kind === "table") {
    return (
      <div className="space-y-3">
        {(preview.sheets ?? []).map((s) => (
          <div key={s.name}>
            <div className={label}>{s.name} · {s.totalRows} rows</div>
            <div className="max-h-64 overflow-auto rounded border border-cyan-500/20">
              <table className="min-w-full text-xs text-slate-200">
                <tbody>{s.rows.map((r, i) => <tr key={i} className={i === 0 ? "bg-cyan-500/10 font-medium" : "border-t border-slate-800"}>{r.map((c, j) => <td key={j} className="px-2 py-1">{c}</td>)}</tr>)}</tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (preview.kind === "slides") {
    return <ol className="max-h-72 list-decimal space-y-1 overflow-auto pl-5 text-xs text-slate-200">{(preview.slides ?? []).map((s, i) => <li key={i}>{s}</li>)}</ol>;
  }
  if (preview.kind === "archive") {
    return <ul className="max-h-64 overflow-auto text-xs text-slate-200">{(preview.entries ?? []).map((e) => <li key={e.path} className="flex justify-between gap-3 border-b border-slate-800 py-0.5"><span className="truncate">{e.path}</span><span className="text-slate-400">{formatBytes(e.sizeBytes)}</span></li>)}</ul>;
  }
  return <p className="text-xs text-slate-400">No preview for this file type.</p>;
}

const ArtifactsSection = () => {
  const [caps, setCaps] = useState<ArtifactCapabilities | null>(null);
  const [capsError, setCapsError] = useState<{ kind: string; error: string } | null>(null);
  const [items, setItems] = useState<ArtifactSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [previewVersion, setPreviewVersion] = useState<number | undefined>();
  const [previewKey, setPreviewKey] = useState(0);

  const [mode, setMode] = useState<Mode>("describe");
  const [format, setFormat] = useState("pdf");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [events, setEvents] = useState<ArtifactProgress[]>([]);
  const [failure, setFailure] = useState<{ error: string; result?: ArtifactResult } | null>(null);
  const [lastResult, setLastResult] = useState<ArtifactResult | null>(null);

  const [editText, setEditText] = useState("");
  const [opText, setOpText] = useState("");
  const [opNum, setOpNum] = useState("");
  const [opNum2, setOpNum2] = useState("");
  const [phone, setPhone] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deliveryNote, setDeliveryNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const runId = useRef(0);

  const loadAll = useCallback(async () => {
    const c = await artifactClient.capabilities();
    if (isFail(c)) { setCaps(null); setCapsError({ kind: c.kind, error: c.error }); return; }
    setCaps(c.value); setCapsError(null);
    const l = await artifactClient.list();
    if (!isFail(l)) setItems(l.value);
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  useEffect(() => {
    setConfirmDelete(false); setDeliveryNote(null); setPreviewVersion(undefined);
    if (!selected) { setDetail(null); return; }
    let live = true;
    artifactClient.describe(selected).then((d) => { if (live && !isFail(d)) setDetail(d.value); else if (live) setDetail(null); });
    return () => { live = false; };
  }, [selected, items]);

  const available = useMemo(() => (caps?.formats ?? []).filter((f) => f.available), [caps]);
  const unavailable = useMemo(() => (caps?.formats ?? []).filter((f) => !f.available), [caps]);
  const hasTextProvider = (caps?.providers.text.providers.length ?? 0) > 0;

  /** Runs one pipeline call, showing only the events the server really emitted. */
  const run = async (what: string, call: (onProgress: (p: ArtifactProgress) => void) => Promise<Res<ArtifactResult>>) => {
    const id = ++runId.current;
    setBusy({ what }); setEvents([]); setFailure(null); setLastResult(null);
    const r = await call((p) => { if (runId.current === id) setEvents((prev) => [...prev, p]); });
    if (runId.current !== id) return null;
    setBusy(null);
    if (!isFail(r)) {
      setLastResult(r.value);
      toast.success(`${r.value.name} is ready and verified.`);
      await loadAll();
      if (r.value.artifactId) setSelected(r.value.artifactId);
      setPreviewKey((k) => k + 1);
      return r.value;
    }
    setFailure({ error: r.error || describeArtifactError(r.kind as never), result: r.result });
    return null;
  };

  const create = async () => {
    if (mode === "describe") {
      if (!text.trim()) return toast.error("Describe what you want first.");
      await run("Creating", (cb) => artifactClient.create({ format, prompt: text.trim(), ...(title.trim() ? { name: title.trim() } : {}) }, cb));
    } else {
      const spec = buildSpec(format, text, title);
      if (spec.error) return toast.error(spec.error);
      await run("Creating", (cb) => artifactClient.create({ format, spec: spec.spec, name: title.trim() || undefined }, cb));
    }
  };

  const download = async (id: string, version?: number) => {
    const d = await artifactClient.download(id, version);
    if (isFail(d)) return toast.error(d.error);
    downloadBlob(d.value.blob, d.value.name);
  };

  const applyOps = (operations: unknown[]) => selected && run("Editing", (cb) => artifactClient.edit(selected, { operations }, cb));

  const sendWhatsApp = async () => {
    if (!detail || !phone.trim()) return toast.error("Enter a WhatsApp number first.");
    setDeliveryNote(null);
    setBusy({ what: "Sending" });
    const r = await artifactClient.deliver(detail.artifactId, { to: phone.trim(), caption: `Here is ${detail.name}` });
    setBusy(null);
    if (!isFail(r) && r.value.state === "sent") setDeliveryNote({ tone: "ok", text: "WhatsApp confirmed the attachment was sent." });
    else setDeliveryNote({ tone: "bad", text: `${isFail(r) ? r.error : "Not delivered"}. The file is still saved here.` });
    await loadAll();
  };

  const remove = async () => {
    if (!detail) return;
    const r = await artifactClient.remove(detail.artifactId);
    if (isFail(r)) return toast.error(r.error);
    toast.success("Artifact deleted.");
    setSelected(null); setConfirmDelete(false);
    await loadAll();
  };

  const kind = detail?.kind;
  const targets = detail ? conversionTargets(detail.format).filter((f) => caps?.formats.find((x) => x.format === f)?.available) : [];

  return (
    <div className="space-y-5 p-4 sm:p-6" data-testid="artifacts-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-wide text-cyan-100"><Boxes className="h-5 w-5 text-cyan-300" /> ARTIFACTS</h2>
          <p className="mt-1 text-sm text-slate-400">Real files, made, checked and stored on this computer. Nothing is reported as made until it passed its checks.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void loadAll()}><RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh</Button>
      </div>

      {capsError && (
        <StateBanner tone="bad" title={capsError.kind === "disconnected" ? "EXILE local service not reachable" : "Artifact service error"}
          action={<Button size="sm" variant="outline" onClick={() => void loadAll()}>Retry</Button>}>
          {capsError.error} Start it with <code>npm run local</code> (or run local/run.sh / run.bat), then retry.
        </StateBanner>
      )}

      {caps && (
        <div className={card}>
          <div className="mb-3 grid gap-3 sm:grid-cols-[auto_1fr_auto]">
            <div className="flex items-end gap-2">
              <div>
                <div className={label}>Mode</div>
                <div className="mt-1 inline-flex overflow-hidden rounded-md border border-cyan-500/30" role="tablist">
                  {(["describe", "content"] as Mode[]).map((m) => (
                    <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
                      className={`h-9 px-3 text-sm ${mode === m ? "bg-cyan-500/20 text-cyan-100" : "text-slate-400 hover:bg-white/5"}`}>
                      {m === "describe" ? "Describe it" : "Paste content"}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className={label} htmlFor="artifact-format">Format</label>
                <div><select id="artifact-format" className={`${select} mt-1`} value={format} onChange={(e) => setFormat(e.target.value)}>
                  {available.map((f) => <option key={f.format} value={f.format}>{f.label} (.{f.format})</option>)}
                </select></div>
              </div>
            </div>
            <div>
              <label className={label} htmlFor="artifact-title">Name (optional)</label>
              <Input id="artifact-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className="mt-1" placeholder="e.g. term-one-fees" />
            </div>
          </div>
          <label className={label} htmlFor="artifact-text">{mode === "describe" ? "What should it contain?" : "Content"}</label>
          <textarea id="artifact-text" className={`${area} mt-1 min-h-32`} value={text} onChange={(e) => setText(e.target.value)} maxLength={150000}
            placeholder={mode === "describe" ? "e.g. A one-page summary of the Kenyan civil procedure rules on service of summons" : CONTENT_HINTS[format] ?? ""} />
          {mode === "describe" && !hasTextProvider && (
            <p className="mt-2 text-xs text-amber-200">No permitted free-tier AI provider is configured, so “Describe it” can't write content. Add a key on the API page, or use “Paste content”. ({caps.providers.text.policy})</p>
          )}
          {mode === "content" && CONTENT_HINTS[format] && <p className="mt-1 text-[11px] text-slate-400">{CONTENT_HINTS[format]}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button onClick={() => void create()} disabled={!!busy} data-testid="artifact-create">
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />} Create {available.find((f) => f.format === format)?.label ?? ""}
            </Button>
            {unavailable.length > 0 && <span className="text-[11px] text-slate-500">Unavailable here: {unavailable.map((f) => `${f.label} (${f.reason})`).join("; ")}</span>}
          </div>
          <div className="mt-3 space-y-2">
            <ProgressLog events={events} running={!!busy} />
            {failure && (
              <StateBanner tone="bad" title="Nothing was saved">
                {failure.error}
                {failure.result?.validation && <ValidationView result={failure.result} />}
              </StateBanner>
            )}
            {lastResult && !busy && (
              <StateBanner tone="ok" title={`${lastResult.name} · ${formatBytes(lastResult.sizeBytes ?? 0)} · v${lastResult.version}`}>
                <ValidationView result={lastResult} />
              </StateBanner>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className={card}>
          <div className="mb-2 flex items-center justify-between">
            <div className={label}>Saved artifacts ({items.length})</div>
            {checked.size >= 1 && (
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run("Packaging", (cb) => artifactClient.packageArtifacts([...checked], "exile-package", cb)).then(() => setChecked(new Set()))}>
                <Package className="mr-1 h-3.5 w-3.5" /> Package {checked.size}
              </Button>
            )}
          </div>
          {items.length === 0 && <p className="text-sm text-slate-400">Nothing yet. Create a file above, or ask EXILE for one in chat or on WhatsApp.</p>}
          <ul className="max-h-[28rem] space-y-1 overflow-auto">
            {items.map((a) => (
              <li key={a.artifactId} className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${selected === a.artifactId ? "border-cyan-400/60 bg-cyan-500/10" : "border-transparent hover:bg-white/5"}`}>
                <input type="checkbox" aria-label={`Select ${a.name} for packaging`} checked={checked.has(a.artifactId)} onChange={(e) => setChecked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(a.artifactId); else n.delete(a.artifactId); return n; })} />
                <button className="min-w-0 flex-1 text-left" onClick={() => setSelected(a.artifactId)}>
                  <div className="truncate text-sm text-cyan-100" title={a.name}>{a.name}</div>
                  <div className="text-[11px] text-slate-400">{a.format.toUpperCase()} · {formatBytes(a.sizeBytes)} · v{a.version}</div>
                </button>
                {a.deliveries.length > 0 && <Pill tone={a.deliveries[a.deliveries.length - 1].state === "sent" ? "ok" : a.deliveries[a.deliveries.length - 1].state === "failed" ? "bad" : "info"}>{a.deliveries[a.deliveries.length - 1].state}</Pill>}
              </li>
            ))}
          </ul>
        </div>

        <div className={card} data-testid="artifact-detail">
          {!detail && <p className="text-sm text-slate-400">Select an artifact to preview, edit, convert or send it.</p>}
          {detail && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-base text-cyan-100" title={detail.name}>{detail.name}</div>
                  <div className="text-xs text-slate-400">{detail.mimeType} · {formatBytes(detail.sizeBytes)} · version {detail.version} of {detail.versions}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void download(detail.artifactId, previewVersion)}><Download className="mr-1 h-3.5 w-3.5" /> Download</Button>
                  {!confirmDelete
                    ? <Button size="sm" variant="outline" onClick={() => setConfirmDelete(true)}><Trash2 className="mr-1 h-3.5 w-3.5" /> Delete</Button>
                    : <Button size="sm" variant="destructive" onClick={() => void remove()}>Confirm delete</Button>}
                </div>
              </div>

              <PreviewView id={detail.artifactId} version={previewVersion} refreshKey={previewKey} />

              {(detail.versionList?.length ?? 0) > 1 && (
                <div>
                  <div className={label}>Versions</div>
                  <ul className="mt-1 flex flex-wrap gap-2">
                    {detail.versionList!.map((v) => (
                      <li key={v.version}>
                        <button onClick={() => setPreviewVersion(v.version === detail.version ? undefined : v.version)}
                          className={`rounded border px-2 py-0.5 text-xs ${(previewVersion ?? detail.version) === v.version ? "border-cyan-400/60 text-cyan-100" : "border-slate-600 text-slate-300"}`}>
                          v{v.version} · {formatBytes(v.sizeBytes)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                {kind === "image" && detail.format !== "svg" && (
                  <div className="space-y-2">
                    <div className={label}><Wand2 className="mr-1 inline h-3 w-3" />Edit image</div>
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void applyOps([{ op: "grayscale" }])}>Grayscale</Button>
                      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void applyOps([{ op: "enhance" }])}>Enhance</Button>
                      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void applyOps([{ op: "removeBackground", tolerance: 40 }])} title="Works on solid-colour backgrounds only">Remove solid bg</Button>
                    </div>
                    <div className="flex gap-1.5">
                      <Input value={opNum} onChange={(e) => setOpNum(e.target.value)} placeholder="width px" inputMode="numeric" className="h-8" />
                      <Button size="sm" variant="outline" disabled={!!busy || !Number(opNum)} onClick={() => void applyOps([{ op: "resize", width: Number(opNum) }])}>Resize</Button>
                    </div>
                    <div className="flex gap-1.5">
                      <Input value={opText} onChange={(e) => setOpText(e.target.value)} placeholder="watermark text" maxLength={80} className="h-8" />
                      <Button size="sm" variant="outline" disabled={!!busy || !opText.trim()} onClick={() => void applyOps([{ op: "watermark", text: opText.trim() }])}>Add</Button>
                    </div>
                    <Button size="sm" variant="outline" disabled={!!busy} onClick={() => selected && void artifactClient.variations(selected, 3).then(async (r) => { if (!isFail(r)) { toast.success(`${r.value.filter((x) => x.success).length} variations created.`); await loadAll(); } else toast.error(r.error); })}>Make 3 variations</Button>
                  </div>
                )}
                {(kind === "audio" || kind === "video") && (
                  <div className="space-y-2">
                    <div className={label}><Wand2 className="mr-1 inline h-3 w-3" />Edit {kind}</div>
                    <div className="flex gap-1.5">
                      <Input value={opNum} onChange={(e) => setOpNum(e.target.value)} placeholder="start s" inputMode="decimal" className="h-8" />
                      <Input value={opNum2} onChange={(e) => setOpNum2(e.target.value)} placeholder="end s" inputMode="decimal" className="h-8" />
                      <Button size="sm" variant="outline" disabled={!!busy || !opNum2} onClick={() => void applyOps([{ op: "trim", startSec: Number(opNum) || 0, endSec: Number(opNum2) }])}>Trim</Button>
                    </div>
                    {kind === "audio" && (
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void applyOps([{ op: "volume", factor: 0.5 }])}>Quieter</Button>
                        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void applyOps([{ op: "volume", factor: 1.5 }])}>Louder</Button>
                        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void applyOps([{ op: "normalize" }])}>Normalize</Button>
                      </div>
                    )}
                  </div>
                )}
                {kind && KIND_TEXT_EDITABLE.has(kind) && (
                  <div className="space-y-2 sm:col-span-2">
                    <div className={label}><Wand2 className="mr-1 inline h-3 w-3" />Replace content (saves a new version)</div>
                    <textarea className={`${area} min-h-24`} value={editText} onChange={(e) => setEditText(e.target.value)} placeholder={CONTENT_HINTS[detail.format] ?? "New content"} />
                    <Button size="sm" variant="outline" disabled={!!busy} onClick={() => { const s = buildSpec(detail.format, editText); if (s.error) return toast.error(s.error); void run("Editing", (cb) => artifactClient.edit(detail.artifactId, { spec: s.spec }, cb)); }}>Save as new version</Button>
                  </div>
                )}
              </div>

              {targets.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className={label}><FileOutput className="mr-1 inline h-3 w-3" />Convert to</span>
                  {targets.map((t) => <Button key={t} size="sm" variant="outline" disabled={!!busy} onClick={() => void run("Converting", (cb) => artifactClient.convert(detail.artifactId, t, cb))}>{t.toUpperCase()}</Button>)}
                </div>
              )}

              <div className="space-y-2 border-t border-slate-800 pt-3">
                <div className={label}><MessageSquare className="mr-1 inline h-3 w-3" />Send through WhatsApp</div>
                {!detail.whatsappDeliverable ? (
                  <p className="text-xs text-slate-400">WhatsApp can carry images, PDF, Word, Excel, PowerPoint, CSV, text and audio up to 15 MB. Convert this file first to send it.</p>
                ) : (
                  <div className="flex gap-2">
                    <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 2547XXXXXXXX or chat id" className="h-9" aria-label="WhatsApp number" />
                    <Button size="sm" disabled={!!busy} onClick={() => void sendWhatsApp()}><Send className="mr-1 h-3.5 w-3.5" /> Send</Button>
                  </div>
                )}
                {deliveryNote && <StateBanner tone={deliveryNote.tone} title={deliveryNote.tone === "ok" ? "Delivered" : "Not delivered"}>{deliveryNote.text}</StateBanner>}
                {detail.deliveries.length > 0 && (
                  <ul className="space-y-0.5 text-[11px] text-slate-400">
                    {detail.deliveries.slice(-5).map((d) => <li key={d.id}>{new Date(d.queuedAt).toLocaleString()} · {d.channel} · <span className={d.state === "sent" ? "text-emerald-300" : d.state === "failed" ? "text-red-300" : ""}>{d.state}</span>{d.error ? ` — ${d.error}` : ""}</li>)}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ArtifactsSection;
