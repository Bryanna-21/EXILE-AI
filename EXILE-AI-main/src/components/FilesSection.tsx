import { useMemo, useState } from "react";
import { Files, FolderOpen, FileText, Image as ImageIcon, Music, Video, Download, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StateBanner } from "@/components/mission/ui";

interface DirHandle {
  name: string;
  entries(): AsyncIterable<[string, { kind: string; getFile(): Promise<File> }]>;
}

interface Item { name: string; size: number; modified: number; type: string; file: File }

const MAX_LISTED = 500;

const iconFor = (type: string) =>
  type.startsWith("image/") ? <ImageIcon className="w-4 h-4 text-emerald-300" /> :
  type.startsWith("audio/") ? <Music className="w-4 h-4 text-purple-300" /> :
  type.startsWith("video/") ? <Video className="w-4 h-4 text-orange-300" /> :
  <FileText className="w-4 h-4 text-cyan-300" />;

const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;

/** Lists files the user chooses from this device. Nothing is uploaded or stored by EXILE. */
const FilesSection = () => {
  const [items, setItems] = useState<Item[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fromFiles = (files: File[]) =>
    files.map((f) => ({ name: f.name, size: f.size, modified: f.lastModified, type: f.type, file: f }));

  const finish = (all: Item[], label: string | null) => {
    setItems(all.slice(0, MAX_LISTED));
    setFolder(label);
    setNote(all.length > MAX_LISTED ? `Showing the first ${MAX_LISTED} of ${all.length} files.` : null);
  };

  const pickFolder = async () => {
    setError(null);
    const picker = (window as unknown as { showDirectoryPicker?: () => Promise<DirHandle> }).showDirectoryPicker;
    if (!picker) {
      setError("This browser cannot open folders directly. Use “Choose files” instead.");
      return;
    }
    try {
      const dir = await picker();
      const out: File[] = [];
      for await (const [, handle] of dir.entries()) {
        if (handle.kind === "file") out.push(await handle.getFile());
        if (out.length > MAX_LISTED + 50) break;
      }
      finish(fromFiles(out), dir.name);
    } catch (e: unknown) {
      if ((e as { name?: string })?.name !== "AbortError") setError("The folder could not be read. Permission may have been denied.");
    }
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => !q || i.name.toLowerCase().includes(q));
  }, [items, query]);

  const open = (i: Item) => {
    const url = URL.createObjectURL(i.file);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const save = (i: Item) => {
    const url = URL.createObjectURL(i.file);
    const a = document.createElement("a");
    a.href = url;
    a.download = i.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div className="p-4 space-y-3 bg-slate-950 text-cyan-100 min-h-[28rem]">
      <div className="flex items-center gap-2">
        <Files className="w-4 h-4 text-cyan-300" />
        <h2 className="text-sm tracking-widest">FILE VAULT</h2>
      </div>
      <p className="text-[11px] text-cyan-400/70">
        Browse files you choose on this computer. EXILE only reads what you pick, keeps nothing, and uploads nothing. It does not store files for you.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void pickFolder()} className="bg-cyan-500/20 border border-cyan-400/40 text-cyan-100">
          <FolderOpen className="w-3.5 h-3.5 mr-1.5" /> Open folder
        </Button>
        <label className="inline-flex items-center cursor-pointer rounded-md border border-cyan-500/40 px-3 py-1.5 text-sm hover:bg-cyan-500/10">
          Choose files
          <input type="file" multiple className="hidden" aria-label="Choose files" onChange={(e) => { finish(fromFiles(Array.from(e.target.files ?? [])), null); e.target.value = ""; }} />
        </label>
      </div>
      {error && <StateBanner tone="warn" title="Could not open">{error}</StateBanner>}
      {items.length > 0 && (
        <>
          <div className="flex items-center gap-2">
            <Search className="w-3.5 h-3.5 text-cyan-400/70" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name" aria-label="Search files" className="h-8 bg-slate-900 border-cyan-500/30 text-cyan-100 text-xs" />
          </div>
          <div className="text-[10px] text-cyan-500/70">{folder ? `Folder: ${folder} · ` : ""}{shown.length} of {items.length} shown{note ? ` · ${note}` : ""}</div>
          <ul className="space-y-1 max-h-72 overflow-auto">
            {shown.map((i, idx) => (
              <li key={`${i.name}-${idx}`} className="flex items-center gap-2 rounded border border-cyan-500/20 bg-slate-900/40 px-2 py-1.5">
                {iconFor(i.type)}
                <span className="flex-1 truncate text-xs">{i.name}</span>
                <span className="text-[10px] text-cyan-500/70 whitespace-nowrap">{formatBytes(i.size)} · {new Date(i.modified).toLocaleDateString()}</span>
                <button onClick={() => open(i)} className="text-[10px] text-cyan-300 hover:text-cyan-100 px-1">Open</button>
                <button onClick={() => save(i)} aria-label={`Download ${i.name}`} className="text-cyan-300 hover:text-cyan-100"><Download className="w-3.5 h-3.5" /></button>
              </li>
            ))}
          </ul>
        </>
      )}
      {items.length === 0 && !error && <p className="text-xs text-cyan-500/60">Nothing opened yet.</p>}
    </div>
  );
};

export default FilesSection;
