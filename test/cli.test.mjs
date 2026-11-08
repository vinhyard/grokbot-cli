import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../bin/grokbot.mjs";
import { decodeFields, encodeStringField, encodeVarintField } from "../src/proto.mjs";
import { sendJson, startServer } from "./helpers/server.mjs";
import { assertNoSecrets, writeAccount } from "./helpers/secrets.mjs";

const password = "pw-" + "P".repeat(32);
const token = "access-" + "A".repeat(48);
const gatewayToken = "gateway-" + "G".repeat(48);

function textField(fields, number) {
  const found = fields.find((field) => field.field === number && field.wire === 2);
  return found ? new TextDecoder().decode(found.value) : "";
}

function acceptedFrame() {
  return Buffer.concat([
    Buffer.from(encodeVarintField(1, 1)),
    Buffer.from(encodeStringField(3, "m-1")),
    Buffer.from(encodeVarintField(4, 1)),
  ]);
}

async function withApp(run) {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-cli-"));
  const home = join(dir, "home");
  writeAccount(home, { password, token });
  const state = {
    agents: [
      { id: "bot-1", name: "Alpha", description: "old", isGroup: false },
      { id: "g-1", name: "Group", isGroup: true, memberIds: ["bot-1"] },
    ],
    tails: 0,
    lastNonce: "",
    lastText: "",
    sendFields: [],
    created: null,
    updated: null,
  };
  let origin = "";
  const server = await startServer((record, res) => {
    if (record.url.includes("EnsureSandBox")) {
      sendJson(res, { gatewayUrl: origin, gatewayToken, gatewayHeaders: { "x-anyrun-network-token": "route" } });
      return;
    }
    if (record.url.endsWith("/api/listAgents")) {
      sendJson(res, { agents: state.agents });
      return;
    }
    if (record.url.endsWith("/api/getAgentTranscriptTail")) {
      state.tails += 1;
      if (state.failPoll && state.tails >= 3) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("poll failed");
        return;
      }
      const old = { id: "old", role: "assistant", text: "earlier" };
      const own = { id: "u1", role: "user", text: state.lastText, clientNonce: state.lastNonce };
      sendJson(res, { entries: state.tails === 1 ? [old] : [old, own] });
      return;
    }
    if (record.url.endsWith("/api/getAgentThread")) {
      const entries = [
        { id: "old", role: "assistant", text: "earlier" },
        { id: "u1", role: "user", text: state.lastText, clientNonce: state.lastNonce },
      ];
      if (!state.holdReply) entries.push({ id: "r1", role: "assistant", text: "pong" });
      sendJson(res, { entries });
      return;
    }
    if (record.url.includes("SendGrokBotUserMessage")) {
      const fields = decodeFields(record.body);
      state.sendFields = fields.map((field) => field.field);
      state.lastNonce = textField(fields, 2);
      state.lastText = textField(fields, 3);
      res.writeHead(200, { "content-type": "application/proto" });
      res.end(acceptedFrame());
      return;
    }
    if (record.url.endsWith("/api/createAgent")) {
      state.created = JSON.parse(record.body.toString("utf8"));
      sendJson(res, {
        agent: {
          id: "bot-new",
          name: state.created.name,
          description: state.created.description,
          isGroup: false,
        },
      });
      return;
    }
    if (record.url.endsWith("/api/updateAgent")) {
      state.updated = JSON.parse(record.body.toString("utf8"));
      state.agents = state.agents.map((agent) => agent.id === state.updated.id
        ? { ...agent, name: state.updated.profile.name, description: state.updated.profile.description }
        : agent);
      sendJson(res, {});
      return;
    }
    res.writeHead(404);
    res.end();
  });
  origin = server.origin;
  const out = [];
  const err = [];
  const deps = {
    platform: "darwin",
    home,
    env: { GROKBOT_TEST_BASE_URL: origin },
    getKeychainPassword: () => password,
    stdout: (chunk) => out.push(chunk),
    stderr: (chunk) => err.push(chunk),
    sleep: async () => {
      throw new Error("polled too soon");
    },
  };
  try {
    return await run({
      deps,
      state,
      requests: server.requests,
      stdout: () => out.join(""),
      stderr: () => err.join(""),
      dir,
    });
  } finally {
    try {
      assertNoSecrets(out.join("") + err.join(""), [password, token, gatewayToken]);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

test("help and version", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const help = [];
  assert.equal(await main(["--help"], { stdout: (chunk) => help.push(chunk), stderr: () => {} }), 0);
  assert.match(help.join(""), /experimental, untested against the live service/);
  const version = [];
  assert.equal(await main(["--version"], { stdout: (chunk) => version.push(chunk), stderr: () => {} }), 0);
  assert.equal(version.join(""), pkg.version + "\n");
  assert.equal(pkg.private, true);
});

test("--dry-run makes no send request and prints no token", async () => {
  let called = false;
  const out = [];
  const code = await main(["send", "Alpha", "hello", "--dry-run"], {
    platform: "linux",
    env: {},
    fetchImpl: () => {
      called = true;
      throw new Error("network");
    },
    getKeychainPassword: () => {
      called = true;
      return "x";
    },
    stdout: (chunk) => out.push(chunk),
    stderr: (chunk) => out.push(chunk),
  });
  assert.equal(called, false);
  assert.equal(code, 0);
  assert.match(out.join(""), /dry-run/);
  assert.match(out.join(""), /source-field: omitted/);
  assert.match(out.join(""), /hello/);
});

test("a message over 16 KiB never reaches the network", async () => {
  let called = false;
  const err = [];
  const code = await main(["send", "Alpha", "a".repeat(16 * 1024 + 1)], {
    fetchImpl: () => {
      called = true;
    },
    getKeychainPassword: () => {
      called = true;
      return "x";
    },
    stdout: () => {},
    stderr: (chunk) => err.push(chunk),
  });
  assert.equal(called, false);
  assert.equal(code, 1);
  assert.match(err.join(""), /16 KiB/);
});

test("send refuses a target that is not in the bot list", async () => {
  const code = await withApp(async ({ deps, requests, stderr }) => {
    const result = await main(["send", "Missing", "hello"], deps);
    assert.equal(result, 1);
    assert.match(stderr(), /not one of this account's bots/);
    assert.equal(requests.some((record) => record.url.includes("SendGrokBotUserMessage")), false);
    return result;
  });
  assert.equal(code, 1);
});

test("send accepts a listed bot without claiming a desktop identity", async () => {
  const code = await withApp(async ({ deps, state, requests, stdout }) => {
    const result = await main(["send", "Alpha", "hello", "--wait", "9"], deps);
    assert.equal(result, 0);
    assert.deepEqual(requests.map((record) => record.url), [
      "/aiserver.v1.GrokBotService/EnsureSandBox",
      "/api/listAgents",
      "/api/getAgentTranscriptTail",
      "/aiserver.v1.GrokBotService/SendGrokBotUserMessage",
      "/api/getAgentTranscriptTail",
      "/api/getAgentThread",
    ]);
    assert.deepEqual(state.sendFields, [1, 2, 3, 4, 16, 20]);
    assert.equal(state.sendFields.includes(13), false);
    assert.equal(state.lastText, "hello");
    const send = requests.find((record) => record.url.includes("SendGrokBotUserMessage"));
    const sandbox = requests[0];
    for (const record of [send, sandbox]) {
      for (const name of ["x-ghost-mode", "x-cursor-client-source", "source"]) {
        assert.equal(name in record.headers, false);
      }
      assert.equal(record.headers["x-cursor-client-type"], "sand");
      assert.equal(record.headers["x-cursor-client-version"], "0.20.0");
      assert.equal(record.headers["x-sand-box-namespace"], "prod");
    }
    if (send.headers.authorization !== "Bearer " + token) throw new Error("authorization header mismatch");
    assert.equal(send.headers["content-type"], "application/proto");
    assert.equal(send.headers["x-cursor-team-id"], undefined);
    const thread = requests.find((record) => record.url.endsWith("/api/getAgentThread"));
    assert.deepEqual(JSON.parse(thread.body.toString("utf8")), { id: "bot-1", rootId: "m-1" });
    const text = stdout();
    assert.match(text, /accepted message m-1/);
    assert.match(text, /receipt: confirmed/);
    assert.match(text, /\[assistant r1\] pong/);
    return result;
  });
  assert.equal(code, 0);
});

test("bots and thread read the gateway", async () => {
  await withApp(async ({ deps, requests, stdout }) => {
    assert.equal(await main(["bots"], deps), 0);
    assert.match(stdout(), /bot-1 {2}Alpha/);
    assert.equal(stdout().includes("g-1"), false);
    const json = [];
    assert.equal(await main(["bots", "--json"], {
      ...deps,
      stdout: (chunk) => {
        json.push(chunk);
        deps.stdout(chunk);
      },
    }), 0);
    assert.deepEqual(JSON.parse(json.join("")), [{ id: "bot-1", name: "Alpha" }]);
    const threadOut = [];
    assert.equal(await main(["thread", "Alpha", "--limit", "5"], {
      ...deps,
      stdout: (chunk) => {
        threadOut.push(chunk);
        deps.stdout(chunk);
      },
    }), 0);
    assert.match(threadOut.join(""), /bot {2}Alpha/);
    assert.match(threadOut.join(""), /\[assistant old\] earlier/);
    const tail = requests.find((record) => record.url.endsWith("/api/getAgentTranscriptTail"));
    assert.deepEqual(JSON.parse(tail.body.toString("utf8")), { id: "bot-1", limit: 5 });
    return 0;
  });
});

test("create and update require --yes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-yes-"));
  const file = join(dir, "inst.txt");
  writeFileSync(file, "Be brief.\n");
  try {
    let called = false;
    const out = [];
    const err = [];
    const deps = {
      platform: "linux",
      env: {},
      fetchImpl: () => {
        called = true;
      },
      getKeychainPassword: () => {
        called = true;
        return "x";
      },
      stdout: (chunk) => out.push(chunk),
      stderr: (chunk) => err.push(chunk),
    };
    const created = await main(["bot", "create", "--name", "NewBot", "--instructions-file", file], deps);
    const updated = await main(["bot", "update", "Alpha", "--instructions-file", file], deps);
    assert.equal(called, false);
    assert.equal(created, 1);
    assert.equal(updated, 1);
    const text = out.join("");
    assert.match(text, /experimental, untested against the live service/);
    assert.match(text, /target: NewBot/);
    assert.match(text, /target: Alpha/);
    assert.match(text, /instructions: 10 bytes/);
    assert.match(err.join(""), /without --yes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create and update with --yes use the gateway shapes", async () => {
  await withApp(async ({ deps, state, dir, stdout }) => {
    const createdFile = join(dir, "create.txt");
    const updatedFile = join(dir, "update.txt");
    writeFileSync(createdFile, "Be brief.\n");
    writeFileSync(updatedFile, "New instructions");
    assert.equal(await main(["bot", "create", "--name", "NewBot", "--instructions-file", createdFile, "--yes"], deps), 0);
    assert.deepEqual(state.created, {
      name: "NewBot",
      description: "Be brief.\n",
      title: "",
      avatarShape: "",
      avatarColor: "",
      origin: "user",
    });
    assert.match(stdout(), /created NewBot \(bot-new\)/);
    assert.equal(await main(["bot", "update", "Alpha", "--name", "Renamed", "--instructions-file", updatedFile, "--yes"], deps), 0);
    assert.deepEqual(state.updated, {
      id: "bot-1",
      profile: { name: "Renamed", description: "New instructions" },
    });
    assert.match(stdout(), /updated Renamed \(bot-1\)/);
    return 0;
  });
});

test("doctor reports the local checks without printing secrets", async () => {
  const code = await withApp(async ({ deps, stdout }) => {
    const result = await main(["doctor"], deps);
    const text = stdout();
    assert.match(text, /app data file: pass/);
    assert.match(text, /keychain item: pass/);
    assert.match(text, /token decrypts: pass/);
    assert.match(text, /EnsureSandBox: pass/);
    return result;
  });
  assert.equal(code, 0);
});

test("send on a non-macOS platform fails before using credentials", async () => {
  let called = false;
  const err = [];
  const code = await main(["send", "Alpha", "hello"], {
    platform: "linux",
    env: {},
    fetchImpl: () => {
      called = true;
    },
    getKeychainPassword: () => {
      called = true;
      return "x";
    },
    stdout: () => {},
    stderr: (chunk) => err.push(chunk),
  });
  assert.equal(called, false);
  assert.equal(code, 1);
  assert.match(err.join(""), /macOS/);
});

test("a test base without injected credentials is refused", async () => {
  let called = false;
  const err = [];
  const code = await main(["bots"], {
    platform: "darwin",
    env: { GROKBOT_TEST_BASE_URL: "http://127.0.0.1:9" },
    fetchImpl: () => {
      called = true;
    },
    stdout: () => {},
    stderr: (chunk) => err.push(chunk),
  });
  assert.equal(called, false);
  assert.equal(code, 1);
  assert.match(err.join(""), /test base URL requires injected credentials/);
});

test("GROKBOT_TEST_BASE_URL in process.env is not used with keychain credentials", async () => {
  const previous = process.env.GROKBOT_TEST_BASE_URL;
  process.env.GROKBOT_TEST_BASE_URL = "http://127.0.0.1:9";
  const home = mkdtempSync(join(tmpdir(), "grokbot-seam-"));
  const urls = [];
  try {
    writeAccount(home, { password, token });
    const code = await main(["bots"], {
      platform: "darwin",
      home,
      getKeychainPassword: () => password,
      fetchImpl: async (url) => {
        urls.push(String(url));
        throw new Error("blocked");
      },
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(code, 1);
    assert.equal(urls.some((url) => url.includes("127.0.0.1")), false);
    assert.equal(urls[0].startsWith("https://api2.cursor.sh/"), true);
  } finally {
    if (previous === undefined) delete process.env.GROKBOT_TEST_BASE_URL;
    else process.env.GROKBOT_TEST_BASE_URL = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("stdout and stderr scrub secrets the regex would miss", async () => {
  const oddToken = "t:1!";
  const oddPassword = "p!q";
  const team = "8675309";
  const oddGateway = "g:w%";
  const routing = "h%1";
  const home = mkdtempSync(join(tmpdir(), "grokbot-scrub-"));
  const origin = "http://127.0.0.1:9";
  const err = [];
  try {
    writeAccount(home, { password: oddPassword, token: oddToken, team });
    const code = await main(["bots"], {
      platform: "darwin",
      home,
      env: { GROKBOT_TEST_BASE_URL: origin },
      getKeychainPassword: () => oddPassword,
      fetchImpl: async (url) => {
        if (String(url).includes("EnsureSandBox")) {
          return Response.json({
            gatewayUrl: origin,
            gatewayToken: oddGateway,
            gatewayHeaders: { "x-anyrun-network-token": routing },
          });
        }
        throw new Error(
          'Headers.append: "Bearer ' + oddGateway + '" is an invalid header value. '
          + oddToken + " " + oddPassword + " " + team + " " + routing,
        );
      },
      stdout: () => {},
      stderr: (chunk) => err.push(chunk),
    });
    assert.equal(code, 1);
    const text = err.join("");
    assertNoSecrets(text, [oddToken, oddPassword, team, oddGateway, routing]);
    assert.match(text, /\[redacted\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unsafe gateway token is rejected without echoing it", async () => {
  const broken = "bad\r\nvalue";
  const home = mkdtempSync(join(tmpdir(), "grokbot-unsafe-"));
  const origin = "http://127.0.0.1:9";
  const err = [];
  let continued = false;
  try {
    writeAccount(home, { password, token });
    const code = await main(["bots"], {
      platform: "darwin",
      home,
      env: { GROKBOT_TEST_BASE_URL: origin },
      getKeychainPassword: () => password,
      fetchImpl: async (url) => {
        if (!String(url).includes("EnsureSandBox")) continued = true;
        return Response.json({ gatewayUrl: origin, gatewayToken: broken });
      },
      stdout: () => {},
      stderr: (chunk) => err.push(chunk),
    });
    assert.equal(code, 1);
    assert.equal(continued, false);
    assert.match(err.join(""), /rejected an unsafe gateway token/);
    assertNoSecrets(err.join(""), [broken]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a follow-up failure after an accepted send exits 3", async () => {
  await withApp(async ({ deps, state, requests, stdout, stderr }) => {
    state.holdReply = true;
    let clock = 0;
    const signals = [];
    deps.now = () => clock;
    deps.sleep = async () => {
      clock += 3000;
    };
    deps.fetchImpl = (url, options) => {
      const target = String(url);
      if (target.includes("getAgentThread") || (target.includes("getAgentTranscriptTail") && state.tails >= 2)) {
        signals.push(options.signal);
      }
      return fetch(url, options);
    };
    const code = await main(["send", "Alpha", "hello", "--wait", "3"], deps);
    assert.equal(code, 3);
    assert.match(stdout(), /accepted message m-1/);
    assert.match(stderr(), /message was sent and must not be resent/);
    assert.equal(requests.filter((record) => record.url.includes("SendGrokBotUserMessage")).length, 1);
    assert.ok(signals.length >= 1);
    assert.equal(signals.every((signal) => signal && typeof signal.aborted === "boolean"), true);
    return code;
  });
});

test("a poll error after an accepted send exits 3", async () => {
  await withApp(async ({ deps, state, stderr, requests }) => {
    state.holdReply = true;
    state.failPoll = true;
    let clock = 0;
    deps.now = () => clock;
    deps.sleep = async () => {
      clock += 3000;
    };
    const code = await main(["send", "Alpha", "hello", "--wait", "3"], deps);
    assert.equal(code, 3);
    assert.match(stderr(), /message was sent and must not be resent/);
    assert.match(stderr(), /poll failed|getAgentTranscriptTail failed/);
    assert.equal(requests.filter((record) => record.url.includes("SendGrokBotUserMessage")).length, 1);
    return code;
  });
});

test("help and version are ignored after the command", async () => {
  const out = [];
  const err = [];
  const code = await main(["send", "Alpha", "--dry-run", "--", "-h"], {
    platform: "linux",
    env: {},
    stdout: (chunk) => out.push(chunk),
    stderr: (chunk) => err.push(chunk),
  });
  assert.equal(code, 0);
  assert.match(out.join(""), /text:\n-h\n/);
  assert.equal(out.join("").includes("Usage:"), false);
  assert.equal(err.join(""), "");
});

test("stdin strips one trailing newline", async () => {
  const bin = fileURLToPath(new URL("../bin/grokbot.mjs", import.meta.url));
  const child = spawn(process.execPath, [bin, "send", "Alpha", "-", "--dry-run"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  child.stdin.end("hello\n");
  const code = await new Promise((resolve) => child.on("close", resolve));
  const text = Buffer.concat(chunks).toString("utf8");
  assert.equal(code, 0);
  assert.match(text, /text:\nhello\n$/);
  assert.equal(text.includes("hello\n\n"), false);
});

test("instructions file errors name the real failure and cap the size", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-inst-"));
  const err = [];
  let called = false;
  const deps = {
    platform: "linux",
    env: {},
    fetchImpl: () => {
      called = true;
    },
    stdout: () => {},
    stderr: (chunk) => err.push(chunk),
  };
  try {
    const missing = await main(["bot", "create", "--name", "NewBot", "--instructions-file", dir, "--yes"], deps);
    assert.equal(missing, 1);
    assert.match(err.join(""), /instructions file: EISDIR/);
    const big = join(dir, "big.txt");
    writeFileSync(big, Buffer.alloc(64 * 1024 + 1, 0x61));
    const capped = await main(["bot", "create", "--name", "NewBot", "--instructions-file", big, "--yes"], deps);
    assert.equal(capped, 1);
    assert.match(err.join(""), /exceeds 64 KiB/);
    assert.equal(called, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
