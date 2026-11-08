import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (name.endsWith(".mjs")) found.push(path);
  }
  return found;
}

test("source does not claim a desktop identity or encode field 13", () => {
  const files = [...sourceFiles(join(root, "bin")), ...sourceFiles(join(root, "src"))];
  assert.ok(files.length > 0);
  const needles = ["source-desktop", "x-ghost-mode", "x-cursor-client-source"];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const needle of needles) {
      assert.equal(text.includes(needle), false, file + " contains " + needle);
    }
    assert.doesNotMatch(text, /\(\s*13\s*<<\s*3\s*\)/);
    assert.doesNotMatch(text, /encode(?:String|Varint)Field\(\s*13\b/);
    assert.doesNotMatch(text, /field(?:Number)?\s*[:=]\s*13\b/);
  }
});
