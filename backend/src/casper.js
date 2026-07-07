// Thin wrapper over casper-client. Uses execFile (no shell) so args never need quoting.
// Every command here mirrors a call proven working in DEPLOYMENT.md.
import { execFile } from 'node:child_process';
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

// Poll until the deploy is executed (or timeout). Returns the parsed execution result.
export async function pollDeploy(hash, { attempts = 30, intervalMs = 4000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const res = await getDeploy(hash).catch(() => ({ status: 'pending' }));
    if (res.status !== 'pending') return res;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { status: 'timeout' };
}
