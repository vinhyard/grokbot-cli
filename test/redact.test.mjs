import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureSandbox } from "../src/backend.mjs";
import { redact } from "../src/redact.mjs";
import { startServer } from "./helpers/server.mjs";

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
