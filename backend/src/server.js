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
    const alreadyRegistered = !result.allowed && result.exec?.errorCode === 1;
    if (result.allowed || alreadyRegistered) {
      store.upsertAgent(config.agentAccountHash, {
        owner: config.ownerAccountHash,
        spendingCapCspr: cap,
        allowedAction: 'TransferOnly',
        isActive: true,
        createdAt: Date.now(),
        registerDeploy: result.deployHash,
      });
    }
    // Treat AlreadyRegistered as idempotent success — agent IS registered on-chain.
    if (alreadyRegistered) result = { ...result, allowed: true };
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
    const amountMotes = csprToMotes(Number(req.body.amountCspr));
    const recipient = resolveRecipient(req.body.recipient);
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
    const result = await runAction({ type: 'revoke', submit: () => casper.revokeAgent(config.agentAccountHash) });
    if (result.allowed) store.upsertAgent(config.agentAccountHash, { isActive: false });
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
      const amountMotes = csprToMotes(Number(decision.call.args.amount_cspr));
      const recipient = resolveRecipient(decision.call.args.recipient);
      const result = await runAction({
        type: 'transfer',
        submit: () => casper.checkAndExecute(amountMotes, recipient),
        amountMotes,
        recipient,
      });
      return res.json({ reasoning: decision.text, tool: decision.call, result });
    }
    if (decision.call?.name === 'check_status') {
      return res.json({ reasoning: decision.text, tool: decision.call, status: store.getAgent(config.agentAccountHash) });
    }
    res.json({ reasoning: decision.text, tool: null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(config.port, () => {
  console.log(`Agent Leash backend on http://localhost:${config.port}`);
  console.log(`  node: ${config.nodeAddress}  package: ${config.packageHash.slice(0, 12)}…`);
  console.log(`  gemini: ${geminiEnabled() ? 'enabled' : 'DISABLED (set GEMINI_API_KEY)'}`);
});
