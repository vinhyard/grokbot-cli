import assert from "node:assert/strict";
import { test } from "node:test";
import { assertMessageSize } from "../src/backend.mjs";
import {
  POLL_INTERVAL_MS,
  createReadBudget,
  findNewReply,
  pollAbortSignal,
  pollDelay,
  resolveBot,
} from "../src/gateway.mjs";

test("message limit is 16 KiB", () => {
  assert.equal(assertMessageSize("a".repeat(16 * 1024)), "a".repeat(16 * 1024));
  assert.throws(() => assertMessageSize("a".repeat(16 * 1024 + 1)), /16 KiB/);
  assert.throws(() => assertMessageSize("   "), /empty/);
});

test("a polling signal aborts when the remaining wait ends", async () => {
  const signal = pollAbortSignal(Date.now() + 20, Date.now);
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    if (signal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
  assert.equal(signal.aborted, true);
});

test("gateway reads stop after 60 and polls wait at least 2 seconds", () => {
  const budget = createReadBudget();
  for (let count = 0; count < 60; count += 1) budget.charge();
  assert.throws(() => budget.charge(), /60 gateway reads/);
  assert.ok(POLL_INTERVAL_MS >= 2000);
  assert.equal(pollDelay(POLL_INTERVAL_MS), POLL_INTERVAL_MS);
  assert.equal(pollDelay(100), 2000);
});

test("resolveBot accepts only an id or one exact bot name", () => {
  const records = [
    { id: "bot-1", name: "Alpha", isGroup: false },
    { id: "bot-2", name: "Alpha", isGroup: false },
    { id: "g-1", name: "Group", isGroup: true },
    { id: "bot-3", name: "Beta", isGroup: false },
  ];
  assert.equal(resolveBot(records, "bot-1").id, "bot-1");
  assert.equal(resolveBot(records, "Beta").id, "bot-3");
  assert.throws(() => resolveBot(records, "Alpha"), /ambiguous/);
  assert.throws(() => resolveBot(records, "Group"), /not one of this account's bots/);
  assert.throws(() => resolveBot(records, "alpha"), /not one of this account's bots/);
  assert.throws(() => resolveBot(records, "missing"), /not one of this account's bots/);
});

test("a new bot reply ignores the sent message and older entries", () => {
  const before = new Set(["id:old"]);
  const reply = findNewReply([
    { id: "old", role: "assistant", text: "earlier" },
    { id: "u1", role: "user", text: "hello", clientNonce: "n1" },
    { id: "r1", role: "assistant", text: "pong" },
  ], before, "n1", "hello");
  assert.equal(reply.id, "r1");
});
