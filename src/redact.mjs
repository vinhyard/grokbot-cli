const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const OPAQUE = /[A-Za-z0-9_\-.]{40,}/g;

export function redact(value) {
  return String(value ?? "")
    .replace(BEARER, "Bearer [redacted]")
    .replace(OPAQUE, "[redacted]");
}
