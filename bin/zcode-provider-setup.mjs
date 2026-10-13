#!/usr/bin/env node
// zcode-provider-setup — generate a headless ZCode provider config.
//
// Creates two 0600 files:
//   ~/.zcode/v2/zai-headless.key               (the API key)
//   ~/.zcode/v2/provider_config.headless.json  (personal provider config)
//
// Key sources (first match wins):
//   --api-key <key>        explicit key (or env ZAI_API_KEY)
//   default                decrypt the coding-plan key already stored by the
//                          ZCode desktop app in ~/.zcode/v2/credentials.json
//
// Other flags:
//   --provider-id <id>     default: custom:zai-headless
//   --template-id <id>     builtin template to instantiate (default: zai-api).
//                          The provider will NOT register without a template.
//   --models <a,b,c>       default: GLM-5.3-Flash,GLM-5.3
//   --base-url <url>       default: https://api.z.ai/api/anthropic
//   --api-type <type>      anthropic-messages | openai-chat-completions | openai-responses
//   --key-file <path>      where to write the key (default ~/.zcode/v2/zai-headless.key)
//   --config-file <path>   where to write the config (default ~/.zcode/v2/provider_config.headless.json)
//
// The decryption path is read-only on ZCode's own files: it uses the same
// derivation the ZCode CLI itself uses locally (sha256 of a platform/homedir
// string, AES-256-GCM). Nothing is printed; outputs are chmod 600.

import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

const home = homedir();
const providerId = flag("--provider-id", "custom:zai-headless");
const templateId = flag("--template-id", "zai-api");
const models = flag("--models", "GLM-5.3-Flash,GLM-5.3").split(",").map((s) => s.trim()).filter(Boolean);
const apiType = flag("--api-type", "anthropic-messages");
const baseUrl = flag("--base-url", "https://api.z.ai/api/anthropic");
const keyFile = flag("--key-file", join(home, ".zcode", "v2", `${providerId.replace(/^custom:/, "")}.key`)).replace(/^~/, home);
const configFile = flag("--config-file", join(home, ".zcode", "v2", "provider_config.headless.json")).replace(/^~/, home);

function fail(msg) { console.error("zcode-provider-setup:", msg); process.exit(1); }

// --- ZCode credential decryption (same derivation as the ZCode CLI) ---------
function credentialSecret() {
  if (process.env.ZCODE_CREDENTIAL_SECRET?.trim()) return process.env.ZCODE_CREDENTIAL_SECRET.trim();
  let user = "unknown";
  try { user = userInfo().username; } catch {}
  return `zcode-credential-fallback:${platform()}:${home}:${user}`;
}

function decryptValue(value) {
  const prefix = "enc:v1:";
  if (!value.startsWith(prefix)) return value;
  const [iv, tag, data] = value.slice(prefix.length).split(".").map((x) => Buffer.from(x, "base64url"));
  const key = createHash("sha256").update(credentialSecret()).digest();
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf-8");
}

function decryptZaiKeyFromCredentials() {
  const credsPath = join(home, ".zcode", "v2", "credentials.json");
  if (!existsSync(credsPath)) fail(`no --api-key given and ${credsPath} not found`);
  const creds = JSON.parse(readFileSync(credsPath, "utf8"));
  const entry = Object.keys(creds).find((k) =>
    k.includes("account:zai-individual-coding-plan") && k.endsWith("api-key"));
  if (!entry) fail("no account:zai-individual-coding-plan api-key entry in credentials.json — is the desktop app signed in?");
  const key = decryptValue(creds[entry]);
  if (!key) fail("decrypted key is empty");
  return key;
}

const apiKey = flag("--api-key", process.env.ZAI_API_KEY || "") || decryptZaiKeyFromCredentials();
const keyId = randomUUID().slice(0, 8); // not secret; keeps concurrent setups distinguishable in logs

const providerConfig = {
  schemaVersion: 1,
  config: {
    providerConfigRules: {
      providerRules: [{
        providerId,
        templateId, // REQUIRED: the provider only registers when it instantiates a builtin template
        providerName: "ZCode Headless",
        enabled: true,
        config: {
          group: "standard-personal",
          access: { type: "api-key", apiKey },
          api: { type: apiType, baseUrl },
          personalModelIds: models,
          modelOrder: models,
          visibility: "visible",
        },
      }],
    },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    defaultModelSelection: { providerId, modelId: models[0] },
  },
};

mkdirSync(join(keyFile, ".."), { recursive: true });
writeFileSync(keyFile, apiKey, { mode: 0o600 });
writeFileSync(configFile, JSON.stringify(providerConfig, null, 2), { mode: 0o600 });
chmodSync(keyFile, 0o600);
chmodSync(configFile, 0o600);

console.log(`provider ${providerId} configured (key id ${keyId})`);
console.log(`  key:    ${keyFile}`);
console.log(`  config: ${configFile}`);
console.log(`\ntest it:`);
console.log(`  zcode-run 'Reply with exactly: pong' --provider ${providerId} --model ${models[0]} --mode plan`);
