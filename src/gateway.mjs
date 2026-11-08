import { authedFetch, readResponseBuffer } from "./backend.mjs";
import { clipDetail } from "./redact.mjs";

export const POLL_INTERVAL_MS = 3000;
const REQUEST_TIMEOUT_MS = 30_000;

export function pollDelay(ms) {
  return Math.max(Number(ms) || 0, 2000);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, pollDelay(ms)));
}

export function pollAbortSignal(deadline, now = Date.now) {
  const remaining = Math.max(1, Number(deadline) - Number(now()));
  return AbortSignal.timeout(remaining);
}

export function createReadBudget(limit = 60) {
  let used = 0;
  return {
    charge() {
      used += 1;
      if (used > limit) throw new Error("stopped: more than 60 gateway reads in one command");
    },
    get used() {
      return used;
    },
  };
}

function asRecord(agent) {
  if (!agent || typeof agent !== "object") return null;
  const id = agent.id || agent.agentId;
  if (!id) return null;
  const memberIds = agent.memberIds || agent.memberAgentIds || [];
  const members = Array.isArray(memberIds) ? memberIds : [];
  return {
    id: String(id),
    name: String(agent.name || ""),
    description: String(agent.description || ""),
    isGroup: agent.isGroup === true || (agent.isGroup == null && members.length > 0),
  };
}

function unwrapList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.agents)) return data.agents;
  if (data && data.agent) return [data.agent];
  return [];
}

export function resolveBot(records, ref) {
  const bots = records.filter((record) => record && record.id && !record.isGroup);
  const needle = String(ref ?? "");
  const byId = bots.find((record) => record.id === needle);
  if (byId) return byId;
  const byName = bots.filter((record) => record.name === needle);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error('ambiguous bot name "' + needle + '"');
  throw new Error('refusing: "' + needle + '" is not one of this account\'s bots');
}

export function entriesOf(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.entries)) return payload.entries;
  if (Array.isArray(payload.messages)) return payload.messages;
  if (payload.transcript && Array.isArray(payload.transcript.entries)) return payload.transcript.entries;
  if (payload.thread && Array.isArray(payload.thread.entries)) return payload.thread.entries;
  return [];
}

export function entryText(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (typeof entry.text === "string" && entry.text) return entry.text;
  if (typeof entry.prompt === "string" && entry.prompt) return entry.prompt;
  if (typeof entry.message === "string") return entry.message;
  if (typeof entry.content === "string") return entry.content;
  if (Array.isArray(entry.content)) {
    return entry.content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") return part.text || part.content || "";
      return "";
    }).filter(Boolean).join("\n");
  }
  if (entry.message && typeof entry.message === "object" && typeof entry.message.content === "string") {
    return entry.message.content;
  }
  return "";
}

export function entryKey(entry) {
  if (entry && typeof entry.id === "string" && entry.id) return "id:" + entry.id;
  const role = entry && (entry.role || entry.kind || entry.sender || entry.type) || "";
  return "t:" + role + ":" + entryText(entry);
}

export function formatEntry(entry) {
  const role = entry.role || entry.kind || entry.sender || entry.type || "msg";
  const id = entry.id ? " " + entry.id : "";
  return "[" + role + id + "] " + entryText(entry);
}

export function formatThread(bot, payload) {
  const entries = entriesOf(payload);
  const lines = ["bot  " + bot.name, "    " + bot.id, ""];
  if (entries.length === 0) lines.push("    (no messages)");
  else for (const entry of entries) lines.push(formatEntry(entry));
  return lines.join("\n") + "\n";
}

function roleOf(entry) {
  return String(entry.role || entry.kind || entry.sender || entry.type || "").toLowerCase();
}

export function findReceipt(entries, nonce, text) {
  return entries.some((entry) => entry && (entry.clientNonce === nonce || entryText(entry) === text));
}

export function findNewReply(entries, beforeKeys, nonce, text) {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.clientNonce === nonce) continue;
    const role = roleOf(entry);
    if (entryText(entry) === text && (role === "user" || role === "human" || role === "")) continue;
    if (beforeKeys.has(entryKey(entry))) continue;
    if (role === "user" || role === "human") continue;
    return entry;
  }
  return null;
}

async function gatewayCall(session, method, body, { env, fetchImpl, budget, read, signal, secrets }) {
  if (read) budget?.charge();
  const url = String(session.gatewayUrl).replace(/\/$/, "") + "/api/" + method;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await authedFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + session.gatewayToken,
        ...session.gatewayHeaders,
      },
      body: JSON.stringify(body ?? {}),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    }, env, fetchImpl, "gateway");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(method + " failed: " + clipDetail(message, secrets));
  }
  const buffer = await readResponseBuffer(response);
  const text = buffer.toString("utf8");
  if (!response.ok) {
    throw new Error(method + " failed: " + response.status + " " + clipDetail(text, secrets));
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(method + " returned unreadable JSON");
  }
}

export async function listAgents(session, ctx) {
  const data = await gatewayCall(session, "listAgents", {}, { ...ctx, read: true });
  return unwrapList(data).map(asRecord).filter((record) => record && record.id);
}

export async function getTranscriptTail(session, id, limit, ctx) {
  const bounded = Math.min(Math.max(Math.trunc(limit) || 40, 1), 200);
  return gatewayCall(session, "getAgentTranscriptTail", { id, limit: bounded }, { ...ctx, read: true });
}

export async function getAgentThread(session, id, rootId, ctx) {
  return gatewayCall(session, "getAgentThread", { id, rootId }, { ...ctx, read: true });
}

export async function createAgent(session, input, ctx) {
  const data = await gatewayCall(session, "createAgent", {
    name: input.name,
    description: input.description || "",
    title: input.title || "",
    avatarShape: input.avatarShape || "",
    avatarColor: input.avatarColor || "",
    origin: "user",
  }, ctx);
  const record = asRecord(data.agent || data);
  if (!record) throw new Error("createAgent returned no record");
  return record;
}

export async function updateAgent(session, record, patch, ctx) {
  const name = patch.name !== undefined ? String(patch.name).trim() : record.name;
  if (!name) throw new Error("name cannot be blank");
  await gatewayCall(session, "updateAgent", {
    id: record.id,
    profile: {
      name,
      description: patch.description !== undefined ? String(patch.description) : record.description,
    },
  }, ctx);
  const fresh = (await listAgents(session, ctx)).find((item) => item.id === record.id);
  return fresh || { ...record, name, description: patch.description !== undefined ? String(patch.description) : record.description };
}
