import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureSandbox } from "../src/backend.mjs";
import { redact, scrubText } from "../src/redact.mjs";
import { startServer } from "./helpers/server.mjs";

test("scrubs exact secrets the pattern filter would keep", () => {
  const token = "t:1!";
  const password = "p!q";
  const team = "8675309";
  const gateway = "g:w%";
  const routing = "h%1";
  const broken = "bad\r\nvalue";
  const nodeError = 'Headers.append: "Bearer ' + token + '" is an invalid header value. '
    + [password, team, gateway, routing, broken].join(" ");
  assert.equal(redact(nodeError).includes(token), true);
  const cleaned = scrubText(nodeError, [token, password, team, gateway, routing, broken]);
  for (const secret of [token, password, team, gateway, routing, broken]) {
    if (cleaned.includes(secret)) throw new Error("error text leaked a credential");
  }
  assert.match(cleaned, /\[redacted\]/);
});

test("redacts bearer tokens and long opaque strings", () => {
  const token = "ya29." + "A".repeat(50);
  const text = redact("failed Bearer " + token + " tail " + token);
  if (text.includes(token)) throw new Error("error text leaked a credential");
  assert.match(text, /Bearer \[redacted\]/);
  assert.match(text, /\[redacted\]/);
});

test("EnsureSandBox error text does not include the token", async () => {
  const token = "access-" + "B".repeat(48);
  const server = await startServer((record, res) => {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("Bearer " + token);
  });
  try {
    let threw = false;
    try {
      await ensureSandbox(token, { env: { GROKBOT_TEST_BASE_URL: server.origin } });
    } catch (error) {
      threw = true;
      if (String(error.message).includes(token)) throw new Error("error text leaked a credential");
      assert.match(error.message, /EnsureSandBox failed: 401/);
      assert.match(error.message, /\[redacted\]/);
    }
    assert.equal(threw, true);
  } finally {
    await server.close();
  }
});
