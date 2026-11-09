#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  assertMessageSize,
  assertVisibleHeader,
  ensureSandbox,
  getMachineId,
  sendUserMessage,
} from "../src/backend.mjs";
import { appSecretsPath, loadCredentials, readKeychainPassword } from "../src/creds.mjs";
import {
  POLL_INTERVAL_MS,
  createAgent,
  createReadBudget,
  entriesOf,
  entryKey,
  findNewReply,
  findReceipt,
  formatEntry,
  formatThread,
  getAgentThread,
  getTranscriptTail,
  listAgents,
  pollAbortSignal,
  resolveBot,
  sleep,
  updateAgent,
} from "../src/gateway.mjs";
import { rememberScoped, scrubText } from "../src/redact.mjs";
import { clientVersion } from "../src/version.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const MACOS_ONLY = "grokbot requires macOS; credential support is not available on this platform.";
const EXPERIMENTAL = "experimental";
const VALUE_FLAGS = new Set(["limit", "wait", "name", "instructions-file"]);

const HELP = `grokbot — unofficial command-line tool for the bots in the Grok Bot desktop app

Usage:
  grokbot bots [--json]
  grokbot thread <bot id|name> [--limit N] [--json]
  grokbot send <bot id|name> <text|-> [--wait S] [--dry-run]
  grokbot bot create --name <name> --instructions-file <file> --yes
  grokbot bot update <bot id|name> --instructions-file <file> [--name <name>] --yes
  grokbot doctor
  grokbot --help
  grokbot --version

bot create and bot update are ${EXPERIMENTAL}.
They require --yes and print the target and the instruction byte count first.
Instructions are sent as the agent description through createAgent / updateAgent.
An instructions file must be at most 64 KiB.

Credentials are read from the macOS keychain at run time and kept in memory only.
Backend requests go only to HTTPS hosts on cursor.sh or cursor.com. Gateway requests may also use HTTPS hosts on cursorvm.com.
The tool sends the app's client-type header and the installed app's version because the backend rejects unknown versions.
When no app version is found, the version falls back to 0.20.0. GROKBOT_CLIENT_VERSION overrides it.
It sends no source field and no ghost-mode or client-source header.

Exit codes: 0 success, 1 the message was not sent, 3 the message was sent and must not be resent, 4 delivery is unknown and the message must not be resent.
`;

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--json" || arg === "--dry-run" || arg === "--yes") {
      flags[arg.slice(2)] = true;
      continue;
    }
    if (arg.startsWith("--")) {
      let name = arg.slice(2);
      let value;
      const eq = name.indexOf("=");
      if (eq !== -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (!VALUE_FLAGS.has(name)) throw new Error("unknown option --" + name);
      if (value === undefined) {
        value = argv[index + 1];
        index += 1;
        if (value == null) throw new Error("missing value for --" + name);
      }
      flags[name] = value;
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

function parseLimit(value) {
  if (value == null) return 40;
  if (!/^\d+$/.test(String(value))) throw new Error("--limit must be an integer from 1 to 200");
  const number = Number(value);
  if (number < 1 || number > 200) throw new Error("--limit must be an integer from 1 to 200");
  return number;
}

function parseWait(value) {
  if (value == null) return 0;
  if (!/^\d+$/.test(String(value))) throw new Error("--wait must be an integer from 1 to 120");
  const number = Number(value);
  if (number < 1 || number > 120) throw new Error("--wait must be an integer from 1 to 120");
  return number;
}

function readStdin() {
  const chunks = [];
  const buffer = Buffer.alloc(4096);
  let total = 0;
  for (;;) {
    const count = readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count;
    if (total > 16 * 1024) throw new Error("message exceeds 16 KiB");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  let text = Buffer.concat(chunks).toString("utf8");
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  return text;
}

function messageText(raw) {
  return assertMessageSize(raw === "-" ? readStdin() : raw);
}

const INSTRUCTIONS_MAX_BYTES = 64 * 1024;

function fileErrorCode(error) {
  return error && typeof error === "object" && error.code ? error.code : "read failed";
}

function readInstructions(file) {
  if (!file) throw new Error("missing --instructions-file");
  let info;
  try {
    info = statSync(file);
  } catch (error) {
    throw new Error("instructions file: " + fileErrorCode(error));
  }
  if (!info.isFile()) throw new Error("instructions file: not a regular file");
  if (info.size > INSTRUCTIONS_MAX_BYTES) throw new Error("instructions file exceeds 64 KiB");
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch (error) {
    throw new Error("instructions file: " + fileErrorCode(error));
  }
  if (buffer.length > INSTRUCTIONS_MAX_BYTES) throw new Error("instructions file exceeds 64 KiB");
  const text = buffer.toString("utf8");
  if (text.trim() === "") throw new Error("instructions file is empty");
  return text;
}

function beginMutation(stdout, target, instructions, yes) {
  stdout(EXPERIMENTAL + "\n");
  stdout("target: " + target + "\n");
  stdout("instructions: " + Buffer.byteLength(instructions) + " bytes\n");
  if (!yes) throw new Error("refusing to continue without --yes");
}

function credentialEnv(deps) {
  const env = deps.env ?? {};
  const seam = env.GROKBOT_TEST_BASE_URL;
  if (seam != null && seam !== "" && deps.getKeychainPassword == null) {
    throw new Error("test base URL requires injected credentials");
  }
  return env;
}

async function openSession(deps) {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") throw new Error(MACOS_ONLY);
  const env = credentialEnv(deps);
  const creds = loadCredentials({
    home: deps.home,
    platform,
    getKeychainPassword: () => {
      const password = (deps.getKeychainPassword ?? readKeychainPassword)();
      rememberScoped(deps.stdoutSecrets, deps.stderrSecrets, password, true);
      return password;
    },
  });
  assertVisibleHeader(creds.accessToken, "access token");
  rememberScoped(deps.stdoutSecrets, deps.stderrSecrets, creds.accessToken, true);
  rememberScoped(deps.stdoutSecrets, deps.stderrSecrets, creds.teamId, false);
  const version = sessionVersion(deps, platform);
  const route = await ensureSandbox(creds.accessToken, {
    teamId: creds.teamId,
    env,
    fetchImpl: deps.fetchImpl,
    secrets: deps.stderrSecrets,
    stdoutSecrets: deps.stdoutSecrets,
    version,
  });
  return {
    creds,
    route,
    env,
    fetchImpl: deps.fetchImpl,
    budget: createReadBudget(),
    secrets: deps.stderrSecrets,
    version,
  };
}

function sessionVersion(deps, platform) {
  if (deps.clientVersion) return deps.clientVersion;
  return clientVersion({
    home: deps.home ?? homedir(),
    platform,
    env: deps.env ?? process.env,
    exists: deps.exists,
    readFile: deps.readFile,
    readPlist: deps.readPlist,
  });
}

function callCtx(session) {
  return { env: session.env, fetchImpl: session.fetchImpl, budget: session.budget, secrets: session.secrets };
}

async function cmdBots(flags, deps, stdout) {
  const session = await openSession(deps);
  const bots = (await listAgents(session.route, callCtx(session))).filter((bot) => !bot.isGroup);
  if (flags.json) {
    stdout(JSON.stringify(bots.map((bot) => ({ id: bot.id, name: bot.name }))) + "\n");
    return 0;
  }
  stdout(bots.length === 0 ? "No bots.\n" : bots.map((bot) => bot.id + "  " + bot.name).join("\n") + "\n");
  return 0;
}

async function cmdThread(positionals, flags, deps, stdout) {
  const ref = positionals[0];
  if (!ref || positionals.length > 1) throw new Error("usage: grokbot thread <bot id|name> [--limit N]");
  const session = await openSession(deps);
  const bot = resolveBot(await listAgents(session.route, callCtx(session)), ref);
  const payload = await getTranscriptTail(session.route, bot.id, parseLimit(flags.limit), callCtx(session));
  if (flags.json) {
    stdout(JSON.stringify(payload) + "\n");
    return 0;
  }
  stdout(formatThread(bot, payload));
  return 0;
}

async function waitForReply({ session, bot, nonce, text, beforeKeys, confirmEntries, messageId, waitSec, deps, stdout }) {
  const ctx = callCtx(session);
  const now = deps.now ?? Date.now;
  const deadline = now() + waitSec * 1000;
  const timed = () => ({ ...ctx, signal: pollAbortSignal(deadline, now) });
  let reply = findNewReply(confirmEntries, beforeKeys, nonce, text);
  if (!reply && messageId) {
    try {
      const rooted = await getAgentThread(session.route, bot.id, messageId, timed());
      reply = findNewReply(entriesOf(rooted), beforeKeys, nonce, text);
    } catch (error) {
      if (error instanceof Error && /60 gateway reads/.test(error.message)) throw error;
    }
  }
  const pause = deps.sleep ?? sleep;
  while (!reply && now() + POLL_INTERVAL_MS <= deadline) {
    await pause(POLL_INTERVAL_MS);
    const page = await getTranscriptTail(session.route, bot.id, 40, timed());
    reply = findNewReply(entriesOf(page), beforeKeys, nonce, text);
  }
  if (!reply) throw new Error("no bot reply within " + waitSec + "s");
  stdout(formatEntry(reply) + "\n");
}

async function cmdSend(positionals, flags, deps, stdout) {
  const ref = positionals[0];
  const raw = positionals[1];
  if (!ref || raw == null || positionals.length > 2) {
    throw new Error("usage: grokbot send <bot id|name> <text|-> [--wait S] [--dry-run]");
  }
  const text = messageText(raw);
  const waitSec = parseWait(flags.wait);
  if (flags["dry-run"]) {
    const bytes = Buffer.byteLength(text, "utf8");
    stdout("dry-run\n");
    stdout("target: " + ref + "\n");
    stdout("endpoint: /aiserver.v1.GrokBotService/SendGrokBotUserMessage\n");
    stdout("text-bytes: " + bytes + "\n");
    stdout("source-field: omitted\n");
    stdout("text:\n" + text + "\n");
    return 0;
  }
  const session = await openSession(deps);
  const ctx = callCtx(session);
  const bot = resolveBot(await listAgents(session.route, ctx), ref);
  const nonce = randomUUID();
  let beforeKeys = new Set();
  if (waitSec) {
    const snap = await getTranscriptTail(session.route, bot.id, 40, ctx);
    beforeKeys = new Set(entriesOf(snap).map(entryKey));
  }
  const sent = await sendUserMessage(session.creds.accessToken, {
    agentId: bot.id,
    nonce,
    text,
    sentAtMs: Date.now(),
    machineId: getMachineId(),
    language: "en",
  }, {
    teamId: session.creds.teamId,
    env: session.env,
    fetchImpl: session.fetchImpl,
    secrets: session.secrets,
    version: session.version,
  });
  const result = sent.result;
  if (result.outcome === "duplicate") {
    stdout("duplicate, already accepted\n");
    return 0;
  }
  if (result.outcome === "refused") throw new Error("refused: " + result.message);
  if (result.outcome !== "accepted") {
    const error = new Error("delivery is unknown and the message must not be resent");
    error.exitCode = 4;
    throw error;
  }
  const label = result.delivery === 2 ? "accepted, queued" : "accepted";
  stdout(label + (result.messageId ? " message " + result.messageId : "") + "\n");
  let confirmEntries = [];
  try {
    const page = await getTranscriptTail(session.route, bot.id, 40, ctx);
    confirmEntries = entriesOf(page);
    stdout(findReceipt(confirmEntries, nonce, text) ? "receipt: confirmed\n" : "receipt: not in the transcript yet\n");
  } catch {
    stdout("receipt: transcript check failed\n");
  }
  if (waitSec) {
    try {
      await waitForReply({
        session,
        bot,
        nonce,
        text,
        beforeKeys,
        confirmEntries,
        messageId: result.messageId,
        waitSec,
        deps,
        stdout,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "the follow-up failed";
      const wrapped = new Error("message was sent and must not be resent: " + detail);
      wrapped.exitCode = 3;
      throw wrapped;
    }
  }
  return 0;
}

async function cmdCreate(flags, deps, stdout) {
  const name = String(flags.name ?? "").trim();
  if (!name) throw new Error("missing --name");
  const instructions = readInstructions(flags["instructions-file"]);
  beginMutation(stdout, name, instructions, flags.yes);
  const session = await openSession(deps);
  const record = await createAgent(session.route, { name, description: instructions }, callCtx(session));
  stdout("created " + record.name + " (" + record.id + ")\n");
  return 0;
}

async function cmdUpdate(positionals, flags, deps, stdout) {
  const ref = positionals[0];
  if (!ref || positionals.length > 1) {
    throw new Error("usage: grokbot bot update <bot id|name> --instructions-file <file> [--name <name>] --yes");
  }
  if (flags.name != null && !String(flags.name).trim()) throw new Error("name cannot be blank");
  const instructions = readInstructions(flags["instructions-file"]);
  beginMutation(stdout, ref, instructions, flags.yes);
  const session = await openSession(deps);
  const ctx = callCtx(session);
  const bot = resolveBot(await listAgents(session.route, ctx), ref);
  const patch = { description: instructions };
  if (flags.name != null) patch.name = String(flags.name).trim();
  const record = await updateAgent(session.route, bot, patch, ctx);
  stdout("updated " + record.name + " (" + record.id + ")\n");
  return 0;
}

async function cmdDoctor(deps, stdout) {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const env = credentialEnv(deps);
  const version = sessionVersion(deps, platform);
  stdout("client version: " + version + "\n");
  let failed = false;
  const mark = (name, ok, reason) => {
    if (ok) {
      stdout(name + ": pass\n");
      return;
    }
    failed = true;
    stdout(name + ": fail (" + (reason || "failed") + ")\n");
  };
  let fileOk = false;
  if (platform !== "darwin") mark("app data file", false, "macOS only");
  else {
    fileOk = existsSync(appSecretsPath(home, platform));
    mark("app data file", fileOk, "not found");
  }
  const getPassword = deps.getKeychainPassword ?? readKeychainPassword;
  let password;
  try {
    password = getPassword();
    if (typeof password !== "string" || password.length === 0) throw new Error("empty");
    rememberScoped(deps.stdoutSecrets, deps.stderrSecrets, password, true);
    mark("keychain item", true);
  } catch {
    mark("keychain item", false, "not readable");
  }
  let creds;
  if (fileOk && typeof password === "string" && password.length > 0) {
    try {
      creds = loadCredentials({ home, platform, getKeychainPassword: () => password });
      assertVisibleHeader(creds.accessToken, "access token");
      rememberScoped(deps.stdoutSecrets, deps.stderrSecrets, creds.accessToken, true);
      rememberScoped(deps.stdoutSecrets, deps.stderrSecrets, creds.teamId, false);
      mark("token decrypts", true);
    } catch (error) {
      mark("token decrypts", false, error instanceof Error ? error.message : "failed");
    }
  } else mark("token decrypts", false, "not available");
  if (creds) {
    try {
      await ensureSandbox(creds.accessToken, {
        teamId: creds.teamId,
        env,
        fetchImpl: deps.fetchImpl,
        secrets: deps.stderrSecrets,
        stdoutSecrets: deps.stdoutSecrets,
        version,
      });
      mark("EnsureSandBox", true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed";
      mark("EnsureSandBox", false, message);
      if (/no longer supported/i.test(message)) {
        stdout("hint: EnsureSandBox rejected client version " + version + ". Update Grok Bot, or set GROKBOT_CLIENT_VERSION to the installed app version.\n");
      }
    }
  } else mark("EnsureSandBox", false, "no token");
  return failed ? 1 : 0;
}

function globalAction(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") return null;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--version" || arg === "-V") return "version";
    if (arg === "--json" || arg === "--dry-run" || arg === "--yes") continue;
    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0];
      if (VALUE_FLAGS.has(name) && !arg.includes("=")) index += 1;
      continue;
    }
    return null;
  }
  return null;
}

async function dispatch(argv, deps, stdout) {
  if (argv.length === 0) {
    stdout(HELP);
    return 0;
  }
  const action = globalAction(argv);
  if (action === "help") {
    stdout(HELP);
    return 0;
  }
  if (action === "version") {
    stdout(VERSION + "\n");
    return 0;
  }
  const { positionals, flags } = parseArgs(argv);
  const [command, sub, ...rest] = positionals;
  if (command === "bots") {
    if (sub) throw new Error("unknown command");
    return cmdBots(flags, deps, stdout);
  }
  if (command === "thread") return cmdThread([sub, ...rest].filter((item) => item != null), flags, deps, stdout);
  if (command === "send") return cmdSend([sub, ...rest].filter((item) => item != null), flags, deps, stdout);
  if (command === "doctor") {
    if (sub) throw new Error("unknown command");
    return cmdDoctor(deps, stdout);
  }
  if (command === "bot") {
    if (sub === "create") {
      if (rest.length > 0) throw new Error("unexpected argument");
      return cmdCreate(flags, deps, stdout);
    }
    if (sub === "update") return cmdUpdate(rest, flags, deps, stdout);
    throw new Error("usage: grokbot bot create|update");
  }
  throw new Error("unknown command \"" + (command ?? "") + "\"");
}

function presentError(message, secrets) {
  const scrubbed = scrubText(message, secrets).replace(/\s+/g, " ").trim();
  return scrubbed.length > 300 ? scrubbed.slice(0, 300) : scrubbed;
}

export async function main(argv, deps = {}) {
  const stdoutSecrets = deps.stdoutSecrets ?? new Set();
  const stderrSecrets = deps.stderrSecrets ?? deps.secrets ?? new Set();
  deps.stdoutSecrets = stdoutSecrets;
  deps.stderrSecrets = stderrSecrets;
  deps.secrets = stderrSecrets;
  const writeOut = deps.stdout ?? ((chunk) => process.stdout.write(chunk));
  const writeErr = deps.stderr ?? ((chunk) => process.stderr.write(chunk));
  const stdout = (chunk) => writeOut(scrubText(chunk, stdoutSecrets));
  const stderr = (chunk) => writeErr(scrubText(chunk, stderrSecrets));
  const debug = deps.env?.GROKBOT_DEBUG === "1" || process.env.GROKBOT_DEBUG === "1";
  try {
    return await dispatch(argv, deps, stdout) ?? 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(presentError(message, stderrSecrets) + "\n");
    if (debug) stderr(scrubText(error instanceof Error ? error.stack || "" : "", stderrSecrets) + "\n");
    if (error.exitCode === 3 || error.exitCode === 4) return error.exitCode;
    return 1;
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code || 0;
  });
}
