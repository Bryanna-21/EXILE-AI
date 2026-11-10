/**
 * In-memory media for the current browser session.
 *
 * Conversation text is saved to localStorage, but attachments and generated images are too large
 * for it, so they are kept here keyed by message id. They survive for as long as the page stays
 * open and are gone after a reload; the UI says so instead of pretending otherwise.
 */

import type { FileKind } from "./files";

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
}

type Listener = () => void;

export class ChatMediaStore {
  private map = new Map<string, ChatFile[]>();
  private snapshot: ReadonlyMap<string, ChatFile[]> = new Map();
  private listeners = new Set<Listener>();

  private commit() {
    this.snapshot = new Map(this.map);
    this.listeners.forEach((l) => l());
  }

  get = (id: string): ChatFile[] => this.map.get(id) ?? [];

  set(id: string, files: ChatFile[]) {
    if (files.length) this.map.set(id, files);
    else this.map.delete(id);
    this.commit();
  }

  append(id: string, file: ChatFile) {
    this.map.set(id, [...this.get(id), file]);
    this.commit();
  }

  delete(ids: string | string[]) {
    let changed = false;
    for (const id of Array.isArray(ids) ? ids : [ids]) changed = this.map.delete(id) || changed;
    if (changed) this.commit();
  }

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
