/**
 * Local API authentication.
 *
 * The local server binds to 127.0.0.1, but "localhost only" is not a security
 * boundary: any process on the machine (and any web page that can reach
 * 127.0.0.1) could previously call /tasks, fetch an approval token and approve
 * its own request. Sensitive routes now require a per-launch secret supplied
 * by the app that started the server:
 *   - Electron main generates it, passes it to this server's environment and to
 *     the renderer's preload (never written to disk or logs).
 *   - `npm run local` (dev.mjs) generates one and passes it to both processes.
 *   - A server started on its own generates a random secret for the session and
 *     injects it into the index.html it serves to a loopback Host.
 *
 * What this defends against: other web origins, DNS-rebinding pages, and (in
 * the Electron path) other local processes that do not hold the secret.
 * What it does not defend against: malware running as the same user that can
 * read this process's memory or the renderer; that is outside this model.
 */
import crypto from "node:crypto";

export const AUTH_HEADER = "x-exile-local-auth";
const MIN_SECRET_LENGTH = 32;

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest();

export function createLocalAuth(provided = process.env.EXILE_LOCAL_API_SECRET) {
  const usable = typeof provided === "string" && provided.length >= MIN_SECRET_LENGTH;
  const secret = usable ? provided : crypto.randomBytes(32).toString("base64url");
  const expected = sha256(secret);
  return {
    secret,
    /** True when the secret came from the launching app rather than being generated here. */
    suppliedByLauncher: usable,
    verify(req) {
      const supplied = req?.headers?.[AUTH_HEADER];
      if (typeof supplied !== "string" || supplied.length === 0 || supplied.length > 256) return false;
      return crypto.timingSafeEqual(sha256(supplied), expected);
    },
  };
}

/** Origin is absent (non-browser caller), "null"/file:// (Electron) or a loopback web origin. */
export function isLocalOrigin(req) {
  const origin = req?.headers?.origin;
  return (
    !origin ||
    origin === "null" ||
    origin === "file://" ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
  );
}

/** Host header must name the loopback interface; defeats DNS rebinding. */
export function isLoopbackHost(req) {
  const host = String(req?.headers?.host ?? "").toLowerCase();
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}

/**
 * Gate for sensitive routes. Returns null when allowed, otherwise
 * `{ status, error }` to send. CORS preflights never reach this check.
 */
export function checkLocalRequest(req, auth) {
  if (!isLoopbackHost(req)) return { status: 403, error: "Requests must address the local interface directly." };
  if (!isLocalOrigin(req)) return { status: 403, error: "This API is restricted to the local app." };
  if (auth && !auth.verify(req)) {
    return { status: 401, error: "Local API authentication required. Open EXILE from the desktop app or `npm run local`." };
  }
  return null;
}

export const localAuth = createLocalAuth();
