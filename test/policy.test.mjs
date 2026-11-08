import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAllowedCredentialUrl, ensureSandbox, readTestBase, routingHeaders } from "../src/backend.mjs";
import { sendJson, startServer } from "./helpers/server.mjs";

test("gateway hosts may be cursorvm.com and backends may not", () => {
  const env = {};
  assert.equal(
    assertAllowedCredentialUrl("https://abc.cursorvm.com/box", env, "gateway").startsWith("https://abc.cursorvm.com"),
    true,
  );
  const longHost = "a".repeat(40) + ".example.com";
  for (const raw of [
    "https://cursorvm.com.evil.com/gw",
    "https://notcursorvm.com/gw",
    "https://evilcursorvm.com/gw",
    "https://" + longHost + "/secret/path?q=1",
  ]) {
    assert.throws(() => assertAllowedCredentialUrl(raw, env, "gateway"), (error) => {
      assert.match(error.message, /Rejected credential URL host/);
      assert.equal(error.message.includes("/"), false);
      assert.equal(error.message.includes("?"), false);
      assert.equal(error.message.includes("secret"), false);
      assert.equal(error.message.includes("a".repeat(40)), false);
      return true;
    });
  }
  assert.throws(() => assertAllowedCredentialUrl("https://abc.cursorvm.com.evil.com/gw", env, "gateway"), /host "evil\.com"/);
  assert.throws(() => assertAllowedCredentialUrl("http://abc.cursorvm.com/gw", env, "gateway"), /only https/);
  assert.throws(() => assertAllowedCredentialUrl("https://user:pw@abc.cursorvm.com/gw", env, "gateway"), /userinfo/);
  assert.throws(() => assertAllowedCredentialUrl("https://abc.cursorvm.com/box", env, "backend"), /cursorvm\.com/);
  assert.throws(() => assertAllowedCredentialUrl("https://cursorvm.com/box", env, "backend"), /Rejected credential URL host/);
});

test("host policy rejects non-cursor hosts, http, and userinfo", () => {
  const env = {};
  assert.equal(assertAllowedCredentialUrl("https://api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox", env).startsWith("https://api2.cursor.sh"), true);
  assert.doesNotThrow(() => assertAllowedCredentialUrl("https://cursor.com/x", env));
  assert.doesNotThrow(() => assertAllowedCredentialUrl("https://api.cursor.com/x", env));
  assert.throws(() => assertAllowedCredentialUrl("http://api2.cursor.sh/x", env), /only https/);
  assert.throws(() => assertAllowedCredentialUrl("https://evil.example/x", env), /Rejected credential URL host/);
  assert.throws(() => assertAllowedCredentialUrl("https://api2.cursor.sh.evil.com/x", env), /Rejected credential URL host/);
  assert.throws(() => assertAllowedCredentialUrl("https://notcursor.sh/x", env), /Rejected credential URL host/);
  assert.throws(() => assertAllowedCredentialUrl("https://user:secret@api2.cursor.sh/x", env), /userinfo/);
  assert.throws(() => assertAllowedCredentialUrl("http://127.0.0.1:9/x", env), /only https/);
});

test("the test seam is loopback http with a port and replaces other hosts", () => {
  assert.equal(readTestBase({}), null);
  assert.equal(readTestBase({ GROKBOT_TEST_BASE_URL: "" }), null);
  assert.equal(readTestBase({ GROKBOT_TEST_BASE_URL: "http://127.0.0.1:9" }), "http://127.0.0.1:9");
  assert.equal(readTestBase({ GROKBOT_TEST_BASE_URL: "http://[::1]:9" }), "http://[::1]:9");
  for (const bad of [
    "http://localhost:9",
    "https://127.0.0.1:9",
    "http://127.0.0.1",
    "http://8.8.8.8:9",
    "http://127.0.0.1:9/api",
    "http://user:pass@127.0.0.1:9",
    "https://api2.cursor.sh",
  ]) {
    assert.throws(() => readTestBase({ GROKBOT_TEST_BASE_URL: bad }), /GROKBOT_TEST_BASE_URL/);
  }
  const env = { GROKBOT_TEST_BASE_URL: "http://127.0.0.1:9" };
  assert.doesNotThrow(() => assertAllowedCredentialUrl("http://127.0.0.1:9/api/listAgents", env));
  assert.throws(() => assertAllowedCredentialUrl("https://api2.cursor.sh/x", env), /test mode/);
  assert.throws(() => assertAllowedCredentialUrl("http://127.0.0.1:10/x", env), /test mode/);
  const v6 = { GROKBOT_TEST_BASE_URL: "http://[::1]:9" };
  assert.doesNotThrow(() => assertAllowedCredentialUrl("http://[::1]:9/api/listAgents", v6));
});

