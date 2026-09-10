import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { statusForCaller, tildeify } from "../src/config.js";

test("tildeify folds the home directory and reduces outside paths to a basename", () => {
  const home = join("/Users", "someone");
  assert.equal(tildeify(join(home, ".oura-mcp-local", "tokens.json"), home), "~/.oura-mcp-local/tokens.json");
  assert.equal(tildeify(home, home), "~");
  assert.equal(tildeify(join("/Users", "someone-else", "x.json"), home), "x.json");
  assert.equal(tildeify("/etc/passwd", home), "passwd");
});

test("status for an MCP caller carries no absolute path", () => {
  const s = statusForCaller();
  const text = JSON.stringify(s);
  assert.equal(text.includes(homedir()), false, text);
  assert.ok(s.dir.startsWith("~") || !s.dir.includes("/"), s.dir);
  for (const f of [s.config, s.tokens]) {
    assert.equal(typeof f.exists, "boolean");
    if (f.exists) assert.match(f.mode ?? "", /^[0-7]{3}$/);
  }
});
