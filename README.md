# oura-mcp-local

A small, read-only MCP server for the Oura API v2. It returns pre-shaped physiology — nights, chronotype, temperature shifts, baseline drift — and leaves interpretation to whatever is calling it.

- OAuth2 authorization-code flow with PKCE and a state check; local callback on `127.0.0.1`.
- Client secret and tokens live in `~/.oura-mcp-local/` with `0600` permissions. Tokens are never printed.
- `api.ouraring.com` and `cloud.ouraring.com` are the only hosts in the code.
- Scopes requested: `daily heartrate tag spo2 stress` (stress is its own scope on the app form and gates `daily_stress`). No `personal`, no `email`, no workouts.
- Single dependency: `@modelcontextprotocol/sdk` (plus `zod`, which it needs).
- Date ranges capped at 366 days; HR curves at 31 days.

## Tools

| Tool | Answers |
|---|---|
| `oura_status` | Is it connected, which scopes, when does the token expire. No health data. |
| `oura_event_context(date, time)` | The night before a timed event: bedtime, wake, duration, lowest HR and when, hours awake at the event, hours since HR trough, sleep vs 30-day median, readiness, temperature deviation. |
| `oura_chronotype(days=90)` | Median/IQR bedtime, wake, midpoint; weekday vs weekend; regularity; midpoint shift vs ~03:30 reference; day-by-day phase series. |
| `oura_sleep_periods(start, end, include_hr_curve, main_sleep_only)` | Per-night summaries; optional 5-min HR curve. |
| `oura_temperature_shifts(start, end, threshold, confirm_days, baseline_days, expected_elevated_days)` | Sustained nightly-temperature shift detector: shift day, elevated-phase mean, amplitude, duration, extension flag. Raw series and parameters returned. |
| `oura_daily(start, end)` | Compact daily table: readiness, sleep score, activity, steps, stress, SpO2, lowest HR, HRV, temperature. |
| `oura_tags(start, end)` | User-entered tags. |
| `oura_baseline_drift(days=30, window=7)` | Recent nights vs baseline for lowest HR, avg HR, HRV, respiratory rate, temperature; deltas, z-scores, flags. |
| `oura_export(start, end, dir)` | CSVs (sleep, daily, temperature, tags) into a directory under your home folder. |

## Setup

1. Register an application at <https://cloud.ouraring.com/oauth/applications>.
   Redirect URI: `https://127.0.0.1:3000/callback`.
2. Build and configure:
   ```bash
   git clone https://github.com/ktortti/oura-mcp.git && cd oura-mcp
   npm ci && npm run build
   node dist/index.js init      # asks for client ID and secret (secret hidden); writes ~/.oura-mcp-local/config.json
   node dist/index.js auth      # opens the Oura consent page; tokens saved to ~/.oura-mcp-local/tokens.json
   # Oura requires an https redirect. The callback runs on a self-signed cert for 127.0.0.1 (generated once with
   # openssl into ~/.oura-mcp-local/). If the browser warns, choose Advanced → Proceed. If it refuses outright,
   # copy the full URL from the address bar (it contains code=...) and paste it into the terminal.
   node dist/index.js status
   ```
3. Register with Claude Code (no secrets in the MCP config):
   ```bash
   claude mcp add --scope user oura -- node "$(pwd)/dist/index.js" serve
   ```
   Restart the app; `claude mcp list` should show `oura`.
4. First query: `oura_event_context` for a recent date and a clock time. Check the bedtime, wake and lowest-HR time against the Oura app for the same night.

## Notes

- Oura refresh tokens are single-use. Several server processes (one per Claude Code session, say) can share the token file: refresh happens under a lock file (stale after 2 min and only if the owning process is gone), and a process re-reads the file before spending its own refresh token, so a sibling's refresh is adopted rather than raced.
- Access tokens are refreshed automatically a minute before expiry and on a 401. Requests retry up to three times on 429 (honouring `Retry-After`), 5xx and network errors, with at most four in flight at once. Pagination is capped at 50 pages and rejects a repeated token.
- Responses are validated against minimal zod schemas per endpoint; an unexpected shape fails with the endpoint and field named rather than producing misleading numbers.
- To revoke: delete `~/.oura-mcp-local/tokens.json` and remove the app's access at cloud.ouraring.com.
- Set `OURA_MCP_HOME` to relocate the config directory (tests and sandboxes).
- `npm test` covers the analysis functions (synthetic data), the API client (scripted `fetch`: pagination guards, validation, retries, refresh and cross-process refresh), export path containment (including symlink escape) and the lock file. `npm run lint` and `npm run typecheck` are what CI runs.
