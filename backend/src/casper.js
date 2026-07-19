// Thin wrapper over casper-client. Uses execFile (no shell) so args never need quoting.
// Every command here mirrors a call proven working in DEPLOYMENT.md.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config, ERROR_CODES } from './config.js';

const run = (args) =>
  new Promise((resolve, reject) => {
    execFile(config.casperBin, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      // casper-client prints a deprecation banner before the JSON on put-deploy; slice from first '{'.
      const text = (stdout || '') + (stderr || '');
      const start = text.indexOf('{');
      if (start === -1) return reject(new Error(stderr || stdout || String(err)));
      try {
        resolve(JSON.parse(text.slice(start)));
      } catch (e) {
        reject(new Error(`Could not parse casper-client output: ${text.slice(0, 400)}`));
      }
    });
  });

const common = () => [
  '--node-address', config.nodeAddress,
  '--chain-name', config.chainName,
];

const submit = (json) => {
  const hash = json?.result?.deploy_hash;
  if (!hash) throw new Error(`No deploy_hash in response: ${JSON.stringify(json).slice(0, 300)}`);
  return hash;
};

export async function registerAgent(agentAccountHash, spendingCapMotes) {
  const json = await run([
    'put-deploy', ...common(),
    '--secret-key', config.ownerKey,
    '--session-package-hash', config.packageHash,
    '--session-entry-point', 'register_agent',
    '--payment-amount', '12000000000',
    '--session-arg', `agent:key='${agentAccountHash}'`,
    '--session-arg', `spending_cap:u512='${spendingCapMotes}'`,
    "--session-arg", "allowed_action:u8='0'",
  ]);
  return submit(json);
}

export async function checkAndExecute(amountMotes, recipientKey, signer = 'agent') {
  const json = await run([
    'put-deploy', ...common(),
    '--secret-key', signer === 'agent' ? config.agentKey : config.ownerKey,
    '--session-package-hash', config.packageHash,
    '--session-entry-point', 'check_and_execute',
    '--payment-amount', '12000000000',
    '--session-arg', `amount:u512='${amountMotes}'`,
    '--session-arg', `recipient:key='${recipientKey}'`,
  ]);
  return submit(json);
}

export async function revokeAgent(agentAccountHash) {
  const json = await run([
    'put-deploy', ...common(),
    '--secret-key', config.ownerKey,
    '--session-package-hash', config.packageHash,
    '--session-entry-point', 'revoke_agent',
    '--payment-amount', '10000000000',
    '--session-arg', `agent:key='${agentAccountHash}'`,
  ]);
  return submit(json);
}

// Fund the contract purse via Odra's proxy_caller (deposit is payable).
export async function deposit(amountMotes) {
  const json = await run([
    'put-deploy', ...common(),
    '--secret-key', config.ownerKey,
    '--session-path', config.proxyWasm,
    '--payment-amount', '15000000000',
    '--session-arg', `package_hash:byte_array_32='${config.packageHash}'`,
    "--session-arg", "entry_point:string='deposit'",
    "--session-arg", "args:byte_list='00000000'",
    '--session-arg', `attached_value:u512='${amountMotes}'`,
    '--session-arg', `amount:u512='${amountMotes}'`,
  ]);
  return submit(json);
}

// Navigate the (Version1|Version2) execution result. Returns {status, errorCode, errorName, cost}.
function parseExecution(json) {
  const info = json?.result?.execution_info;
  const exec = info?.execution_result;
  if (!exec) return { status: 'pending' };
  const inner = exec.Version2 || exec.Version1 || exec;
  const msg = inner.error_message;
  if (msg === null || msg === undefined) {
    return { status: 'success', cost: inner.cost, block: info.block_height };
  }
  const m = /User error:\s*(\d+)/.exec(msg);
  const code = m ? Number(m[1]) : null;
  return {
    status: 'failure',
    errorCode: code,
    errorName: code ? ERROR_CODES[code] : null,
    rawMessage: msg,
    block: info.block_height,
  };
}

export async function getDeploy(hash) {
  // get-deploy takes only --node-address (+ hash), NOT --chain-name.
  const json = await run(['get-deploy', '--node-address', config.nodeAddress, hash]);
  return parseExecution(json);
}

