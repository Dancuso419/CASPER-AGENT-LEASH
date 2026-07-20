import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, csprToMotes, motesToCspr, ERROR_MESSAGES } from './config.js';
import * as casper from './casper.js';
import * as store from './store.js';
import { reason, geminiEnabled } from './gemini.js';

const app = express();
app.use(cors());
app.use(express.json());

const dir = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(dir, '..', 'public'))); // dashboard, if present

const explorer = (hash) => `${config.explorerBase}/deploy/${hash}`;
const resolveRecipient = (r) =>
  !r || r === 'owner' ? config.ownerAccountHash : r === 'agent' ? config.agentAccountHash : r;

// Run a write: submit deploy, wait for execution, record a log row, return a rich result.
async function runAction({ type, submit, amountMotes, recipient }) {
  const deployHash = await submit();
  const exec = await casper.pollDeploy(deployHash);
  const allowed = exec.status === 'success';
  const row = store.addLog({
    type,
    amountCspr: amountMotes ? motesToCspr(amountMotes) : undefined,
    recipient,
    deployHash,
    status: exec.status,
    errorCode: exec.errorCode,
    errorName: exec.errorName,
    message: allowed
      ? 'Allowed'
      : ERROR_MESSAGES[exec.errorCode] || exec.rawMessage || exec.status,
    explorer: explorer(deployHash),
  });
  return { allowed, deployHash, explorer: explorer(deployHash), exec, row };
}

// register_agent REVERTS (AlreadyRegistered) instead of updating, so re-registering an existing
// agent with a new cap would leave the ORIGINAL on-chain cap enforced while the dashboard shows
// the new one — transfers "over the cap" then go through because the real cap is higher. When the
// agent already exists, push the requested cap on-chain via update_cap (owner-only, we sign it) so
// the enforced cap always matches what we display.
async function reconcileCap(agentHash, capMotes) {
  return runAction({ type: 'update_cap', submit: () => casper.updateCap(agentHash, capMotes) });
}

app.get('/api/health', async (_req, res) => {
  const { existsSync } = await import('node:fs');
  const { execFile } = await import('node:child_process');
  const out = {
    casperBin:       config.casperBin,
    casperBinExists: existsSync(config.casperBin),
    ownerKeyExists:  existsSync(config.ownerKey),
    agentKeyExists:  existsSync(config.agentKey),
    proxyWasmExists: existsSync(config.proxyWasm),
    ownerKeyPath:    config.ownerKey,
    agentKeyPath:    config.agentKey,
    proxyWasmPath:   config.proxyWasm,
    agentAccountHash: config.agentAccountHash,
    ownerAccountHash: config.ownerAccountHash,
    cwd: process.cwd(),
  };
  // Safe PEM structure inspection — no key material leaked.
  try {
    const raw = existsSync(config.ownerKey) ? (await import('node:fs')).readFileSync(config.ownerKey, 'utf8') : '';
    const lines = raw.split('\n');
    out.ownerPem = {
      chars: raw.length,
      lineCount: lines.length,
      firstLine: lines[0] || '(empty)',
      lastNonEmptyLine: [...lines].reverse().find(l => l.trim()) || '(empty)',
      hasLiteralBackslashN: raw.includes('\\n'),
      hasRealNewlines: raw.includes('\n'),
      startsCorrectly: raw.startsWith('-----BEGIN'),
    };
  } catch (e) { out.ownerPem = `read error: ${e.message}`; }
  // Actually try to run the binary — the definitive test.
  execFile(config.casperBin, ['--version'], (err, stdout) => {
    out.casperVersion = err ? `SPAWN FAILED: ${err.message}` : stdout.trim();
    res.json(out);
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    nodeAddress: config.nodeAddress,
    chainName: config.chainName,
    packageHash: config.packageHash,
    ownerAccountHash: config.ownerAccountHash,
    agentAccountHash: config.agentAccountHash,
    explorerBase: config.explorerBase,
    geminiEnabled: geminiEnabled(),
  });
});

app.get('/api/status', (_req, res) => {
  const agent = store.getAgent(config.agentAccountHash);
  res.json({ agentAccountHash: config.agentAccountHash, agent });
});

app.get('/api/log', (_req, res) => res.json(store.getLog()));

