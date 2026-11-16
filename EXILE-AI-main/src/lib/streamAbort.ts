/**
 * Abort-aware stream helpers (no app imports so they are unit-testable in Node).
 *
 * A fetch abort signal only covers the request until headers arrive; once the body is being read,
 * cancelling needs an explicit reader.cancel(). These helpers make "stop generating" actually stop
 * the network read instead of merely hiding the output.
 */

export function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/** Reads every chunk, cancelling the underlying stream and throwing AbortError as soon as `signal` fires. */
export async function readStreamAbortable(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> },
  signal: AbortSignal | undefined,
  onChunk: (value: Uint8Array) => void,
): Promise<void> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(abortError());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {}); // avoid an unhandled rejection when the read finishes first
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) return;
      if (value) onChunk(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** sleep() that rejects with AbortError instead of waiting out a retry back-off after the user stopped. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
