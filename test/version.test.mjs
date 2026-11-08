import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { FALLBACK_CLIENT_VERSION, resolveClientVersion, validAppVersion } from "../src/version.mjs";

function fixture(files, plists = {}) {
  return {
    home: "/home/captain",
    platform: "darwin",
    env: {},
    exists: (path) => files.has(path) || Object.hasOwn(plists, path),
    readFile: (path) => {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(path);
    },
    readPlist: (path) => {
      if (!Object.hasOwn(plists, path)) throw new Error("no plist");
      return plists[path];
    },
  };
}

const statusPath = join("/home/captain", "Library", "Application Support", "Grok Bot", "desktop-status.json");
const homePlist = join("/home/captain", "Applications", "Grok Bot.app/Contents/Info.plist");
const systemPlist = join("/Applications", "Grok Bot.app/Contents/Info.plist");

test("version pattern accepts app versions and rejects anything else", () => {
  assert.equal(validAppVersion("1.2.3"), "1.2.3");
  assert.equal(validAppVersion("1.2.3-beta.1"), "1.2.3-beta.1");
  assert.equal(validAppVersion("1.2.3+build.4"), "1.2.3+build.4");
  assert.equal(validAppVersion("0.20"), null);
  assert.equal(validAppVersion("v1.2.3"), null);
  assert.equal(validAppVersion("1.2.3 "), null);
  assert.equal(validAppVersion(null), null);
});

test("falls back when no app is installed and does not read a plist", () => {
  let plistReads = 0;
  const version = resolveClientVersion({
    ...fixture(new Map()),
    readPlist: () => {
      plistReads += 1;
      return "9.9.9";
    },
  });
  assert.equal(version, FALLBACK_CLIENT_VERSION);
  assert.equal(plistReads, 0);
});

test("prefers desktop-status.json, then the home bundle, then /Applications", () => {
  const files = new Map([[statusPath, JSON.stringify({ appVersion: "4.5.6" })]]);
  assert.equal(resolveClientVersion(fixture(files, { [homePlist]: "1.0.0", [systemPlist]: "2.0.0" })), "4.5.6");

  assert.equal(resolveClientVersion(fixture(new Map(), { [homePlist]: "1.0.0", [systemPlist]: "2.0.0" })), "1.0.0");
  assert.equal(resolveClientVersion(fixture(new Map(), { [systemPlist]: "2.0.0" })), "2.0.0");
});

test("an invalid status version falls through to the bundle", () => {
  const files = new Map([[statusPath, JSON.stringify({ appVersion: "nope" })]]);
  assert.equal(resolveClientVersion(fixture(files, { [homePlist]: "8.0.1-beta.2" })), "8.0.1-beta.2");
});

test("GROKBOT_CLIENT_VERSION overrides files and an invalid override is ignored", () => {
  const files = new Map([[statusPath, JSON.stringify({ appVersion: "4.5.6" })]]);
  const base = fixture(files);
  assert.equal(resolveClientVersion({ ...base, env: { GROKBOT_CLIENT_VERSION: "3.1.4" } }), "3.1.4");
  assert.equal(resolveClientVersion({ ...base, env: { GROKBOT_CLIENT_VERSION: "3.1" } }), "4.5.6");
});

test("non-darwin does not read the Mac app paths", () => {
  let looked = false;
  const version = resolveClientVersion({
    home: "/home/captain",
    platform: "linux",
    env: {},
    exists: () => {
      looked = true;
      return false;
    },
    readFile: () => {
      throw new Error("read");
    },
    readPlist: () => {
      throw new Error("plist");
    },
  });
  assert.equal(version, FALLBACK_CLIENT_VERSION);
  assert.equal(looked, false);
});