test("routing headers drop echoed identity headers", () => {
  const headers = routingHeaders({
    gatewayHeaders: {
      "x-anyrun-network-token": "route-token",
      "x-ghost-mode": "true",
      "x-cursor-client-source": "source-desktop",
      authorization: "Bearer no",
    },
  });
  assert.deepEqual(headers, { "x-anyrun-network-token": "route-token" });
});

test("redirects are not followed", async () => {
  const token = "tok_" + "a".repeat(48);
  let origin = "";
  const server = await startServer((record, res) => {
    res.writeHead(302, { location: origin + "/stolen" });
    res.end();
  });
  origin = server.origin;
  try {
    let threw = false;
    try {
      await ensureSandbox(token, { env: { GROKBOT_TEST_BASE_URL: origin }, version: "0.0.0-test" });
    } catch (error) {
      threw = true;
      if (String(error.message).includes(token)) throw new Error("error text leaked a credential");
      assert.match(error.message, /EnsureSandBox failed/);
    }
    assert.equal(threw, true);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests.some((record) => record.url.includes("/stolen")), false);
  } finally {
    await server.close();
  }
});

test("a gateway URL outside the test seam is refused before another fetch", async () => {
  const token = "tok_" + "b".repeat(48);
  let fetches = 0;
  const server = await startServer((record, res) => {
    fetches += 1;
    sendJson(res, { gatewayUrl: "https://evil.example/box", gatewayToken: "gw-" + "c".repeat(40) });
  });
  try {
    let threw = false;
    try {
      await ensureSandbox(token, { env: { GROKBOT_TEST_BASE_URL: server.origin }, version: "0.0.0-test" });
    } catch (error) {
      threw = true;
      if (String(error.message).includes(token)) throw new Error("error text leaked a credential");
      assert.match(error.message, /Rejected credential URL host/);
    }
    assert.equal(threw, true);
    assert.equal(fetches, 1);
  } finally {
    await server.close();
  }
});

test("oversized responses are rejected before they are buffered", async () => {
  let reads = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  let threw = false;
  try {
    await ensureSandbox("tok", {
      version: "0.0.0-test",
      env: { GROKBOT_TEST_BASE_URL: "http://127.0.0.1:9" },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader() {
            return {
              async read() {
                reads += 1;
                if (reads > 3) return { done: true, value: undefined };
                return { done: false, value: chunk };
              },
              async cancel() {
                cancelled = true;
              },
            };
          },
        },
      }),
    });
  } catch (error) {
    threw = true;
    assert.match(error.message, /response too large/);
  }
  assert.equal(threw, true);
  assert.equal(cancelled, true);
  assert.ok(reads < 4);

  let earlyCancel = false;
  let threwEarly = false;
  try {
    await ensureSandbox("tok", {
      version: "0.0.0-test",
      env: { GROKBOT_TEST_BASE_URL: "http://127.0.0.1:9" },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (name) => name === "content-length" ? String(2 * 1024 * 1024 + 1) : null },
        body: {
          getReader() {
            throw new Error("should not read");
          },
          async cancel() {
            earlyCancel = true;
          },
        },
      }),
    });
  } catch (error) {
    threwEarly = true;
    assert.match(error.message, /response too large/);
    assert.equal(error.message.includes("should not read"), false);
  }
  assert.equal(threwEarly, true);
  assert.equal(earlyCancel, true);
});
