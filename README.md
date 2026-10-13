# zcode-openclaw-bridge

Run the [ZCode](https://zcode.ai) coding agent headlessly from any other agent —
and wire the two agents you already own into each other.

Two directions, both working:

```
┌─────────────┐   exec: zcode-run "..."    ┌─────────────┐
│   OpenClaw  │ ─────────────────────────▶ │    ZCode    │
│  (Jarvis)   │ ◀───────────────────────── │  (GLM-5.3)  │
└─────────────┘    final reply on stdout    └─────────────┘
        ▲
        └── openclaw agent -m "..." --json   (ZCode → OpenClaw)
```

- **OpenClaw → ZCode**: `zcode-run "task" --cwd repo` — one-shot coding turns
  from any OpenClaw agent (or cron, or shell, or CI). This is the part that
  needed real engineering; ZCode's built-in `zcode -p` does **not** work
  standalone (explanation + full protocol notes in
  [`docs/zcode-protocol.md`](docs/zcode-protocol.md)).
- **ZCode → OpenClaw**: plain `openclaw` CLI calls — run agent turns, push
  messages to WhatsApp/Telegram/etc., or mint an MCP grant.

## Quick start

Requirements: ZCode desktop app installed and signed in (macOS today; set
`ZCODE_CJS` on other platforms), Node ≥ 20.

```bash
# 1. get zcode-run on your PATH
git clone https://github.com/divyamrastogi/zcode-openclaw-bridge.git
cd zcode-openclaw-bridge && ./install.sh

# 2. register a headless model provider
#    (reuses the Z.AI coding-plan key already stored by the ZCode desktop app;
#     or pass --api-key. Writes two 0600 files, prints nothing sensitive.)
bin/zcode-provider-setup.mjs

# 3. ping it
zcode-run 'Reply with exactly: pong' --cwd ~ --mode plan
```

## Usage

```bash
zcode-run "Fix the failing test in tests/login.spec.ts" \
  --cwd ~/projects/myapp \
  --mode edit \
  --timeout 600

# machine-readable
zcode-run "Review src/auth.ts for security issues" --cwd ~/projects/myapp --mode plan --json
```

| Flag | Default | Meaning |
|---|---|---|
| `--cwd` | `$PWD` | workspace ZCode operates on |
| `--mode` | `edit` | `plan` (read-only) / `build` / `edit` / `yolo` / `guarded` |
| `--thought` | `high` | `low` / `high` / `max` reasoning level |
| `--timeout` | `300` | turn timeout in seconds |
| `--provider` / `--model` | `custom:zai-headless` / `GLM-5.3-Flash` | model selection |
| `--json` | off | `{sessionId, model, thought, mode, durationMs, text}` |

**Safety:** when an external agent (like OpenClaw) calls zcode-run, always pass
`--mode edit` or `--mode plan`. Never wire `--mode yolo` to a chat-triggered
flow.

## Use it from OpenClaw

Copy the skill so every OpenClaw agent discovers it:

```bash
mkdir -p ~/.openclaw/workspace/skills
cp -r skills/zcode-run ~/.openclaw/workspace/skills/
openclaw skills list --agent main   # should show zcode-run as ready
```

Then just ask Jarvis: *"use zcode-run to fix the failing tests in
~/projects/myapp"* — the agent runs `zcode-run ... --mode edit` via exec and
relays the reply to your chat.

## The other direction: ZCode → OpenClaw

No bridge needed — the OpenClaw CLI does it all:

```bash
openclaw agent --agent main -m "summarize this repo" --json   # one agent turn
openclaw message send --channel telegram --target @me -m "hi" # push to chat
openclaw attach --print-config                                # mint scoped MCP tools
```

## How it works

`zcode-run` spawns `zcode.cjs app-server` and speaks ZCode's stdio protocol:
`session/create` → `session/setModel` → `session/send` → poll `session/read`
until the turn settles → print the last assistant message. It answers the
protocol's reverse-requests (`session/requestRuntimePreferences`), pins the
reasoning level on the model selection, and filters thinking parts out of the
reply.

The model comes from a custom provider (`custom:zai-headless`) that
`zcode-provider-setup.mjs` registers by **instantiating a builtin template**
(`zai-api`) — the only way a standalone custom provider makes it into ZCode's
provider registry. Full reverse-engineering notes, gotchas, and the credential
decryption scheme: [`docs/zcode-protocol.md`](docs/zcode-protocol.md).

## Limitations

- One fresh session per call (no `--resume` yet).
- macOS-first: `zcode.cjs` path auto-detection covers the app bundle; other
  platforms need `ZCODE_CJS`.
- GLM models may leak a little reasoning text before the answer at higher
  thought levels.
- ZCode is a moving target — protocol methods verified against 0.16.9.

## License

MIT
