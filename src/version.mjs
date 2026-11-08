import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FALLBACK_CLIENT_VERSION = "0.20.0";
const APP_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

export function validAppVersion(version) {
  return typeof version === "string" && APP_VERSION_PATTERN.test(version) ? version : null;
}

function defaultReadPlist(plist) {
  return execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist], {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function resolveClientVersion({
  home = homedir(),
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  readFile = readFileSync,
  readPlist = defaultReadPlist,
} = {}) {
  const override = validAppVersion(env?.GROKBOT_CLIENT_VERSION);
  if (override) return override;
  if (platform !== "darwin") return FALLBACK_CLIENT_VERSION;
  const statusPath = join(home, "Library", "Application Support", "Grok Bot", "desktop-status.json");
  if (exists(statusPath)) {
    try {
      const parsed = JSON.parse(readFile(statusPath, "utf8"));
      const version = validAppVersion(parsed?.appVersion);
      if (version) return version;
    } catch {
      // Unreadable status falls through to the app bundle.
    }
  }
  for (const root of [join(home, "Applications"), "/Applications"]) {
    const plist = join(root, "Grok Bot.app/Contents/Info.plist");
    if (!exists(plist)) continue;
    try {
      const version = validAppVersion(readPlist(plist));
      if (version) return version;
    } catch {
      // Try the other install location.
    }
  }
  return FALLBACK_CLIENT_VERSION;
}

const cache = new Map();

export function clientVersion(options = {}) {
  if (options.exists || options.readFile || options.readPlist) return resolveClientVersion(options);
  const key = [
    options.home ?? "",
    options.platform ?? "",
    options.env?.GROKBOT_CLIENT_VERSION ?? "",
  ].join("\0");
  if (!cache.has(key)) cache.set(key, resolveClientVersion(options));
  return cache.get(key);
}
