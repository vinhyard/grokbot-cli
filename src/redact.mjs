const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const OPAQUE = /[A-Za-z0-9_\-.]{40,}/g;

export function redact(value) {
  return String(value ?? "")
    .replace(BEARER, "Bearer [redacted]")
    .replace(OPAQUE, "[redacted]");
}

export function rememberSecrets(secrets, values) {
  if (!secrets) return;
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) secrets.add(value);
  }
}

export function scrubText(value, secrets) {
  let text = String(value ?? "");
  const known = [...(secrets ?? [])].filter((secret) => typeof secret === "string" && secret.length > 0);
  known.sort((left, right) => right.length - left.length);
  for (const secret of known) text = text.split(secret).join("[redacted]");
  return redact(text);
}