app.get('/api/deploy/:hash', async (req, res) => {
  res.json(await casper.getDeploy(req.params.hash));
});

app.post('/api/register', async (req, res) => {
  try {
    const cap = Number(req.body.spendingCapCspr ?? 10);
    const capMotes = csprToMotes(cap);
    let result = await runAction({
      type: 'register',
      submit: () => casper.registerAgent(config.agentAccountHash, capMotes),
    });
    // Already on-chain: register_agent won't change the cap, so enforce it via update_cap.
    if (!result.allowed && result.exec?.errorCode === 1) {
      result = await reconcileCap(config.agentAccountHash, capMotes);
    }
    if (result.allowed) {
      store.upsertAgent(config.agentAccountHash, {
        owner: config.ownerAccountHash,
        spendingCapCspr: cap,
        allowedAction: 'TransferOnly',
        isActive: true,
        createdAt: Date.now(),
        registerDeploy: result.deployHash,
      });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/deposit', async (req, res) => {
  try {
    const amountMotes = csprToMotes(Number(req.body.amountCspr ?? 100));
    const result = await runAction({ type: 'deposit', submit: () => casper.deposit(amountMotes), amountMotes });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/action', async (req, res) => {
  try {
    const amountCspr = Number(req.body.amountCspr);
    const amountMotes = csprToMotes(amountCspr);
    const recipient = resolveRecipient(req.body.recipient);

    // Server-side cap check: reject before submitting (saves gas, gives instant feedback).
    const agent = store.getAgent(config.agentAccountHash);
    if (agent && agent.spendingCapCspr != null && amountCspr > agent.spendingCapCspr) {
      return res.json({
        allowed: false,
        blocked: true,
        reason: `Amount ${amountCspr} CSPR exceeds the spending cap of ${agent.spendingCapCspr} CSPR`,
        exec: { status: 'failure', errorCode: 5, errorName: 'ExceedsCap' },
        row: store.addLog({
          type: 'transfer', amountCspr, recipient, deployHash: null,
          status: 'failure', errorCode: 5, errorName: 'ExceedsCap',
          message: `Blocked: amount exceeds the agent spending cap (${agent.spendingCapCspr} CSPR)`,
          explorer: null,
        }),
      });
    }

    const result = await runAction({
      type: 'transfer',
      submit: () => casper.checkAndExecute(amountMotes, recipient),
      amountMotes,
      recipient,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/revoke', async (req, res) => {
  try {
    // Revoke the connected wallet's agent when one is supplied; fall back to the demo agent.
    const agentHash = req.body.agentAccountHash || config.agentAccountHash;
    const result = await runAction({ type: 'revoke', submit: () => casper.revokeAgent(agentHash) });
    if (result.allowed) store.upsertAgent(agentHash, { isActive: false });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/reactivate', async (req, res) => {
  try {
    const agentHash = req.body.agentAccountHash || config.agentAccountHash;
    const result = await runAction({ type: 'reactivate', submit: () => casper.reactivateAgent(agentHash) });
    if (result.allowed) store.upsertAgent(agentHash, { isActive: true });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Derive an account hash from a public key WITHOUT registering — lets "Connect wallet"
// just establish a session so the user can then register deliberately with a chosen cap.
app.post('/api/derive-hash', async (req, res) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey) return res.status(400).json({ error: 'publicKey required' });
    res.json({ agentAccountHash: await casper.accountAddress(publicKey) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Register a wallet-connected user's public key as a new agent.
app.post('/api/agents', async (req, res) => {
  try {
    const { publicKey, spendingCapCspr = 10 } = req.body;
    if (!publicKey) return res.status(400).json({ error: 'publicKey required' });
    const agentAccountHash = await casper.accountAddress(publicKey);
    const cap = Number(spendingCapCspr);
    const capMotes = csprToMotes(cap);
    let result = await runAction({
      type: 'register',
      submit: () => casper.registerAgent(agentAccountHash, capMotes),
    });
    // Already on-chain: register_agent won't change the cap, so enforce it via update_cap.
    if (!result.allowed && result.exec?.errorCode === 1) {
      result = await reconcileCap(agentAccountHash, capMotes);
    }
    if (result.allowed) {
      store.upsertAgent(agentAccountHash, {
        owner: config.ownerAccountHash,
        publicKey,
        spendingCapCspr: cap,
        allowedAction: 'TransferOnly',
        isActive: true,
        createdAt: Date.now(),
        registerDeploy: result.deployHash,
      });
    }
    const agent = store.getAgent(agentAccountHash);
    res.json({ ...agent, agentAccountHash, allowed: result.allowed });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/agents/:hash', (req, res) => {
  const agent = store.getAgent(req.params.hash);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ ...agent, agentAccountHash: req.params.hash });
});

// Restore a known-registered agent to the local store after a /tmp wipe — no deploy.
// The agent is already on-chain; we're just rebuilding the display cache.
app.post('/api/agents/:hash/local-restore', (req, res) => {
  const { publicKey, spendingCapCspr = 10 } = req.body;
  store.upsertAgent(req.params.hash, {
    owner: config.ownerAccountHash,
    publicKey,
    spendingCapCspr: Number(spendingCapCspr),
    allowedAction: 'TransferOnly',
    isActive: true,
  });
  res.json({ ...store.getAgent(req.params.hash), agentAccountHash: req.params.hash });
});

// Owner changes an agent's spending cap on-chain. The agent can't loosen its own leash;
// only the registering owner (the platform key) can, so this runs server-side.
app.post('/api/agents/:hash/cap', async (req, res) => {
  try {
    const newCap = Number(req.body.spendingCapCspr);
    if (!Number.isFinite(newCap) || newCap <= 0) return res.status(400).json({ error: 'spendingCapCspr must be a positive number' });
    const result = await runAction({
      type: 'update_cap',
      submit: () => casper.updateCap(req.params.hash, csprToMotes(newCap)),
    });
    if (result.allowed) store.upsertAgent(req.params.hash, { spendingCapCspr: newCap });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Main-purse CSPR balance of any account hash — used to show the connected wallet's gas.
app.get('/api/balance/:hash', async (req, res) => {
  try {
    const motes = await casper.getBalance(req.params.hash);
    res.json({ motes, cspr: motesToCspr(motes) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Contract purse balance — the shared pool agents spend from.
app.get('/api/contract-balance', async (_req, res) => {
  try {
    const motes = await casper.getBalance(config.contractPurseUref);
    res.json({ motes, cspr: motesToCspr(motes) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/agents/:hash/prepare-action', async (req, res) => {
  try {
    // Prefer the publicKey the client sends (from its wallet session) so the action path
    // survives a store wipe (Render /tmp is ephemeral); fall back to the stored agent.
    const publicKey = req.body.publicKey || store.getAgent(req.params.hash)?.publicKey;
    if (!publicKey) return res.status(400).json({ error: 'No public key for this agent — reconnect your wallet' });
    const amountCspr = Number(req.body.amountCspr);
    if (!Number.isFinite(amountCspr) || amountCspr <= 0) return res.status(400).json({ error: 'amountCspr must be a positive number' });

    // Server-side cap check: reject before preparing/signing (saves gas, gives instant feedback).
    const agent = store.getAgent(req.params.hash);
    if (agent && agent.spendingCapCspr != null && amountCspr > agent.spendingCapCspr) {
      return res.status(400).json({
        error: `Amount ${amountCspr} CSPR exceeds the spending cap of ${agent.spendingCapCspr} CSPR`,
        errorCode: 5,
        errorName: 'ExceedsCap',
      });
    }

    const amountMotes = csprToMotes(amountCspr);
    const recipient = resolveRecipient(req.body.recipient);
    const deployJson = await casper.makeCheckAndExecuteDeploy(amountMotes, recipient, publicKey);
    res.json({ deployJson, signingPublicKey: publicKey });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/agents/:hash/submit', async (req, res) => {
  try {
    const { deployJson, publicKey, signatureHex, amountCspr, recipient } = req.body;
    if (!deployJson || !publicKey || !signatureHex) {
      return res.status(400).json({ error: 'deployJson, publicKey and signatureHex are required' });
    }
    const signedDeploy = casper.attachApproval(deployJson, publicKey, signatureHex);
    const amountMotes = csprToMotes(Number(amountCspr));
    const recipientKey = resolveRecipient(recipient);
    const result = await runAction({
      type: 'transfer',
      submit: () => casper.submitSignedDeploy(signedDeploy),
      amountMotes,
      recipient: recipientKey,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// The agentic endpoint: natural language -> Gemini -> tool -> on-chain enforcement.
app.post('/api/prompt', async (req, res) => {
  try {
    const { message } = req.body;
    const decision = await reason(message);
    if (decision.call?.name === 'attempt_transfer') {
      const amountCspr = Number(decision.call.args.amount_cspr);
      const amountMotes = csprToMotes(amountCspr);
      const recipient = resolveRecipient(decision.call.args.recipient);

      // Server-side cap check: reject before submitting (saves gas, gives instant feedback).
      const agentHashForCap = req.body.agentAccountHash || config.agentAccountHash;
      const agentForCap = store.getAgent(agentHashForCap);
      if (agentForCap && agentForCap.spendingCapCspr != null && amountCspr > agentForCap.spendingCapCspr) {
        const reasoning = decision.text ||
          `Interpreted this as a transfer of ${amountCspr} CSPR to the ${decision.call.args.recipient}. ` +
          `Blocked before submission — ${amountCspr} CSPR exceeds the spending cap of ${agentForCap.spendingCapCspr} CSPR.`;
        return res.json({
          reasoning, tool: decision.call,
          result: {
            allowed: false, blocked: true,
            reason: `Amount ${amountCspr} CSPR exceeds the spending cap of ${agentForCap.spendingCapCspr} CSPR`,
            exec: { status: 'failure', errorCode: 5, errorName: 'ExceedsCap' },
            row: store.addLog({
              type: 'transfer', amountCspr, recipient: agentHashForCap, deployHash: null,
              status: 'failure', errorCode: 5, errorName: 'ExceedsCap',
              message: `Blocked: amount exceeds the agent spending cap (${agentForCap.spendingCapCspr} CSPR)`,
              explorer: null,
            }),
          },
        });
      }

      // Wallet connected: enforce THE CONNECTED WALLET's cap by having it sign, exactly like a
      // manual transfer (prepare here → client signs → /api/agents/:hash/submit). Otherwise the
      // spend would run as the demo agent and be checked against the wrong cap.
      if (req.body.publicKey && req.body.agentAccountHash) {
        const deployJson = await casper.makeCheckAndExecuteDeploy(amountMotes, recipient, req.body.publicKey);
        return res.json({
          tool: decision.call, needsSignature: true,
          deployJson, signingPublicKey: req.body.publicKey, amountCspr, recipient,
        });
      }

      // No wallet: demo path — backend signs with the demo agent key (original behavior).
      const result = await runAction({
        type: 'transfer',
        submit: () => casper.checkAndExecute(amountMotes, recipient),
        amountMotes,
        recipient,
      });
      const { recipient: rcpt, amount_cspr } = decision.call.args;
      const outcome = result.allowed
        ? `the on-chain leash allowed it — ${amount_cspr} CSPR moved`
        : `the on-chain leash blocked it (${result.exec?.errorName || 'enforcement triggered'}) — 0 CSPR moved`;
      const reasoning = decision.text ||
        `Interpreted this as a transfer of ${amount_cspr} CSPR to the ${rcpt}. Submitted to the contract, and ${outcome}.`;
      return res.json({ reasoning, tool: decision.call, result });
    }
    if (decision.call?.name === 'check_status') {
      const agent = store.getAgent(config.agentAccountHash);
      const reasoning = decision.text || (agent
        ? `Checked on-chain status: the agent is ${agent.isActive ? 'active' : 'revoked'} with a ${agent.spendingCapCspr} CSPR spending cap.`
        : `Checked on-chain status: no agent is registered yet.`);
      return res.json({ reasoning, tool: decision.call, status: agent });
    }
    res.json({ reasoning: decision.text || 'No on-chain action matched that request.', tool: null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(config.port, () => {
  console.log(`Agent Leash backend on http://localhost:${config.port}`);
  console.log(`  node: ${config.nodeAddress}  package: ${config.packageHash.slice(0, 12)}…`);
  console.log(`  gemini: ${geminiEnabled() ? 'enabled' : 'DISABLED (set GEMINI_API_KEY)'}`);
});
