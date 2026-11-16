/**
 * Durable storage for chat attachments and generated images.
 *
 * Text lives in localStorage; media is too large for it, so it goes to IndexedDB (Blobs are stored
 * natively, no base64 inflation). If IndexedDB is unavailable (private mode, blocked, old WebView) the
 * store falls back to memory and reports `durable: false` so the UI can be honest about it.
 *
 * Records are keyed by (scope, messageId). `scope` isolates data between operators/profiles that share a
 * browser profile; the app currently uses a single device scope (see docs/phase4-chat-completion.md).
 */

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: string;
  file?: Blob;
  dataUrl?: string;
  text?: string;
  origin: "attached" | "generated";
  prompt?: string;
}

export interface MediaRecord {
  id: string;
  at: number;
  bytes: number;
  files: StoredFile[];
}

export const MAX_SCOPE_BYTES = 150 * 1024 * 1024;

export function recordBytes(files: StoredFile[]): number {
  return files.reduce((n, f) => n + (f.file?.size ?? 0) + (f.dataUrl?.length ?? 0) + (f.text?.length ?? 0) * 2, 0);
}

/**
 * Which existing records to evict (oldest first) so `incoming` fits under `limit`.
 * Returns null when the incoming record alone exceeds the limit (it must be rejected, not stored).
 */
export function planEviction(
  existing: Array<{ id: string; at: number; bytes: number }>,
  incoming: { id: string; bytes: number },
  limit = MAX_SCOPE_BYTES,
): string[] | null {
  if (incoming.bytes > limit) return null;
  const others = existing.filter((r) => r.id !== incoming.id).sort((a, b) => a.at - b.at);
  let total = others.reduce((n, r) => n + r.bytes, 0) + incoming.bytes;
  const evict: string[] = [];
  for (const r of others) {
    if (total <= limit) break;
    evict.push(r.id);
    total -= r.bytes;
  }
  return evict;
}

export interface PutResult {
  stored: boolean;
  evicted: string[];
  reason?: "too-large" | "error";
}

export interface MediaBackend {
  readonly kind: "indexeddb" | "memory";
  put(scope: string, id: string, files: StoredFile[], now?: number): Promise<PutResult>;
  getMany(scope: string, ids: string[]): Promise<MediaRecord[]>;
  delete(scope: string, ids: string[]): Promise<void>;
  clearScope(scope: string): Promise<void>;
}

export function createMemoryBackend(limit = MAX_SCOPE_BYTES): MediaBackend {
  const data = new Map<string, Map<string, MediaRecord>>();
  const bucket = (scope: string) => data.get(scope) ?? data.set(scope, new Map()).get(scope)!;
  return {
    kind: "memory",
    async put(scope, id, files, now = Date.now()) {
      const b = bucket(scope);
      const bytes = recordBytes(files);
      const plan = planEviction([...b.values()], { id, bytes }, limit);
      if (!plan) return { stored: false, evicted: [], reason: "too-large" };
      plan.forEach((e) => b.delete(e));
      b.set(id, { id, at: now, bytes, files });
      return { stored: true, evicted: plan };
    },
    async getMany(scope, ids) {
      const b = bucket(scope);
      return ids.map((i) => b.get(i)).filter((r): r is MediaRecord => !!r);
    },
    async delete(scope, ids) { const b = bucket(scope); ids.forEach((i) => b.delete(i)); },
    async clearScope(scope) { data.delete(scope); },
  };
}

const STORE = "media";
const req = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error ?? new Error("transaction aborted")); });

export function createIndexedDbBackend(factory: IDBFactory, name = "exile-chat-media", limit = MAX_SCOPE_BYTES): MediaBackend {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const open = () => (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(name, 1);
    r.onupgradeneeded = () => {
      const store = r.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("scope", "scope");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { dbPromise = null; reject(r.error); };
    r.onblocked = () => { dbPromise = null; reject(new Error("IndexedDB open blocked")); };
  }));
  const key = (scope: string, id: string) => `${scope}\u0000${id}`;
  return {
    kind: "indexeddb",
    async put(scope, id, files, now = Date.now()) {
      try {
        const db = await open();
        const bytes = recordBytes(files);
        const all = (await req(db.transaction(STORE).objectStore(STORE).index("scope").getAll(scope))) as Array<MediaRecord & { key: string }>;
        const plan = planEviction(all, { id, bytes }, limit);
        if (!plan) return { stored: false, evicted: [], reason: "too-large" };
        const tx = db.transaction(STORE, "readwrite");
        const s = tx.objectStore(STORE);
        plan.forEach((e) => s.delete(key(scope, e)));
        s.put({ key: key(scope, id), scope, id, at: now, bytes, files });
        await done(tx);
        return { stored: true, evicted: plan };
      } catch {
        return { stored: false, evicted: [], reason: "error" };
      }
    },
    async getMany(scope, ids) {
      const db = await open();
      const s = db.transaction(STORE).objectStore(STORE);
      const rows = await Promise.all(ids.map((i) => req(s.get(key(scope, i))) as Promise<(MediaRecord & { key: string }) | undefined>));
      return rows.filter((r): r is MediaRecord & { key: string } => !!r);
    },
    async delete(scope, ids) {
      const db = await open();
      const tx = db.transaction(STORE, "readwrite");
      ids.forEach((i) => tx.objectStore(STORE).delete(key(scope, i)));
      await done(tx);
    },
    async clearScope(scope) {
      const db = await open();
      const tx = db.transaction(STORE, "readwrite");
      const s = tx.objectStore(STORE);
      const keys = (await req(s.index("scope").getAllKeys(scope))) as IDBValidKey[];
      keys.forEach((k) => s.delete(k));
      await done(tx);
    },
  };
}

/** IndexedDB if it works here, otherwise memory. Probes with a real open so a blocked DB is detected up front. */
export async function openBestBackend(factory: IDBFactory | undefined, name?: string): Promise<MediaBackend> {
  if (!factory) return createMemoryBackend();
  try {
    const backend = createIndexedDbBackend(factory, name);
    await backend.getMany("probe", []);
    return backend;
  } catch {
    return createMemoryBackend();
  }
}
