import { randomUUID } from "node:crypto";
import { clipDetail, rememberScoped } from "./redact.mjs";
import {
  classifyDelivery,
  decodeSendResponse,
  encodeSendRequest,
} from "./proto.mjs";

const MESSAGE_MAX_BYTES = 16 * 1024;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const CLIENT_VERSION = "0.20.0";

let machineId;

export function getMachineId() {
  if (!machineId) machineId = randomUUID();
  return machineId;
}

export function assertMessageSize(text) {
  if (typeof text !== "string" || text.trim() === "") throw new Error("message is empty");
  if (Buffer.byteLength(text, "utf8") > MESSAGE_MAX_BYTES) throw new Error("message exceeds 16 KiB");
  return text;
}

export function readTestBase(env) {
  if (env == null || typeof env !== "object") return null;
  const raw = env.GROKBOT_TEST_BASE_URL;
  if (raw == null || raw === "") return null;
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    throw new Error("GROKBOT_TEST_BASE_URL must be http://127.0.0.1:<port> or http://[::1]:<port>");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "127.0.0.1" || host === "::1";
  const barePath = parsed.pathname === "" || parsed.pathname === "/";
  if (
    parsed.protocol !== "http:" ||
    !loopback ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    !barePath ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("GROKBOT_TEST_BASE_URL must be http://127.0.0.1:<port> or http://[::1]:<port>");
  }
  return parsed.origin;
}

function isCursorHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return host === "cursor.sh" || host === "cursor.com" || host.endsWith(".cursor.sh") || host.endsWith(".cursor.com");
}

export function assertAllowedCredentialUrl(rawUrl, env) {
  const testBase = readTestBase(env);
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new Error("Invalid credential URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Rejected credential URL: userinfo is not allowed.");
  }
  if (testBase) {
    if (parsed.origin !== testBase) {
      throw new Error(
        'Rejected credential URL host "' + parsed.hostname + '": test mode only allows the loopback GROKBOT_TEST_BASE_URL.',
      );
    }
    return String(rawUrl).replace(/\/$/, "");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Rejected credential URL: only https is allowed (got " + parsed.protocol + ").");
  }
  if (!isCursorHost(parsed.hostname)) {
    throw new Error(
      'Rejected credential URL host "' + parsed.hostname + '". Credentials may only be sent to https hosts on cursor.sh or cursor.com.',
    );
  }
  return String(rawUrl).replace(/\/$/, "");
}

export function isIdentityHeader(name) {
  const normalized = String(name || "").toLowerCase();
  if (normalized.includes("ghost")) return true;
  if (normalized.includes("client-source")) return true;
  if (normalized === "source" || normalized.endsWith("-source")) return true;
  return false;
}

export function routingHeaders(body) {
  const out = {};
  const source = body && typeof body === "object" ? body.gatewayHeaders || body.gateway_headers : null;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source)) {
      if (value == null || value === "") continue;
      const name = String(key).toLowerCase();
      if (isIdentityHeader(name)) continue;
      if (name === "authorization" || name === "cookie" || name === "content-type") continue;
      out[name] = String(value);
    }
  }
  if (Object.keys(out).length === 0 && body && typeof body === "object") {
    const token = body.anyrunNetworkToken || body.anyrun_network_token || body.networkToken;
    if (token) out["x-anyrun-network-token"] = String(token);
  }
  return out;
}

function backendBase(env) {
  return readTestBase(env) ?? "https://api2.cursor.sh";
}

export function sandboxHeaders(accessToken, teamId) {
  const headers = {
    "content-type": "application/json",
    "connect-protocol-version": "1",
    authorization: "Bearer " + accessToken,
    "x-cursor-client-type": "sand",
    "x-cursor-client-version": CLIENT_VERSION,
    "x-sand-box-namespace": "prod",
  };
  if (teamId) headers["x-cursor-team-id"] = teamId;
  return headers;
}

export function sendHeaders(accessToken, teamId, requestId) {
  const headers = {
    "content-type": "application/proto",
    "connect-protocol-version": "1",
    authorization: "Bearer " + accessToken,
    "x-cursor-client-type": "sand",
    "x-cursor-client-version": CLIENT_VERSION,
    "x-sand-box-namespace": "prod",
    "x-request-id": requestId,
  };
  if (teamId) headers["x-cursor-team-id"] = teamId;
  return headers;
}

export async function authedFetch(url, options, env, fetchImpl = globalThis.fetch) {
  assertAllowedCredentialUrl(url, env);
  return fetchImpl(url, { ...options, redirect: "error" });
}