// Produces an unsigned deploy JSON for check_and_execute, to be signed by the wallet.
// --session-account sets the deploy header account without a secret key (verified Task 1).
export async function makeCheckAndExecuteDeploy(amountMotes, recipientKey, signingPublicKey) {
  const outFile = path.join(tmpdir(), `deploy-${randomUUID()}.json`);
  await new Promise((resolve, reject) => {
    execFile(
      config.casperBin,
      [
        'make-deploy',
        '--chain-name', config.chainName,
        '--session-package-hash', config.packageHash,
        '--session-entry-point', 'check_and_execute',
        '--payment-amount', '12000000000',
        '--session-arg', `amount:u512='${amountMotes}'`,
        '--session-arg', `recipient:key='${recipientKey}'`,
        '--session-account', signingPublicKey,
        '--output', outFile,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) return reject(new Error(`make-deploy failed: ${stderr || err.message}`));
        resolve();
      }
    );
  });
  const deployJson = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  fs.unlinkSync(outFile);
  return deployJson;
}

// Attach a wallet signature to an unsigned deploy, producing a submittable signed deploy.
// Casper Wallet's sign() returns only the raw 64-byte signature (signatureHex, 128 chars);
// a deploy approval needs it prefixed with the key's algorithm tag byte (01=ed25519,
// 02=secp256k1), which is the same as the public key's first byte. Verified against
// `casper-client sign-deploy` ground truth: signer = full pubkey hex, signature = tag+rawsig.
// Handles both 128-char (untagged) and 130-char (already-tagged) inputs defensively.
export function attachApproval(deployJson, publicKeyHex, signatureHex) {
  const tag = publicKeyHex.slice(0, 2);
  const signature = signatureHex.length === 130 ? signatureHex : tag + signatureHex;
  return { ...deployJson, approvals: [{ signer: publicKeyHex, signature }] };
}

// Submits a pre-signed deploy JSON to the network.
export async function submitSignedDeploy(signedDeployJson) {
  const inFile = path.join(tmpdir(), `signed-${randomUUID()}.json`);
  fs.writeFileSync(inFile, JSON.stringify(signedDeployJson));
  let json;
  try {
    json = await new Promise((resolve, reject) => {
      execFile(
        config.casperBin,
        ['send-deploy', '--node-address', config.nodeAddress, '--input', inFile],
        { maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const text = (stdout || '') + (stderr || '');
          const start = text.indexOf('{');
          if (start === -1) return reject(new Error(stderr || stdout || String(err)));
          try { resolve(JSON.parse(text.slice(start))); }
          catch (e) { reject(new Error(`Could not parse send-deploy output: ${text.slice(0, 400)}`)); }
        }
      );
    });
  } finally {
    try { fs.unlinkSync(inFile); } catch { /* best effort */ }
  }
  const hash = json?.result?.deploy_hash;
  if (!hash) throw new Error(`No deploy_hash in send-deploy response: ${JSON.stringify(json).slice(0, 300)}`);
  return hash;
}

// Returns the main-purse balance (in motes, as a string) for an account hash or public key.
export async function getBalance(purseIdentifier) {
  const json = await run([
    'query-balance',
    '--node-address', config.nodeAddress,
    '--purse-identifier', purseIdentifier,
  ]);
  const balance = json?.result?.balance;
  if (balance === undefined) throw new Error(`No balance in response: ${JSON.stringify(json).slice(0, 200)}`);
  return balance;
}

// Returns "account-hash-<64hexchars>" for a given hex public key.
// account-address outputs a plain string (not JSON), so we bypass run().
export async function accountAddress(publicKeyHex) {
  return new Promise((resolve, reject) => {
    execFile(
      config.casperBin,
      ['account-address', '--public-key', publicKeyHex],
      (err, stdout, stderr) => {
        const output = (stdout || '').trim();
        if (!output.startsWith('account-hash-')) {
          return reject(new Error(`account-address failed: ${stderr || output}`));
        }
        resolve(output);
      }
    );
  });
}

// Poll until the deploy is executed (or timeout). Returns the parsed execution result.
export async function pollDeploy(hash, { attempts = 30, intervalMs = 4000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const res = await getDeploy(hash).catch(() => ({ status: 'pending' }));
    if (res.status !== 'pending') return res;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { status: 'timeout' };
}
