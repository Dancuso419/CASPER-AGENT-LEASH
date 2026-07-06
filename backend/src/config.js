import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

// Defaults match the live testnet deployment recorded in DEPLOYMENT.md.
export const config = {
  port: Number(process.env.PORT) || 3001,
  nodeAddress: process.env.NODE_ADDRESS || 'https://node.testnet.casper.network',
  chainName: process.env.CHAIN_NAME || 'casper-test',
  packageHash:
    process.env.PACKAGE_HASH ||
    'a7d018fcc02bec1a44d1060c6ea77be8869919a91ab4e8f5daf66ecf86acd660',
  ownerKey: process.env.OWNER_KEY || path.join(home, 'casper-keys/owner/secret_key.pem'),
  agentKey: process.env.AGENT_KEY || path.join(home, 'casper-keys/agent/secret_key.pem'),
  ownerAccountHash:
    process.env.OWNER_ACCOUNT_HASH ||
    'account-hash-104a19bb2e3b5f0db350c28d6941308d33c6134e4eb2fb246cc84b855b054dc3',
  agentAccountHash:
    process.env.AGENT_ACCOUNT_HASH ||
    'account-hash-f6bb58c04d779cdbd02c6d89fdcdb24f09eb0dea13bb8a62258990203acf33f3',
  proxyWasm: process.env.PROXY_WASM || path.join(home, 'proxy_caller.wasm'),
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
