/**
 * Client for EXILE's local artifact service (local/artifacts/api.mjs).
 *
 * Like taskApi.ts it has no app imports, so the same file runs in tests against the real HTTP
 * handler. Every failure comes back as a classified { ok:false, kind } value so the UI can say
 * what actually happened (service not running, provider failed, file failed validation, WhatsApp
 * did not deliver ...) instead of a generic error. Progress callbacks receive the server's real
 * pipeline events; nothing is simulated here.
 */
import type {
  ArtifactCapabilities, ArtifactDetail, ArtifactPreview, ArtifactProgress, ArtifactResult, ArtifactSummary,
} from "../types/artifacts";

export type ArtifactErrorKind =
  | "disconnected" | "timeout" | "forbidden" | "not-found" | "invalid" | "validation"
  | "provider" | "unavailable" | "delivery" | "server" | "malformed";

export interface Fail { ok: false; kind: ArtifactErrorKind; error: string; result?: ArtifactResult }
export type Res<T> = { ok: true; value: T } | Fail;
type Json = Record<string, unknown>;

/** The project compiles with strict:false, where `if (!r.ok)` does not narrow; use this guard instead. */
export function isFail<T>(r: Res<T> | { ok: true; value: T } | Fail): r is Fail {
  return r.ok === false;
}

export interface ArtifactClientOptions {
  getBase: () => Promise<string>;
  fetchImpl?: typeof fetch;
  getAuthSecret?: () => string;
  onDisconnected?: () => void;
  timeoutMs?: number;
  longTimeoutMs?: number;
}

const CODE_KIND: Record<string, ArtifactErrorKind> = {
  INVALID_INPUT: "invalid", VALIDATION_FAILURE: "validation", PROVIDER_FAILURE: "provider",
  ENGINE_UNAVAILABLE: "unavailable", DELIVERY_FAILURE: "delivery", FORBIDDEN: "forbidden", NOT_FOUND: "not-found",
  TIMEOUT: "timeout", TOO_LARGE: "invalid", GENERATION_FAILURE: "server",
};

function kindFromStatus(status: number, code?: string): ArtifactErrorKind {
  if (code && CODE_KIND[code]) return CODE_KIND[code];
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 503) return "unavailable";
  if (status >= 400 && status < 500) return "invalid";
  return "server";
}

/** Split a Server-Sent-Events buffer into complete events and the unfinished remainder. */
export function parseSse(buffer: string): { events: { event: string; data: unknown }[]; rest: string } {
  const events: { event: string; data: unknown }[] = [];
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) continue;
    try {
      events.push({ event, data: JSON.parse(data.join("\n")) });
    } catch {
      /* a malformed frame is skipped, never guessed at */
    }
  }
  return { events, rest };
}

