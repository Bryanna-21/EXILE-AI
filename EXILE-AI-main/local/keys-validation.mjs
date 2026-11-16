/**
 * Validation for the key-management endpoint (Settings -> API).
 *
 * The endpoint writes `NAME=value` lines to .env and copies them into process.env, which is read again at
 * the next launch and inherited by child processes. Without validation a caller could set NODE_OPTIONS,
 * PATH or ELECTRON_RUN_AS_NODE (code execution at next start) or smuggle extra variables with a newline in a
 * value. Only credential-shaped names are accepted, never runtime/loader variables.
 */
export const KEY_NAME_RE = /^[A-Z][A-Z0-9_]{1,62}(_API_KEY|_TOKEN|_SID)$/;
const FORBIDDEN_PREFIXES = ["NODE_", "ELECTRON_", "EXILE_", "NPM_", "LD_", "DYLD_", "PYTHON", "PATH", "HOME", "USERPROFILE", "APPDATA", "SYSTEMROOT", "COMSPEC", "PSMODULEPATH"];
export const MAX_KEY_VALUE_LENGTH = 1024;

export class KeyValidationError extends Error {
  constructor(message) { super(message); this.name = "KeyValidationError"; this.statusCode = 400; }
}

export function normalizeKeyName(raw) {
  return String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

export function validateKeyName(name) {
  if (!KEY_NAME_RE.test(name)) throw new KeyValidationError(`"${String(name).slice(0, 40)}" is not a valid key name. Names must end in _API_KEY, _TOKEN or _SID.`);
  if (FORBIDDEN_PREFIXES.some((p) => name.startsWith(p))) throw new KeyValidationError(`"${name}" is reserved and cannot be set here.`);
  return name;
}

export function validateKeyValue(value) {
  const v = String(value ?? "").trim();
  if (v.length > MAX_KEY_VALUE_LENGTH) throw new KeyValidationError("A key value is too long.");
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new KeyValidationError("Key values cannot contain control characters or line breaks.");
  return v;
}

/** Throws KeyValidationError for anything unsafe; returns the cleaned request. */
export function validateKeysRequest(body, providerIds) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new KeyValidationError("Request body must be a JSON object.");
  if (body.keys !== undefined && !Array.isArray(body.keys)) throw new KeyValidationError("keys must be an array.");
  const keys = (body.keys ?? []).map((item) => {
    if (!item || typeof item !== "object") throw new KeyValidationError("Each key must be an object.");
    return { name: validateKeyName(normalizeKeyName(item.name)), value: validateKeyValue(item.value) };
  });
  const primary = String(body.primary ?? "").trim();
  if (primary && !providerIds.includes(primary)) throw new KeyValidationError("primary must be a known provider id.");
  return { keys, primary };
}
