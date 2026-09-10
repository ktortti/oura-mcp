import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLoopbackRedirect } from "../src/auth.js";

test("accepts *.localhost, localhost and loopback IPs; binds loopback only", () => {
  assert.deepEqual(parseLoopbackRedirect("https://oura.localhost:3000/callback"), { tls: true, port: 3000, path: "/callback", hostname: "oura.localhost", bind: ["127.0.0.1", "::1"] });
  assert.deepEqual(parseLoopbackRedirect("http://localhost:9876/cb").bind, ["127.0.0.1", "::1"]);
  assert.deepEqual(parseLoopbackRedirect("https://127.0.0.1:3000/callback").bind, ["127.0.0.1"]);
  assert.deepEqual(parseLoopbackRedirect("https://[::1]:3000/callback").bind, ["::1"]);
});

test("rejects non-loopback hosts, missing ports and other schemes", () => {
  for (const bad of ["https://example.com:3000/callback", "https://oura.localhost/callback", "ftp://localhost:3000/x", "https://localhost.example:3000/callback", "https://lvh.me:3000/callback"]) {
    assert.throws(() => parseLoopbackRedirect(bad), /redirect_uri must be/, bad);
  }
});
