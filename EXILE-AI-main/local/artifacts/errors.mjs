/**
 * Error taxonomy for the artifact engine. The distinction matters to callers:
 * a provider failure (no text could be obtained) is not an artifact-generation
 * failure (the content was obtained but could not become a valid file).
 */
export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  PROVIDER_FAILURE: "PROVIDER_FAILURE",
  GENERATION_FAILURE: "GENERATION_FAILURE",
  VALIDATION_FAILURE: "VALIDATION_FAILURE",
  ENGINE_UNAVAILABLE: "ENGINE_UNAVAILABLE",
  TIMEOUT: "TIMEOUT",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  TOO_LARGE: "TOO_LARGE",
  DELIVERY_FAILURE: "DELIVERY_FAILURE",
});

export class ArtifactError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const invalid = (message, details) => new ArtifactError("INVALID_INPUT", message, details);
export const unavailable = (message, details) => new ArtifactError("ENGINE_UNAVAILABLE", message, details);
export const generationFailed = (message, details) => new ArtifactError("GENERATION_FAILURE", message, details);

export function toErrorCode(error) {
  return error instanceof ArtifactError ? error.code : (error?.code && ERROR_CODES[error.code] ? error.code : "GENERATION_FAILURE");
}

/** Remove things that must never reach logs, clients or generated files. */
export function redact(text) {
  return String(text ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{16,})\b/g, "[redacted]")
    .replace(/([A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET)[A-Za-z0-9_]*\s*[=:]\s*)\S+/gi, "$1[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 400);
}
