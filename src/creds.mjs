import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MACOS_ONLY = "grokbot requires macOS; credential support is not available on this platform.";

export function appSecretsPath(home, platform) {
  if (platform !== "darwin") throw new Error(MACOS_ONLY);
  return join(home, "Library", "Application Support", "Grok Bot", "sand-secrets.json");
}

export function readKeychainPassword() {
  if (process.platform !== "darwin") throw new Error(MACOS_ONLY);
  try {
    return execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", "Grok Bot Safe Storage"],
      { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] },
    ).trimEnd();
  } catch {
    throw new Error("keychain item is not readable");
  }
}

// Electron Safe Storage on macOS: base64 "v10" + AES-128-CBC.
// Key = PBKDF2-SHA1(keychain password, salt "saltysalt", 1003 rounds, 16 bytes).
// IV is sixteen 0x20 bytes.
export function decryptSafeStorage(encryptedBase64, password) {
  const encrypted = Buffer.from(String(encryptedBase64), "base64");
  if (encrypted.subarray(0, 3).toString("latin1") !== "v10") {
    throw new Error("unsupported credential format");
  }
  const key = pbkdf2Sync(String(password), "saltysalt", 1003, 16, "sha1");
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const clear = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    return clear.toString("utf8");
  } catch {
    throw new Error("could not decrypt the access token");
  } finally {
    key.fill(0);
  }
}

function validTeamId(value) {
  const team = String(value ?? "").trim();
  if (!team) return undefined;
  if (!/^[1-9][0-9]*$/.test(team) || !Number.isSafeInteger(Number(team))) {
    throw new Error("invalid selected team");
  }
  return team;
}

export function loadCredentials({
  home = homedir(),
  platform = process.platform,
  getKeychainPassword = readKeychainPassword,
  readFile = readFileSync,
} = {}) {
  const path = appSecretsPath(home, platform);
  let stored;
  try {
    stored = JSON.parse(readFile(path, "utf8"));
  } catch {
    throw new Error("Grok Bot account file is missing or unreadable");
  }
  if (stored == null || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error("Grok Bot account file is missing or unreadable");
  }
  if (stored.version != null && stored.version !== 1) {
    throw new Error("unsupported account storage version");
  }
  let accounts;
  try {
    const raw = stored["cursor-accounts"] ?? "null";
    accounts = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    throw new Error("Grok Bot account file is missing or unreadable");
  }
  if (typeof accounts?.active !== "string" || accounts.accounts == null || !Object.hasOwn(accounts.accounts, accounts.active)) {
    throw new Error("Grok Bot account file has no active account");
  }
  const account = accounts.accounts[accounts.active];
  const encryptedToken = account?.["cursor-access-token"];
  if (typeof encryptedToken !== "string" || !encryptedToken) {
    throw new Error("Grok Bot active account has no access token");
  }
  let password;
  try {
    password = getKeychainPassword();
  } catch (error) {
    if (error instanceof Error && error.message === MACOS_ONLY) throw error;
    throw new Error("keychain item is not readable");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("keychain item is not readable");
  }
  const accessToken = decryptSafeStorage(encryptedToken, password).trim();
  if (!accessToken) throw new Error("Grok Bot active account has no access token");
  let teamId;
  const encryptedTeam = account["cursor-selected-team-id"];
  if (encryptedTeam != null && encryptedTeam !== "") {
    teamId = validTeamId(decryptSafeStorage(encryptedTeam, password).trim());
  }
  return teamId === undefined ? { accessToken } : { accessToken, teamId };
}
