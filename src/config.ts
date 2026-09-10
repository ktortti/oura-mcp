import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = process.env.OURA_MCP_HOME ?? join(homedir(), ".oura-mcp-local");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const TOKEN_FILE = join(CONFIG_DIR, "tokens.json");

export const DEFAULT_SCOPES = "daily heartrate tag spo2 stress";
export const DEFAULT_REDIRECT = "https://127.0.0.1:3000/callback";

export interface AppConfig {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  scopes: string;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: string; // ISO
  scope?: string;
  token_type?: string;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function loadConfig(): AppConfig | null {
  const file = readJson<Partial<AppConfig>>(CONFIG_FILE) ?? {};
  const client_id = process.env.OURA_CLIENT_ID ?? file.client_id;
  const client_secret = process.env.OURA_CLIENT_SECRET ?? file.client_secret;
  if (!client_id || !client_secret) return null;
  return {
    client_id,
    client_secret,
    redirect_uri: process.env.OURA_REDIRECT_URI ?? file.redirect_uri ?? DEFAULT_REDIRECT,
    scopes: process.env.OURA_SCOPES ?? file.scopes ?? DEFAULT_SCOPES,
  };
}

export function saveConfig(cfg: AppConfig): string {
  writeJson(CONFIG_FILE, cfg);
  return CONFIG_FILE;
}

export function loadTokens(): Tokens | null {
  return readJson<Tokens>(TOKEN_FILE);
}

export function saveTokens(t: Tokens): string {
  writeJson(TOKEN_FILE, t);
  return TOKEN_FILE;
}

export function filePermissions(): { config: string | null; tokens: string | null } {
  const perm = (p: string) => (existsSync(p) ? (statSync(p).mode & 0o777).toString(8) : null);
  return { config: perm(CONFIG_FILE), tokens: perm(TOKEN_FILE) };
}

export const paths = { CONFIG_FILE, TOKEN_FILE, CERT_FILE: join(CONFIG_DIR, "callback-cert.pem"), KEY_FILE: join(CONFIG_DIR, "callback-key.pem") };
