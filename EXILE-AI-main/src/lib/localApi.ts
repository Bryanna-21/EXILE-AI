/**
 * Local API authentication for browser-hosted development and standalone mode.
 *
 * Electron requests are authenticated by the main process. The renderer never
 * receives the desktop secret. Browser-hosted modes use the server meta tag or
 * VITE_EXILE_LOCAL_API_SECRET, and attach credentials only to loopback requests.
 */
export const LOCAL_AUTH_HEADER = "x-exile-local-auth";

export function getLocalApiSecret(): string {
  try {
    const meta = document.querySelector('meta[name="exile-local-api-secret"]')?.getAttribute("content");
    if (meta) return meta;
  } catch {
    /* no DOM (tests / SSR) */
  }
  return (import.meta.env.VITE_EXILE_LOCAL_API_SECRET as string | undefined) || "";
}

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i;

export function isLoopbackUrl(url: string): boolean {
  return LOOPBACK.test(url);
}

/** Headers to add for a request to `url`; empty for anything that is not the loopback interface. */
export function localAuthHeadersFor(url: string): Record<string, string> {
  const secret = getLocalApiSecret();
  return secret && isLoopbackUrl(url) ? { [LOCAL_AUTH_HEADER]: secret } : {};
}

let installed = false;

/**
 * Wrap window.fetch once so every call to the local API carries the secret without each
 * call site having to remember it. Requests to other hosts are passed through untouched.
 */
export function installLocalApiAuth(): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const extra = localAuthHeadersFor(url);
    if (!Object.keys(extra).length) return original(input, init);
    const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? (input as Request).headers : undefined));
    for (const [k, v] of Object.entries(extra)) if (!headers.has(k)) headers.set(k, v);
    return original(input, { ...init, headers });
  };
}
