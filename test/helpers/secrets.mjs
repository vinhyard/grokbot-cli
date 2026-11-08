import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function seal(password, plaintext) {
  const key = pbkdf2Sync(String(password), "saltysalt", 1003, 16, "sha1");
  try {
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const body = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from("v10"), body]).toString("base64");
  } finally {
    key.fill(0);
  }
}

export function writeAccount(home, { password, token, team } = {}) {
  const account = { "cursor-access-token": seal(password, token) };
  if (team != null) account["cursor-selected-team-id"] = seal(password, team);
  const stored = {
    version: 1,
    "cursor-accounts": JSON.stringify({
      active: "primary",
      accounts: { primary: account },
    }),
  };
  const dir = join(home, "Library", "Application Support", "Grok Bot");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sand-secrets.json"), JSON.stringify(stored));
}

export function assertNoSecrets(text, secrets) {
  for (const secret of secrets) {
    if (secret && String(text).includes(secret)) throw new Error("output leaked a credential");
  }
}
