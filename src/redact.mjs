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

export function rememberScoped(stdoutSecrets, stderrSecrets, value, stdout) {
  if (typeof value !== "string" || value.length === 0) return;
  if (stderrSecrets) stderrSecrets.add(value);
  if (stdout && stdoutSecrets) stdoutSecrets.add(value);
}

export function clipDetail(value, secrets) {
  return scrubText(value, secrets).slice(0, 300);
}

export function scrubText(value, secrets) {
  let text = String(value ?? "");
  const known = [...(secrets ?? [])].filter((secret) => typeof secret === "string" && secret.length > 0);
  known.sort((left, right) => right.length - left.length);
  for (const secret of known) text = text.split(secret).join("[redacted]");
  return redact(text);
}
