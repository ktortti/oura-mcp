import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { AppConfig, CONFIG_DIR, DEFAULT_REDIRECT, DEFAULT_SCOPES, loadConfig, paths, saveConfig, saveTokens } from "./config.js";
import { exchangeToken } from "./token.js";

export const AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
const CALLBACK_TIMEOUT_MS = 300_000;

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---------------------------------------------------------------- init

/** Interactive first-time setup. The secret is read with echo suppressed and written to a 0600 file. */
export async function runInit(): Promise<void> {
  const existing = loadConfig();
  console.log("Oura MCP (local) — setup");
  console.log("Register an app at https://cloud.ouraring.com/oauth/applications with redirect URI:");
  console.log(`  ${DEFAULT_REDIRECT}\n`);
  const client_id = (await prompt(`Client ID${existing ? ` [${existing.client_id}]` : ""}: `)) || existing?.client_id || "";
  const client_secret = (await prompt("Client secret (hidden): ", { hidden: true })) || existing?.client_secret || "";
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

function prompt(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const muted = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    const rl = createInterface({ input: process.stdin, output: opts.hidden ? muted : process.stdout, terminal: true });
    if (opts.hidden) process.stdout.write(question);
    rl.question(opts.hidden ? "" : question, (answer) => {
      rl.close();
      if (opts.hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------- auth

/** PKCE authorization-code flow with a loopback callback. Tokens are saved, never printed. */
export async function runAuth(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) throw new Error("No client credentials. Run: node dist/index.js init");
  const redirect = parseLoopbackRedirect(cfg.redirect_uri);

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

  const code = await waitForAuthCode(redirect, state, authUrl.toString());
  const tokens = await exchangeToken(cfg, {
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirect_uri,
    code_verifier: verifier,
  });
  const file = saveTokens(tokens);
  console.log(`Connected. Tokens saved to ${file} (0600). Scope: ${tokens.scope ?? cfg.scopes}. Expires: ${tokens.expires_at}`);
}

interface LoopbackRedirect { tls: boolean; port: number; path: string }

function parseLoopbackRedirect(uri: string): LoopbackRedirect {
  const u = new URL(uri);
  const loopback = ["127.0.0.1", "localhost"].includes(u.hostname);
  if (!["http:", "https:"].includes(u.protocol) || !loopback || !u.port) {
    throw new Error("redirect_uri must be http(s)://127.0.0.1:<port>/<path>");
  }
  return { tls: u.protocol === "https:", port: Number(u.port), path: u.pathname || "/callback" };
}

/**
 * Listen for the OAuth redirect on the loopback address and return the authorization code.
 * Two ways in: the browser hits the callback, or the user pastes the redirected URL into the
 * terminal (needed when a browser refuses the self-signed certificate). Every exit path —
 * success, error, timeout — releases the socket, the stdin listener and the timer.
 */
function waitForAuthCode(redirect: LoopbackRedirect, expectedState: string, authUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const tls = redirect.tls ? selfSignedCert() : null;
    const rl = createInterface({ input: process.stdin, terminal: false });

    const settle = (outcome: { code: string } | { error: Error }) => {
      clearTimeout(timer);
      rl.close();
      server.close();
      if ("code" in outcome) resolve(outcome.code); else reject(outcome.error);
    };

    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${redirect.port}`);
      if (url.pathname !== redirect.path) { res.writeHead(404).end("Not found"); return; }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (error || !code || state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end(error ? `Authorization failed: ${error}` : "Bad callback (missing code or state mismatch).");
        settle({ error: new Error(error ?? "state mismatch") });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end("<h2>Oura connected.</h2><p>Tokens were saved locally. You can close this tab.</p>");
      settle({ code });
    };

    const server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
    const timer = setTimeout(() => settle({ error: new Error("Timed out waiting for the Oura callback (5 min).") }), CALLBACK_TIMEOUT_MS);

    rl.on("line", (line) => {
      const pasted = parsePastedCallback(line, expectedState);
      if (pasted) settle({ code: pasted });
      else if (line.trim()) console.log("That doesn't look like the callback URL (need code= and a matching state=).");
    });
    server.on("error", (e) => settle({ error: e }));
    server.listen(redirect.port, "127.0.0.1", () => {
      console.log("Opening the Oura consent page in your browser. If nothing opens, paste this URL into the browser:");
      console.log(authUrl);
      if (redirect.tls && !tls) {
        console.log("\nopenssl not found — the browser will fail to load the callback. Copy the full URL from the address bar and paste it here.");
      } else if (tls) {
        console.log("\nThe callback uses a self-signed certificate for 127.0.0.1. If the browser warns, choose Advanced → Proceed.");
        console.log("If it refuses, copy the full URL from the address bar (it contains code=...) and paste it here, then press Enter.");
      }
      openBrowser(authUrl);
    });
  });
}

function parsePastedCallback(line: string, expectedState: string): string | null {
  const code = line.match(/[?&]code=([^&\s]+)/);
  const state = line.match(/[?&]state=([^&\s]+)/);
  if (!code || !state || decodeURIComponent(state[1]) !== expectedState) return null;
  return decodeURIComponent(code[1]);
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch { /* user pastes the URL manually */ }
}

/** Self-signed certificate for the loopback callback, generated once with openssl and kept 0600. */
function selfSignedCert(): { key: Buffer; cert: Buffer } | null {
  const { CERT_FILE, KEY_FILE } = paths;
  try {
    if (!existsSync(CERT_FILE) || !existsSync(KEY_FILE)) {
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650",
        "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
        "-keyout", KEY_FILE, "-out", CERT_FILE,
      ], { stdio: "ignore", cwd: CONFIG_DIR });
      chmodSync(KEY_FILE, 0o600);
      chmodSync(CERT_FILE, 0o600);
    }
    return { key: readFileSync(KEY_FILE), cert: readFileSync(CERT_FILE) };
  } catch {
    return null;
  }
}