async function cancelBody(response) {
  try {
    if (response?.body && typeof response.body.cancel === "function") await response.body.cancel();
  } catch {
    // The body may already be closed.
  }
}

export async function readResponseBuffer(response) {
  const declared = response.headers?.get?.("content-length");
  if (declared != null && declared !== "") {
    const size = Number(declared);
    if (!Number.isFinite(size) || size > RESPONSE_MAX_BYTES) {
      await cancelBody(response);
      throw new Error("response too large");
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > RESPONSE_MAX_BYTES) throw new Error("response too large");
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value?.byteLength ?? value?.length ?? 0;
      total += bytes;
      if (total > RESPONSE_MAX_BYTES) throw new Error("response too large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The reader may already be closed.
    }
  }
  return Buffer.concat(chunks, total);
}

export function assertVisibleHeader(value, label) {
  if (typeof value !== "string" || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error("rejected an unsafe " + label);
  }
}

function safeDetail(error, secrets) {
  const message = error instanceof Error ? error.message : String(error);
  return clipDetail(message, secrets);
}

function unknownDelivery(detail, secrets) {
  const error = new Error("delivery is unknown and the message must not be resent: " + clipDetail(detail, secrets));
  error.exitCode = 4;
  return error;
}

export async function ensureSandbox(accessToken, { teamId, env, fetchImpl, secrets, stdoutSecrets } = {}) {
  const url = backendBase(env).replace(/\/$/, "") + "/aiserver.v1.GrokBotService/EnsureSandBox";
  let response;
  try {
    response = await authedFetch(url, {
      method: "POST",
      headers: sandboxHeaders(accessToken, teamId),
      body: "{}",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, env, fetchImpl);
  } catch (error) {
    throw new Error("EnsureSandBox failed: " + safeDetail(error, secrets));
  }
  const buffer = await readResponseBuffer(response);
  const text = buffer.toString("utf8");
  if (!response.ok) {
    throw new Error("EnsureSandBox failed: " + response.status + " " + clipDetail(text, secrets));
  }
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("EnsureSandBox returned unreadable JSON");
  }
  const gatewayUrl = body.gatewayUrl || body.gateway_url;
  const gatewayToken = body.gatewayToken || body.gateway_token;
  if (!gatewayUrl || !gatewayToken) throw new Error("EnsureSandBox returned no gateway route");
  const token = String(gatewayToken);
  assertVisibleHeader(token, "gateway token");
  const gatewayHeaders = routingHeaders(body);
  for (const value of Object.values(gatewayHeaders)) assertVisibleHeader(value, "routing header");
  rememberScoped(stdoutSecrets, secrets, token, true);
  for (const value of Object.values(gatewayHeaders)) rememberScoped(stdoutSecrets, secrets, value, value.length >= 16);
  return {
    gatewayUrl: assertAllowedCredentialUrl(String(gatewayUrl), env).replace(/\/$/, ""),
    gatewayToken: token,
    gatewayHeaders,
  };
}

export async function sendUserMessage(accessToken, fields, { teamId, env, fetchImpl, secrets } = {}) {
  const url = backendBase(env).replace(/\/$/, "") + "/aiserver.v1.GrokBotService/SendGrokBotUserMessage";
  const body = encodeSendRequest({ ...fields, language: fields.language || "en" });
  assertAllowedCredentialUrl(url, env);
  const sendFetch = fetchImpl ?? globalThis.fetch;
  let response;
  try {
    response = await sendFetch(url, {
      method: "POST",
      headers: sendHeaders(accessToken, teamId, randomUUID()),
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    throw unknownDelivery(error instanceof Error ? error.message : String(error), secrets);
  }
  let buffer;
  try {
    buffer = await readResponseBuffer(response);
  } catch (error) {
    throw unknownDelivery(error instanceof Error ? error.message : String(error), secrets);
  }
  if (!response.ok) {
    throw unknownDelivery("HTTP " + response.status + " " + buffer.toString("utf8"), secrets);
  }
  if (buffer.length === 0) throw unknownDelivery("empty response", secrets);
  if (buffer[0] === 0x7b) throw unknownDelivery(buffer.toString("utf8"), secrets);
  try {
    const decoded = decodeSendResponse(buffer);
    return { decoded, result: classifyDelivery(decoded) };
  } catch {
    throw unknownDelivery("unreadable response", secrets);
  }
}

export { classifyDelivery };