export function createArtifactClient(opts: ArtifactClientOptions) {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const longTimeoutMs = opts.longTimeoutMs ?? 10 * 60_000;

  async function raw(path: string, init: RequestInit & { long?: boolean } = {}): Promise<{ ok: true; value: Response; release: () => void } | Fail> {
    let base: string;
    try {
      base = await opts.getBase();
    } catch {
      base = "";
    }
    if (!base) {
      opts.onDisconnected?.();
      return { ok: false, kind: "disconnected", error: "The EXILE local service is not running, so files can't be created or opened." };
    }
    const secret = opts.getAuthSecret?.() ?? "";
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), init.long ? longTimeoutMs : timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        ...init,
        signal: ctl.signal,
        headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(secret ? { "x-exile-local-auth": secret } : {}), ...(init.headers as Record<string, string> | undefined) },
      });
      return { ok: true, value: res, release: () => clearTimeout(timer) };
    } catch (error) {
      clearTimeout(timer);
      if ((error as Error)?.name === "AbortError") return { ok: false, kind: "timeout", error: "The EXILE local service did not answer in time." };
      opts.onDisconnected?.();
      return { ok: false, kind: "disconnected", error: "Could not reach the EXILE local service." };
    } finally {
      // The timer guards the connection; a streamed body keeps it until stream() calls release().
      if (!init.long) clearTimeout(timer);
    }
  }

  async function json<T>(path: string, init: RequestInit = {}, pick?: (body: Json) => T): Promise<Res<T>> {
    const r = await raw(path, init);
    if (isFail(r)) return r;
    let body: Json;
    try {
      body = (await r.value.json()) as Json;
    } catch {
      return { ok: false, kind: "malformed", error: "The service returned an unreadable response." };
    }
    if (!r.value.ok || body?.ok === false) {
      const result = body?.result && typeof body.result === "object" ? (body.result as ArtifactResult) : undefined;
      const code = (body?.code as string | undefined) ?? result?.code;
      return { ok: false, kind: kindFromStatus(r.value.status, code), error: String(body?.error ?? result?.error ?? `Request failed (${r.value.status}).`), result };
    }
    return { ok: true, value: pick ? pick(body) : (body as unknown as T) };
  }

  /** POST that streams real pipeline events and resolves with the final ArtifactResult. */
  async function stream(path: string, body: unknown, onProgress?: (p: ArtifactProgress) => void): Promise<Res<ArtifactResult>> {
    const r = await raw(path, { method: "POST", body: JSON.stringify(body), headers: { Accept: "text/event-stream" }, long: true });
    if (isFail(r)) return r;
    const res = r.value;
    const release = r.release;
    try {
      return await readStream(res, onProgress);
    } finally {
      release();
    }
  }

  async function readStream(res: Response, onProgress?: (p: ArtifactProgress) => void): Promise<Res<ArtifactResult>> {
    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/event-stream")) {
      // The server answered with plain JSON (an early validation error, for example).
      let b: Json;
      try { b = (await res.json()) as Json; } catch { return { ok: false, kind: "malformed", error: "The service returned an unreadable response." }; }
      const result = b?.result as ArtifactResult | undefined;
      if (b?.ok && result?.success) return { ok: true, value: result };
      return { ok: false, kind: kindFromStatus(res.status, (b?.code as string | undefined) ?? result?.code), error: String(b?.error ?? result?.error ?? "Request failed."), result };
    }
    let finalResult: ArtifactResult | undefined;
    let buffer = "";
    const handle = (text: string) => {
      buffer += text;
      const { events, rest } = parseSse(buffer);
      buffer = rest;
      for (const e of events) {
        if (e.event === "progress") onProgress?.(e.data as ArtifactProgress);
        else if (e.event === "result") finalResult = (e.data as { result: ArtifactResult }).result;
      }
    };
    try {
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          handle(decoder.decode(value, { stream: true }));
        }
        handle(decoder.decode() + "\n\n");
      } else {
        handle((await res.text()) + "\n\n");
      }
    } catch {
      return { ok: false, kind: "disconnected", error: "The connection to the EXILE local service was lost while the file was being made." };
    }
    if (!finalResult) return { ok: false, kind: "malformed", error: "The service ended the stream without a result." };
    if (finalResult.success) return { ok: true, value: finalResult };
    return { ok: false, kind: kindFromStatus(500, finalResult.code), error: finalResult.error ?? "The file could not be created.", result: finalResult };
  }

  return {
    capabilities: () => json<ArtifactCapabilities>("/artifacts/capabilities", {}, (b) => b as unknown as ArtifactCapabilities),
    list: () => json<ArtifactSummary[]>("/artifacts", {}, (b) => b.artifacts as ArtifactSummary[]),
    describe: (id: string) => json<ArtifactDetail>(`/artifacts/${id}`, {}, (b) => b.artifact as ArtifactDetail),
    preview: (id: string, version?: number) => json<ArtifactPreview>(`/artifacts/${id}/preview${version ? `?version=${version}` : ""}`, {}, (b) => b.preview as ArtifactPreview),
    create: (body: { format?: string; spec?: unknown; prompt?: string; name?: string }, onProgress?: (p: ArtifactProgress) => void) => stream("/artifacts", body, onProgress),
    edit: (id: string, body: { spec?: unknown; operations?: unknown[]; quality?: number }, onProgress?: (p: ArtifactProgress) => void) => stream(`/artifacts/${id}/edit`, body, onProgress),
    convert: (id: string, format: string, onProgress?: (p: ArtifactProgress) => void) => stream(`/artifacts/${id}/convert`, { format }, onProgress),
    packageArtifacts: (ids: string[], name: string, onProgress?: (p: ArtifactProgress) => void) => stream("/artifacts/package", { ids, name }, onProgress),
    variations: (id: string, count = 3) => json<ArtifactResult[]>(`/artifacts/${id}/variations`, { method: "POST", body: JSON.stringify({ count }) }, (b) => b.results as ArtifactResult[]),
    deliver: (id: string, body: { to: string; caption?: string; channel?: string; version?: number }) =>
      json<{ state: "sent" | "failed"; deliveryId: string }>(`/artifacts/${id}/deliver`, { method: "POST", body: JSON.stringify(body) }, (b) => b.result as { state: "sent" | "failed"; deliveryId: string }),
    remove: (id: string) => json<{ deleted: boolean }>(`/artifacts/${id}?confirm=${encodeURIComponent(id)}`, { method: "DELETE" }, (b) => ({ deleted: b.deleted === true })),
    /** The file itself, with the stored name and the server's checksum. */
    async download(id: string, version?: number): Promise<Res<{ blob: Blob; name: string; sha256: string }>> {
      const r = await raw(`/artifacts/${id}/download${version ? `?version=${version}` : ""}`);
      if (isFail(r)) return r;
      if (!r.value.ok) return { ok: false, kind: kindFromStatus(r.value.status), error: `Download failed (${r.value.status}).` };
      const disposition = r.value.headers.get("content-disposition") || "";
      const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      const plain = /filename="([^"]*)"/i.exec(disposition);
      const name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : "artifact";
      return { ok: true, value: { blob: await r.value.blob(), name, sha256: r.value.headers.get("x-artifact-sha256") || "" } };
    },
  };
}

export type ArtifactClient = ReturnType<typeof createArtifactClient>;

/** Plain-language one-liner for an error kind, used when the server gave no better text. */
export function describeArtifactError(kind: ArtifactErrorKind): string {
  switch (kind) {
    case "disconnected": return "The EXILE local service isn't running.";
    case "timeout": return "The service took too long to answer.";
    case "provider": return "No permitted AI provider could write the content.";
    case "validation": return "The file was produced but failed its checks, so it was not saved.";
    case "unavailable": return "A tool this needs isn't installed on this computer.";
    case "delivery": return "The file was kept, but WhatsApp did not deliver it.";
    case "forbidden": return "That isn't allowed.";
    case "not-found": return "That artifact no longer exists.";
    case "invalid": return "The request wasn't valid.";
    default: return "The service reported an error.";
  }
}
