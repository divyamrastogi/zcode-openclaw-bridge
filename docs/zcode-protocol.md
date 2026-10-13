# ZCode Protocol — field notes for headless clients

Everything below was derived empirically from ZCode 0.16.9 (macOS). It documents
how to drive ZCode headlessly over its **app-server** stdio protocol, and the
gotchas that make the obvious approaches fail.

## Why not `zcode -p`?

The built-in headless mode (`zcode -p "..."`) fails on a standalone machine with:

```
Error: Model creation failed
Cause: Error: Select a model before continuing
```

Root cause chain:

1. A headless turn resolves its model from `session.modelSelection` (or a turn
   intent). A fresh headless session has neither.
2. The configured-default / provider machinery can't help because **account
   providers (`account:zai-*`, `account:bigmodel-*`) only materialize through
   the desktop app's injected model adapter + host process**. In a standalone
   run they all come up `entitled: false` and the provider registry is empty
   (`provider_registry.ready {providerCount: 0}`).
3. Personal custom providers *can* register standalone — but only if they
   **instantiate a builtin template** (see gotcha #3).

Hence this repo: spawn `zcode.cjs app-server` yourself, speak the protocol, and
register a template-backed custom provider.

## Transport

`node zcode.cjs app-server` speaks newline-delimited JSON on stdio:

- request:  `{"id": 1, "method": "session/create", "params": {...}}`
- response: `{"id": 1, "result": {...}}` or `{"id": 1, "error": {code, message}}`
- notifications (no id): `{"method": "startup/storageState", "params": {...}}` etc.
- **reverse requests**: the server also sends requests *to the client* (with an
  id). You must answer `session/requestRuntimePreferences` or `session/create`
  hangs. A minimal answer:

```json
{"id": <their id>, "result": {"nativeSearchEnhancementsEnabled": false,
  "memoryEnabled": false, "askUserQuestionAutoResolutionEnabled": true}}
```

`interaction/requestOfficialMcpAuthHeaders` can be answered with a JSON-RPC
error — it only gates official-plugin MCP auth.

## Session flow

| Step | Method | Key params |
|---|---|---|
| 1 | `session/create` | `workspace: {workspacePath, workspaceKey}`, `mode` (`plan\|build\|edit\|yolo\|guarded\|auto`), `model: {providerId, modelId, options: {reasoningLevel}}`, `persistence: "deferred"`, `titleGenerationEnabled: false` |
| 2 | `session/setModel` | `sessionId`, same model shape — **required**; see gotcha #2 |
| 3 | `session/send` | `sessionId`, `content` (the prompt) |
| 4 | `session/read` (poll) | `sessionId` → snapshot |
| 5 | `session/close` | `sessionId` |

Other methods seen on the wire: `session/list`, `session/resume`,
`session/messages`, `session/events`, `session/stop`, `session/compact`,
`session/fork`, `session/goal`, `session/setMode`, `session/setThoughtLevel`,
`runtime/capabilities`.

## Reading the snapshot

`session/read` returns a snapshot where:

- `session.status` ∈ `idle | running | waiting | paused | completed | error`
- `session.sessionId` — note `projection.sessionId` can be `"unknown"`
- `messages[]` — each message is `{info: {...}, parts: [...]}`:
  - **role lives at `info.role`** (`user` / `assistant`), not `.role`
  - assistant text is in `parts` entries with `type: "text"` (thinking has its
    own part type — filter it out)
- `projection.lastError` — structured last failure (`invalid_model_request`, …)
- `settings.model.available` — the resolved model list (great for debugging
  registry problems)

## Registry gotchas (each one cost us an hour)

1. **Provider config env override is atomic.** The CLI only honors
   `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` + `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`
   if **both** are set (`if (t && n)` in the resolver). Setting one silently
   does nothing.
2. **Reasoning level must ride on the model selection.** GLM models reject
   `invalid_model_request: Reasoning level is required` otherwise.
   `session/create`'s `thoughtLevel` param is not enough: the turn re-resolves
   from the session selection, so pass
   `model: {providerId, modelId, options: {reasoningLevel}}` to *both* create
   and setModel.
3. **Custom providers need `templateId`.** A personal `providerRule` with just
   `access` + `api` does not register. Adding
   `"templateId": "zai-api"` (a template declared in `zcode-builtin.json`,
   which ships with the app at `.../Resources/config/provider/zcode-builtin.json`
   and is materialized per-version under
   `~/.zcode/v2/runtime/provider/<platform>/<appVersion>/endpoint-<hash>/`)
   makes it instantiate and appear.
4. **Fresh sessions start "idle"** — poll until you see `running`, then wait
   for `idle` again, or you'll race the turn start.
5. **Credentials are encrypted at rest** (`enc:v1:...` in
   `~/.zcode/v2/credentials.json`) with AES-256-GCM whose key is
   `sha256("zcode-credential-fallback:<platform>:<homedir>:<username>")`
   (or `ZCODE_CREDENTIAL_SECRET`). Any local process can derive it — that's how
   `zcode-provider-setup` recovers your coding-plan API key without the desktop
   running.

## Model shapes

Selection object (zod `Nl`):

```json
{"providerId": "custom:zai-headless", "modelId": "GLM-5.3-Flash",
 "options": {"reasoningLevel": "high"}}
```

Personal provider rule (`providerConfigRules.providerRules[]`):

```json
{
  "providerId": "custom:zai-headless",
  "templateId": "zai-api",
  "providerName": "ZCode Headless",
  "enabled": true,
  "config": {
    "group": "standard-personal",
    "access": {"type": "api-key", "apiKey": "..."},
    "api": {"type": "anthropic-messages", "baseUrl": "https://api.z.ai/api/anthropic"},
    "personalModelIds": ["GLM-5.3-Flash", "GLM-5.3"],
    "modelOrder": ["GLM-5.3-Flash", "GLM-5.3"],
    "visibility": "visible"
  }
}
```

API types: `anthropic-messages`, `openai-chat-completions`, `openai-responses`.
