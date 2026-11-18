# opencode-tokan

Tokan is an OpenCode plugin that adds a live sidebar HUD in the TUI and trims
large file reads with a `web-tree-sitter` AST "diet" to save context.

The HUD shows real session usage (local OpenCode instance), per-session load vs
model context window, live token rate, diet savings/diagnostics, and persistent
daily usage deltas.

## Install

```sh
npm install opencode-tokan
```

Add it to `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-tokan",
      "options": {
        "minFileBytes": 4096,
        "minFileLines": 120,
        "minSavedTokens": 100,
        "contextWindow": 200000,
        "pricePerMillion": 15,
        "dailyBudgetUsd": 0,
        "enabled": true,
        "include": [],
        "exclude": []
      }
    }
  ]
}
```

- `include`/`exclude` (optional): path patterns (substring or simple `*`/`**` glob)
  to scope which candidate files may be dieted.
- `wasmPaths` (optional): override grammar WASM specifiers/paths by extension.

Or load from a local path (this repo) in global config `~/.config/opencode/opencode.json`:

```jsonc
{ "plugins": ["/path/to/Tokan"] }
```

## HUD

- **TOKAN // DIET**: shows how full the active session’s context is (“this turn”
  when recent usage is known, otherwise an estimate) with tokens used vs window,
  a simple token breakdown (in/out/cache/reasoning), active model, and diet results:
  total saved (~$ and avg/file), how many files were dieted vs seen, common skip
  reasons, the last file/result, and server/connection status. When idle/off,
  hooks unavailable, or reads had no savings, it explains what’s happening.
- **Compact view**: one panel with context/rate, model, total saved, and today’s
  spend vs budget.
- **USAGE // LIVE**: observed token rate while Tokan runs (active session/model
  when busy, else all sessions), today’s usage (sampled delta when available,
  shown vs `dailyBudgetUsd` when set) and session count, plus top sessions with
  load %, total, and cost.
- **USAGE // OVERALL & DAILY**: overall and recent daily token/cost usage sampled
  while Tokan runs and saved to `~/.config/opencode/tokan-usage.json` (persists
  across restarts; tracks going forward, not a backfill). Shows recent daily
  average, and today’s row can show budget/over-budget when `dailyBudgetUsd` is
  set (with a one-time warning when exceeded). Shows Ponytail mode.
  Per-model usage deltas are also saved there over time.
- **USAGE // BY MODEL**: token usage (and cost, when available) grouped by model.
  Shows visible sessions when available, otherwise saved usage history.
- **Views**: run `tokan.view` to switch between `full`, `compact`, `diet`,
  `usage`, `total`, and `models` (choice is remembered).

## Commands (palette)

- `tokan.toggle` — Turn the AST diet on/off (remembered).
- `tokan.reset` — Reset Tokan savings/stats (keeps on/off state).
- `tokan.resetLedger` — Clear saved usage history (daily/overall/model ledger).
- `tokan.ledgerPath` — Show where the usage ledger is stored.
- `tokan.summary` — Show a quick today/overall/saved summary toast.
- `tokan.view` — Switch HUD view (full/compact/diet/usage/total/models).

## Diet behavior

The server part intercepts `read` tool calls
(V2: `ctx.tool.hook("execute.before" | "execute.after")`, V1 compat:
`tool.execute.before/after`). A read is dieted only when it is a full read (no
`offset`/`limit`), a supported source file (`.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs/.py/.go/.rs`),
not in `node_modules/.git/dist/build/coverage` or `.d.ts/.min/.lock/.map/.wasm/.env`,
passes optional `include`/`exclude`, and meets thresholds: `>= minFileBytes`,
`>= minFileLines`, and saves `>= minSavedTokens` estimated tokens. Imports,
signatures, classes and type definitions are kept; heavy bodies/initializers are
replaced with placeholders. Grammar WASM is bundled for TS/JS/Python/Go/Rust; if
unavailable, a heuristic fallback is used. `TOKAN_DEBUG=1` logs interception failures.

Skip reasons tracked: `disabled`, `partial` read, `small`, `short`, `low` gain,
`unreadable`. Token counts and $ savings are heuristic (`~4` chars/token), not
provider tokenizer/billing output.

## Notes

- Shows usage from this local OpenCode instance only (not cross-device).
- Daily/overall and per-model history is recorded while Tokan is running (builds
  up over time, not a historical backfill; keeps recent daily history and overall totals). Token
  counts, $ savings, and rates are estimates/best-effort from available session data.
- Usage ledger (`~/.config/opencode/tokan-usage.json`) keeps recent daily rows and top models to stay small.
- If a model shows as `unknown`, the session’s model field wasn’t exposed by the runtime.
- If numbers look off or diet never triggers: reload/restart the TUI, check HUD
  status/server lines, and try `TOKAN_DEBUG=1` for hook logs. Run
  `npm run typecheck` when toolchain is available.

## License

MIT
