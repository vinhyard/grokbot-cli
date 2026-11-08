function concat(parts) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function encodeVarint(value) {
  let remaining = BigInt(value);
  if (remaining < 0n) throw new Error("negative integer");
  const bytes = [];
  while (remaining >= 0x80n) {
    bytes.push(Number(remaining & 0x7fn) | 0x80);
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));
  return Uint8Array.from(bytes);
}

export function encodeStringField(fieldNumber, text) {
  const body = new TextEncoder().encode(String(text));
  return concat([
    encodeVarint((fieldNumber << 3) | 2),
    encodeVarint(body.length),
    body,
  ]);
}

export function encodeVarintField(fieldNumber, value) {
  return concat([encodeVarint(fieldNumber << 3), encodeVarint(value)]);
}

// SendGrokBotUserMessage. The desktop source enum is left unset on purpose.
export function encodeSendRequest({ agentId, nonce, text, sentAtMs, machineId, language }) {
  return concat([
    encodeStringField(1, agentId),
    encodeStringField(2, nonce),
    encodeStringField(3, text),
    encodeVarintField(4, sentAtMs),
    encodeStringField(16, machineId),
    encodeStringField(20, language),
  ]);
}

function readVarint(bytes, start) {
  let value = 0n;
  let shift = 0n;
  let index = start;
  while (index < bytes.length) {
    const byte = bytes[index++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, index };
    shift += 7n;
    if (shift > 70n) throw new Error("invalid varint");
  }
  throw new Error("truncated message");
}

export function decodeFields(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : Uint8Array.from(buffer);
  const fields = [];
  let index = 0;
  while (index < bytes.length) {
    const key = readVarint(bytes, index);
    index = key.index;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (field <= 0) throw new Error("invalid field");
    if (wire === 0) {
      const body = readVarint(bytes, index);
      index = body.index;
      fields.push({ field, wire, value: body.value });
    } else if (wire === 2) {
      const length = readVarint(bytes, index);
      index = length.index;
      const size = Number(length.value);
      if (!Number.isSafeInteger(size) || size < 0 || index + size > bytes.length) {
        throw new Error("truncated message");
      }
      fields.push({ field, wire, value: bytes.subarray(index, index + size) });
      index += size;
    } else if (wire === 5) {
      if (index + 4 > bytes.length) throw new Error("truncated message");
      index += 4;
    } else if (wire === 1) {
      if (index + 8 > bytes.length) throw new Error("truncated message");
      index += 8;
    } else {
      throw new Error("unsupported message");
    }
  }
  return fields;
}

function textOf(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function decodeSendResponse(buffer) {
  const decoded = {
    dispatched: false,
    mode: 0,
    messageId: "",
    delivery: 0,
    refusal: "",
  };
  for (const field of decodeFields(buffer)) {
    if (field.field === 1 && field.wire === 0) decoded.dispatched = field.value === 1n;
    else if (field.field === 2 && field.wire === 0) decoded.mode = Number(field.value);
    else if (field.field === 3 && field.wire === 2) decoded.messageId = textOf(field.value);
    else if (field.field === 4 && field.wire === 0) decoded.delivery = Number(field.value);
    else if (field.field === 5 && field.wire === 2) {
      const nested = decodeFields(field.value);
      const message = nested.find((item) => item.field === 2 && item.wire === 2);
      if (message) decoded.refusal = textOf(message.value);
    }
  }
  return decoded;
}

export function classifyDelivery(decoded) {
  if (decoded.delivery === 3) return { outcome: "duplicate" };
  if (decoded.delivery === 4 || decoded.refusal) {
    return {
      outcome: "refused",
      message: decoded.refusal || "the service refused the message",
    };
  }
  if (decoded.delivery === 1 || decoded.delivery === 2) {
    return { outcome: "accepted", delivery: decoded.delivery, messageId: decoded.messageId };
  }
  return { outcome: "error" };
}
