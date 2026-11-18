# opencode-tokan

Tokan is an OpenCode plugin that shows a live token-savings HUD in the terminal
sidebar and trims large file reads with a `web-tree-sitter` AST "diet".

It keeps imports, function/class signatures and type definitions, and replaces
heavy implementation bodies with short placeholders. Savings are estimated at
`$15` per million tokens by default.

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
        "pricePerMillion": 15
      }
    }
  ]
}
```

The server part registers `tool.execute.before` / `tool.execute.after` hooks
(V2: `ctx.tool.hook("execute.before" | "execute.after")`) and a message token
tracker (V2: `ctx.session.hook("prompt")`, V1: `chat.message`). The `./tui`
part renders the HUD through the supported `sidebar.content` slot; OpenCode has
no `tui.sidebar` hook. The TUI reads live stats over the `tokan` RPC contract.

## Notes

- Grammar WASM modules are bundled for TypeScript, JavaScript, Python, Go and
  Rust. If a grammar cannot load, Tokan falls back to a heuristic signature
  parser instead of breaking the read.
- Token counts are heuristic (`~4` characters per token), not provider-specific
  tokenizer output.
- Reads with `offset` or `limit` are left untouched.
- Set `TOKAN_DEBUG=1` to log interception failures.
- Run `npm run typecheck` to verify the TypeScript sources.

## License

MIT
# Tokan
# Tokan
