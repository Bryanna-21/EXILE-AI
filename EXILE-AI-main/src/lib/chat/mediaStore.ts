/**
 * Chat media (attachments and generated images), keyed by message id.
 *
 * Reads are synchronous from an in-memory view (React renders from it). Every write is also persisted to a
 * MediaBackend (IndexedDB when available) so media survives reloads; `hydrate(ids)` loads persisted media for
 * the messages being shown. `clear()` only resets the view (e.g. when switching conversations) and never
 * deletes stored media; `delete()` and `wipe()` remove it for real. If persistence is unavailable or a write
 * fails, `durable`/`lastError` say so and the UI must not claim the file will survive a reload.
 */

import type { FileKind } from "./files";
import { createMemoryBackend, type MediaBackend, type StoredFile } from "./mediaDb.ts";

export interface ChatFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: FileKind;
  /** The original bytes (a File for uploads) so downloads keep the exact name and format. */
  file?: Blob;
  /** Data URL for images (used for previews and for sending to vision models). */
  dataUrl?: string;
  /** Extracted text (text files, PDF text layer) for preview and "copy contents". */
  text?: string;
  origin: "attached" | "generated";
  /** Prompt used, for generated images. */
  prompt?: string;
  /** Persistent Artifact Engine reference, when available. */
  artifactId?: string;
  artifactName?: string;
  artifactVersion?: number;
}

type Listener = () => void;

export class ChatMediaStore {
  private map = new Map<string, ChatFile[]>();
  private snapshot: ReadonlyMap<string, ChatFile[]> = new Map();
  private listeners = new Set<Listener>();
  private backend: MediaBackend;
  private scope: string;
  private hydrating = new Set<string>();
  /** Ids already looked up in the backend; streaming re-renders must not re-query them. */
  private checked = new Set<string>();
  /** Last persistence problem (write failed, file too large to keep); null when everything persisted. */
  lastError: string | null = null;

  constructor(backend: MediaBackend = createMemoryBackend(), scope = "device") {
    this.backend = backend;
    this.scope = scope;
  }

  /** True when media survives a reload (a real IndexedDB backend is in use). */
  get durable() { return this.backend.kind === "indexeddb"; }

  /** Swap in the persistent backend once it has been opened (media already in view is written through). */
  useBackend(backend: MediaBackend, scope = this.scope) {
    this.backend = backend;
    this.scope = scope;
    this.checked.clear();
    for (const [id, files] of this.map) void this.persist(id, files);
  }

  private async persist(id: string, files: ChatFile[]) {
    const result = await this.backend.put(this.scope, id, files as StoredFile[]);
    if (!result.stored) {
      this.lastError = result.reason === "too-large" ? "A file is too large to keep on this device." : "Could not save media on this device.";
    } else {
      this.lastError = null;
      if (result.evicted.length) {
        // Old media was dropped to stay within the storage budget; reflect that in the view.
        for (const e of result.evicted) this.map.delete(e);
        this.commit();
      }
    }
  }

  /** Load persisted media for these message ids into the view (no-op for ids already loaded). */
  async hydrate(ids: string[]) {
    const wanted = ids.filter((i) => !this.map.has(i) && !this.hydrating.has(i) && !this.checked.has(i));
    if (!wanted.length) return;
    wanted.forEach((i) => this.hydrating.add(i));
    try {
      const records = await this.backend.getMany(this.scope, wanted);
      wanted.forEach((i) => this.checked.add(i));
      let changed = false;
      for (const r of records) if (!this.map.has(r.id)) { this.map.set(r.id, r.files as ChatFile[]); changed = true; }
      if (changed) this.commit();
    } catch {
      this.lastError = "Could not read saved media.";
    } finally {
      wanted.forEach((i) => this.hydrating.delete(i));
    }
  }

  private commit() {
    this.snapshot = new Map(this.map);
    this.listeners.forEach((l) => l());
  }

  get = (id: string): ChatFile[] => this.map.get(id) ?? [];

  set(id: string, files: ChatFile[]) {
    if (files.length) { this.map.set(id, files); void this.persist(id, files); }
    else { this.map.delete(id); void this.backend.delete(this.scope, [id]).catch(() => {}); }
    this.commit();
  }

  append(id: string, file: ChatFile) {
    const next = [...this.get(id), file];
    this.map.set(id, next);
    void this.persist(id, next);
    this.commit();
  }

  delete(ids: string | string[]) {
    const list = Array.isArray(ids) ? ids : [ids];
    void this.backend.delete(this.scope, list).catch(() => {});
    let changed = false;
    for (const id of list) changed = this.map.delete(id) || changed;
    if (changed) this.commit();
  }

  /** Remove every stored file for this scope (used by "wipe everything"). */
  async wipe() {
    this.map.clear();
    this.commit();
    await this.backend.clearScope(this.scope).catch(() => {});
  }

  /** Reset the in-memory view only (e.g. new conversation). Stored media is kept. */
  clear() {
    if (!this.map.size) return;
    this.map.clear();
    this.commit();
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;
}

export const chatMedia = new ChatMediaStore();
