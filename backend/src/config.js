import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const home = os.homedir();
// backend/ dir, resolved relative to this file — works wherever Render checks out the repo.
const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Pick the casper-client binary: explicit env > bundled Linux binary in repo > PATH.
function resolveCasperBin() {
  if (process.env.CASPER_CLIENT) return process.env.CASPER_CLIENT;
  const bundled = path.join(backendDir, 'casper-client-linux');
  if (fs.existsSync(bundled)) {
    try { fs.chmodSync(bundled, 0o755); } catch { /* best effort */ }
    return bundled;
  }
  return 'casper-client'; // fall back to PATH (local dev)
}

// Cloud deployment (Render): write key content from env vars to temp files on startup.
// Env vars store PEM newlines as literal "\n"; convert back to real line breaks,
// strip surrounding quotes, and ensure a trailing newline (casper-client is strict).
function normalizePem(raw) {
  let pem = raw.trim().replace(/^["']|["']$/g, ''); // strip wrapping quotes if present
  pem = pem.replace(/\\n/g, '\n');                  // literal \n -> real newline
  if (!pem.endsWith('\n')) pem += '\n';
  return pem;
}
if (process.env.OWNER_KEY_CONTENT) {
  fs.writeFileSync('/tmp/owner_key.pem', normalizePem(process.env.OWNER_KEY_CONTENT), { mode: 0o600 });
}
if (process.env.AGENT_KEY_CONTENT) {
  fs.writeFileSync('/tmp/agent_key.pem', normalizePem(process.env.AGENT_KEY_CONTENT), { mode: 0o600 });
}

// Defaults match the live testnet deployment recorded in DEPLOYMENT.md.
export const config = {
  port: Number(process.env.PORT) || 3001,
  nodeAddress: process.env.NODE_ADDRESS || 'https://node.testnet.casper.network',
  chainName: process.env.CHAIN_NAME || 'casper-test',
  packageHash:
    process.env.PACKAGE_HASH ||
    'a7d018fcc02bec1a44d1060c6ea77be8869919a91ab4e8f5daf66ecf86acd660',
  ownerKey: process.env.OWNER_KEY ||
    (process.env.OWNER_KEY_CONTENT ? '/tmp/owner_key.pem' : path.join(home, 'casper-keys/owner/secret_key.pem')),
  agentKey: process.env.AGENT_KEY ||
    (process.env.AGENT_KEY_CONTENT ? '/tmp/agent_key.pem' : path.join(home, 'casper-keys/agent/secret_key.pem')),
  ownerAccountHash:
    process.env.OWNER_ACCOUNT_HASH ||
    'account-hash-104a19bb2e3b5f0db350c28d6941308d33c6134e4eb2fb246cc84b855b054dc3',
  agentAccountHash:
    process.env.AGENT_ACCOUNT_HASH ||
    'account-hash-6bd38f839796576f2a9f3ce3721697519f3f24d21f455755c084ed71d69c2d68',
  proxyWasm: process.env.PROXY_WASM || path.join(backendDir, 'proxy_caller.wasm'),
  casperBin: resolveCasperBin(),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  explorerBase: 'https://testnet.cspr.live',
};

export const MOTES_PER_CSPR = 1_000_000_000n;

export const csprToMotes = (cspr) =>
  (BigInt(Math.round(Number(cspr) * 1e9))).toString();

export const motesToCspr = (motes) => Number(BigInt(motes)) / 1e9;

// Contract error codes (from #[odra::odra_error]) → human messages.
export const ERROR_CODES = {
  1: 'AlreadyRegistered',
  2: 'NotOwner',
  3: 'AgentNotFound',
  4: 'Revoked',
  5: 'ExceedsCap',
  6: 'ActionNotAllowed',
};

export const ERROR_MESSAGES = {
  4: 'Blocked: agent has been revoked',
  5: 'Blocked: amount exceeds the agent spending cap',
  2: 'Blocked: only the owner can perform this action',
  3: 'Blocked: agent is not registered',
};
