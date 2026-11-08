import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyDelivery,
  decodeFields,
  decodeSendResponse,
  encodeSendRequest,
  encodeStringField,
} from "../src/proto.mjs";

test("send request encodes the known bytes and omits the source field", () => {
  const bytes = encodeSendRequest({
    agentId: "a",
    nonce: "n",
    text: "hi",
    sentAtMs: 1,
    machineId: "m",
    language: "en",
  });
  assert.equal(Buffer.from(bytes).toString("hex"), "0a016112016e1a02686920018201016da20102656e");
  const numbers = decodeFields(bytes).map((field) => field.field);
  assert.deepEqual(numbers, [1, 2, 3, 4, 16, 20]);
  assert.equal(numbers.includes(13), false);
});

test("decodes accepted, duplicate, and refused responses", () => {
  const accepted = decodeSendResponse(Buffer.from("08011a036d69642001", "hex"));
  assert.equal(accepted.dispatched, true);
  assert.equal(accepted.messageId, "mid");
  assert.equal(accepted.delivery, 1);
  assert.deepEqual(classifyDelivery(accepted), { outcome: "accepted", delivery: 1, messageId: "mid" });

  const queued = decodeSendResponse(Buffer.from("2002", "hex"));
  assert.equal(classifyDelivery(queued).outcome, "accepted");
  assert.equal(classifyDelivery(queued).delivery, 2);

  const duplicate = decodeSendResponse(Buffer.from("08012003", "hex"));
  assert.equal(duplicate.delivery, 3);
  assert.deepEqual(classifyDelivery(duplicate), { outcome: "duplicate" });

  const refused = decodeSendResponse(Buffer.from("080120042a0412026e6f", "hex"));
  assert.equal(refused.delivery, 4);
  assert.equal(refused.refusal, "no");
  assert.deepEqual(classifyDelivery(refused), { outcome: "refused", message: "no" });

  const plain = decodeSendResponse(Buffer.concat([
    Buffer.from("2004", "hex"),
    Buffer.from(encodeStringField(5, "nope")),
  ]));
  assert.equal(plain.delivery, 4);
  assert.equal(plain.refusal, "nope");
  assert.equal(classifyDelivery(plain).message, "nope");
});
