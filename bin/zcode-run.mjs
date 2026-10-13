#!/usr/bin/env node
// zcode-run — headless one-shot driver for the ZCode app-server protocol.
//
// Usage: zcode-run "prompt" [options]
//   --cwd <path>          workspace (default: $PWD)
//   --mode <mode>         plan | build | edit | yolo | guarded   (default: edit)
//   --thought <level>     low | high | max                    (default: high)
//   --timeout <secs>      turn timeout                        (default: 300)
//   --provider <id>       model provider id                   (default: custom:zai-headless)
//   --model <id>          model id                            (default: GLM-5.3-Flash)
//   --provider-config <p> personal provider config override
//   --zcode-cjs <path>    path to ZCode's zcode.cjs (or env ZCODE_CJS)
//   --json                machine-readable output {sessionId, model, text, durationMs}
//   --debug               verbose diagnostics on stderr
//
// Prints the assistant's final reply to stdout. Exit 0 on success, 1 on failure.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const debug = args.includes("--debug");
const asJson = args.includes("--json");

const valueFlags = ["--cwd", "--mode", "--timeout", "--thought", "--provider", "--model", "--provider-config", "--zcode-cjs"];
let prompt = null;
for (let i = 0; i < args.length; i++) {
  if (valueFlags.includes(args[i])) { i++; continue; }
  if (!args[i].startsWith("--")) { prompt = args[i]; break; }
}

const cwd = flag("--cwd", process.cwd()).replace(/^~/, homedir());
const mode = flag("--mode", "edit");
const thought = flag("--thought", "high");
const timeoutSec = Number(flag("--timeout", "300"));
const providerId = flag("--provider", process.env.ZCODE_RUN_PROVIDER || "custom:zai-headless");
const modelId = flag("--model", process.env.ZCODE_RUN_MODEL || "GLM-5.3-Flash");

if (!prompt) fail('usage: zcode-run "prompt" [--cwd path] [--mode edit] [--thought high] [--timeout 300] [--provider id] [--model id] [--json] [--debug]');

function fail(msg) {
  console.error("zcode-run:", msg);
  process.exit(1);
}

