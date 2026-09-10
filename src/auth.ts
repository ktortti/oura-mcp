import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, chmodSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { AppConfig, CONFIG_DIR, DEFAULT_REDIRECT, DEFAULT_SCOPES, Tokens, loadConfig, paths, saveConfig, saveTokens } from "./config.js";

export const AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
export const TOKEN_URL = "https://api.ouraring.com/oauth/token";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Interactive first-time setup. Secret is read with echo suppressed and written to a 0600 file. */
export async function runInit(): Promise<void> {
  const existing = loadConfig();
  const ask = (q: string, hidden = false): Promise<string> =>
    new Promise((resolve) => {
      const muted = new Writable({ write(_c, _e, cb) { cb(); } });
      const rl = createInterface({ input: process.stdin, output: hidden ? muted : process.stdout, terminal: true });
      if (hidden) process.stdout.write(q);
      rl.question(hidden ? "" : q, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(a.trim()); });
    });

  console.log("Oura MCP (local) — setup");
  console.log("Register an app at https://cloud.ouraring.com/oauth/applications with redirect URI:");
  console.log(`  ${DEFAULT_REDIRECT}\n`);
  const client_id = (await ask(`Client ID${existing ? ` [${existing.client_id}]` : ""}: `)) || existing?.client_id || "";
  const client_secret = (await ask("Client secret (hidden): ", true)) || existing?.client_secret || "";
  if (!client_id || !client_secret) throw new Error("Client ID and secret are required.");
  const cfg: AppConfig = {
    client_id,
    client_secret,
    redirect_uri: existing?.redirect_uri ?? DEFAULT_REDIRECT,
    scopes: existing?.scopes ?? DEFAULT_SCOPES,
  };
  const path = saveConfig(cfg);
  console.log(`Saved ${path} (0600). Scopes: ${cfg.scopes}`);
  console.log("Next: node dist/index.js auth");
}

/** PKCE authorization-code flow with a local callback. Tokens are saved, never printed. */
export async function runAuth(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) throw new Error("No client credentials. Run: node dist/index.js init");

  const u = new URL(cfg.redirect_uri);
  if (!["http:", "https:"].includes(u.protocol) || !["127.0.0.1", "localhost"].includes(u.hostname) || !u.port) {
    throw new Error("redirect_uri must be http(s)://127.0.0.1:<port>/<path>");
  }
  const port = Number(u.port), path = u.pathname || "/callback";
  const tls = u.protocol === "https:" ? selfSignedCert() : null;
  if (u.protocol === "https:" && !tls) {
    console.log("openssl not found — the browser will fail to load the callback. Paste the full redirected URL here when that happens.");
  }

  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.client_id,
    redirect_uri: cfg.redirect_uri,
    scope: cfg.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error("Timed out waiting for the Oura callback (5 min).")); }, 300_000);
    // Fallback: the user pastes the redirected URL (works even if the browser refuses the self-signed cert).
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => {
      const m = line.trim().match(/[?&]code=([^&\s]+)/), st = line.match(/[?&]state=([^&\s]+)/);
      if (m && st && decodeURIComponent(st[1]) === state) { clearTimeout(timer); rl.close(); server.close(); resolve(decodeURIComponent(m[1])); }
      else if (line.trim()) console.log("That doesn't look like the callback URL (need code= and matching state=).");
    });
    const handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== path) { res.writeHead(404).end("Not found"); return; }
      const err = url.searchParams.get("error");
      const c = url.searchParams.get("code");
      const s = url.searchParams.get("state");
      if (err || !c || s !== state) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end(err ? `Authorization failed: ${err}` : "Bad callback (missing code or state mismatch).");
        clearTimeout(timer); server.close(); reject(new Error(err ?? "state mismatch")); return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end("<h2>Oura connected.</h2><p>Tokens were saved locally. You can close this tab.</p>");
      clearTimeout(timer); rl.close(); server.close(); resolve(c);
    };
    const server = tls ? createHttps({ key: tls.key, cert: tls.cert }, handler) : createHttp(handler);
    server.on("error", (e) => { clearTimeout(timer); reject(e); });
    server.listen(port, "127.0.0.1", () => {
      console.log("Opening the Oura consent page in your browser. If nothing opens, paste this URL into the browser:");
      console.log(authUrl.toString());
      if (tls) console.log("\nThe callback uses a self-signed certificate for 127.0.0.1. If the browser shows a certificate warning, choose Advanced → Proceed.\nIf it refuses, copy the full URL from the address bar (it contains code=...) and paste it here, then press Enter.");
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", "", authUrl.toString()] : [authUrl.toString()];
      try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch { /* manual paste */ }
    });
  });

  const tokens = await exchange(cfg, {
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirect_uri,
    code_verifier: verifier,
  });
  const p = saveTokens(tokens);
  console.log(`Connected. Tokens saved to ${p} (0600). Scope: ${tokens.scope ?? cfg.scopes}. Expires: ${tokens.expires_at}`);
}

/** Self-signed cert for the loopback callback, generated once with openssl and kept 0600. */
function selfSignedCert(): { key: Buffer; cert: Buffer } | null {
  const { CERT_FILE, KEY_FILE } = paths;
  try {
    if (!existsSync(CERT_FILE) || !existsSync(KEY_FILE)) {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650",
        "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
        "-keyout", KEY_FILE, "-out", CERT_FILE], { stdio: "ignore", cwd: CONFIG_DIR });
      chmodSync(KEY_FILE, 0o600); chmodSync(CERT_FILE, 0o600);
    }
    return { key: readFileSync(KEY_FILE), cert: readFileSync(CERT_FILE) };
  } catch { return null; }
}

export async function exchange(cfg: AppConfig, body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...body, client_id: cfg.client_id, client_secret: cfg.client_secret }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Token endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string };
  if (!j.access_token) throw new Error("Token response had no access_token.");
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? (body.refresh_token ?? ""),
    expires_at: new Date(Date.now() + (j.expires_in ?? 86_400) * 1000).toISOString(),
    scope: j.scope,
    token_type: j.token_type,
  };
}
