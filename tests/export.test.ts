import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExportDir, writeCsvs } from "../src/export.js";

const home = () => mkdtempSync(join(tmpdir(), "oura-home-"));

test("paths inside home are accepted, including ~ and nested new directories", () => {
  const h = home();
  assert.equal(resolveExportDir("~/data/oura", h), join(h, "data", "oura"));
  assert.ok(existsSync(join(h, "data", "oura")));
});

test("a sibling directory sharing the home prefix is rejected", () => {
  const h = home();
  assert.throws(() => resolveExportDir(`${h}-other/x`, h), /inside your home directory/);
  assert.equal(existsSync(`${h}-other`), false, "nothing created outside home");
});

test("traversal and absolute paths outside home are rejected", () => {
  const h = home();
  assert.throws(() => resolveExportDir(join(h, "..", "escape"), h), /inside your home directory/);
  assert.throws(() => resolveExportDir("/tmp/anywhere", h), /inside your home directory/);
});

test("a symlink inside home that points outside is rejected", () => {
  const h = home(), outside = mkdtempSync(join(tmpdir(), "oura-outside-"));
  symlinkSync(outside, join(h, "link"));
  assert.throws(() => resolveExportDir(join(h, "link", "x"), h), /resolves outside/);
});

test("writeCsvs writes one file per table with a header row", () => {
  const h = home();
  mkdirSync(join(h, "out"));
  const files = writeCsvs(join(h, "out"), { daily: [{ day: "2026-03-01", score: 80 }, { day: "2026-03-02", score: null, note: 'a "quoted", value' }] }, h);
  assert.equal(files.length, 1);
  const text = readFileSync(files[0], "utf8");
  assert.equal(text.split("\n")[0], "day,score,note");
  assert.match(text, /"a ""quoted"", value"/);
});