// --- locate zcode.cjs -------------------------------------------------------
function findZcodeCjs() {
  const fromFlag = flag("--zcode-cjs", process.env.ZCODE_CJS || "");
  if (fromFlag) return fromFlag.replace(/^~/, homedir());
  const candidates = [
    "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs", // macOS
    join(homedir(), ".zcode", "glm", "zcode.cjs"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  fail("cannot locate zcode.cjs — set ZCODE_CJS or pass --zcode-cjs <path>");
}

// --- newest materialized builtin provider config ----------------------------
function newestBuiltinConfig() {
  const root = join(homedir(), ".zcode", "v2", "runtime", "provider");
  let best = null, bestM = 0;
  try {
    for (const p of readdirSync(root, { recursive: true })) {
      if (!String(p).endsWith(join("zcode-builtin.json"))) continue;
      const full = join(root, String(p));
      const m = statSync(full).mtimeMs;
      if (m > bestM) { bestM = m; best = full; }
    }
  } catch {}
  return best;
}

function bundledBuiltinConfig(zcodeCjs) {
  // macOS app bundle fallback (also carries the zai-api template rules)
  const candidate = join(zcodeCjs, "..", "..", "..", "..", "config", "provider", "zcode-builtin.json");
  return existsSync(candidate) ? candidate : null;
}

// --- protocol plumbing ------------------------------------------------------
const ZCODE_CJS = findZcodeCjs();
const childEnv = { ...process.env };
// Both env vars must be set together or the CLI ignores the override.
childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE =
  flag("--builtin-config", "") || newestBuiltinConfig() || bundledBuiltinConfig(ZCODE_CJS) || "";
childEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE =
  flag("--provider-config", join(homedir(), ".zcode", "v2", "provider_config.headless.json")).replace(/^~/, homedir());
if (debug) console.error("[zcode.cjs]", ZCODE_CJS, "\n[builtin]", childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, "\n[personal]", childEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE);

if (!existsSync(childEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE)) {
  fail(`provider config not found: ${childEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE}\n` +
       "run: npx zcode-provider-setup (or see the repo README) to create it");
}

const child = spawn(process.execPath, [ZCODE_CJS, "app-server"], { stdio: ["pipe", "pipe", "pipe"], cwd, env: childEnv });
child.stderr.on("data", (d) => { if (debug) process.stderr.write("[srv] " + d); });

let buf = "";
let nextId = 1;
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.id !== undefined && msg.method === "session/requestRuntimePreferences") {
      // The server asks the *client* for session prefs; a minimal answer unblocks session/create.
      child.stdin.write(JSON.stringify({
        id: msg.id,
        result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true },
      }) + "\n");
    } else if (msg.id !== undefined && msg.method === "interaction/requestOfficialMcpAuthHeaders") {
      child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "zcode-run: no official MCP auth" } }) + "\n");
    } else if (debug && msg.method) {
      console.error("[evt]", msg.method);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }
    }, 60000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assistantText(snapshot) {
  const msgs = (snapshot && snapshot.messages) || [];
  for (let k = msgs.length - 1; k >= 0; k--) {
    const m = msgs[k];
    // Note: role lives at info.role, not .role
    const role = (m.info && m.info.role) || m.role;
    if (role !== "assistant") continue;
    const parts = m.parts || m.content || [];
    const text = (Array.isArray(parts) ? parts : [])
      .filter((p) => typeof p === "object" && p.type ? p.type === "text" : true) // skip thinking parts
      .map((p) => (typeof p === "string" ? p : p.text ?? p.content))
      .filter((t) => typeof t === "string")
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

async function main() {
  const started = Date.now();
  if (!existsSync(cwd)) fail(`--cwd does not exist: ${cwd}`);

  const created = await rpc("session/create", {
    workspace: { workspacePath: cwd, workspaceKey: cwd },
    mode,
    model: { providerId, modelId, options: { reasoningLevel: thought } },
    titleGenerationEnabled: false,
    persistence: "deferred",
  }).catch((e) => fail(`session/create failed: ${e.message}`));

  const snap = created.value || created;
  const sessionId = (snap.session && snap.session.sessionId) || snap.sessionId;
  if (!sessionId || sessionId === "unknown") fail("no sessionId in create response: " + JSON.stringify(snap).slice(0, 300));
  if (debug) console.error("[models]", JSON.stringify(snap.settings?.model?.available || []).slice(0, 300));

  // The turn re-resolves the model from the session selection, so the
  // reasoning level must ride on setModel too — create-time options get dropped.
  await rpc("session/setModel", { sessionId, model: { providerId, modelId, options: { reasoningLevel: thought } } })
    .catch((e) => fail(`session/setModel failed: ${e.message}`));

  await rpc("session/send", { sessionId, content: prompt }).catch((e) => fail(`session/send failed: ${e.message}`));

  const deadline = Date.now() + timeoutSec * 1000;
  let lastStatus = "";
  let sawRunning = false;
  let idleReads = 0;
  while (Date.now() < deadline) {
    await sleep(700);
    let snap;
    try { snap = await rpc("session/read", { sessionId }); } catch { continue; }
    const s = snap.value || snap;
    const status = (s.session && s.session.status) || s.status;
    if (status !== lastStatus) { if (debug) console.error("[status]", status); lastStatus = status; }
    if (status === "running" || status === "waiting" || status === "paused") sawRunning = true;
    const done = status === "idle" || status === "completed" || status === "error";
    if (!done) { idleReads = 0; continue; }
    // Guard against reading "idle" before the turn actually starts.
    if (!sawRunning && status === "idle" && ++idleReads < 6) continue;
    const text = assistantText(s);
    rpc("session/close", { sessionId }).catch(() => {});
    child.kill();
    if (!text) {
      if (debug) {
        const digest = (s.messages || []).map((m) => {
          const role = (m.info && m.info.role) || m.role;
          const t = m.parts && m.parts.map((p) => p.text).filter(Boolean).join("").slice(0, 60);
          return `${role}:${JSON.stringify(t)}`;
        }).join(" | ");
        console.error("[msgs]", digest.slice(0, 1500));
        console.error("[lastError]", JSON.stringify(s.projection && s.projection.lastError || null));
      }
      fail(`turn ended with status=${status} and no assistant text (try --debug)`);
    }
    if (asJson) {
      console.log(JSON.stringify({ sessionId, model: `${providerId}/${modelId}`, thought, mode, durationMs: Date.now() - started, text }));
    } else {
      console.log(text);
    }
    process.exit(0);
  }
  child.kill();
  fail(`timed out after ${timeoutSec}s (last status: ${lastStatus})`);
}

main().catch((e) => fail(e.message));
