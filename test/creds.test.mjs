import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decryptSafeStorage, loadCredentials } from "../src/creds.mjs";
import { assertNoSecrets, seal, writeAccount } from "./helpers/secrets.mjs";

const password = "pw-" + "P".repeat(32);
const token = "access-" + "T".repeat(48);

test("decrypts a Safe Storage blob with an injected password", () => {
  const blob = seal(password, token);
  const clear = decryptSafeStorage(blob, password);
  assert.equal(clear === token, true, "decrypt mismatch");
  const broken = Buffer.from(blob, "base64");
  broken[broken.length - 1] ^= 0xff;
  let thrown = "";
  assert.throws(() => {
    try {
      decryptSafeStorage(broken.toString("base64"), password);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }, /could not decrypt the access token/);
  assertNoSecrets(thrown, [password, token]);
});

test("loadCredentials returns only the token material", () => {
  const home = mkdtempSync(join(tmpdir(), "grokbot-creds-"));
  try {
    writeAccount(home, { password, token });
    const loaded = loadCredentials({
      home,
      platform: "darwin",
      getKeychainPassword: () => password,
    });
    assert.equal(loaded.accessToken === token, true, "decrypt mismatch");
    assert.deepEqual(Object.keys(loaded), ["accessToken"]);
    assertNoSecrets(JSON.stringify(Object.keys(loaded)), [password, token]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
