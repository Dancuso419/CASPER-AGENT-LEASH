# Wallet-Connect Multi-Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any user connect their Casper Wallet browser extension to create and control their own on-chain agent on the Leash dashboard.

**Architecture:** Backend prepares an unsigned deploy via `casper-client make-deploy`, the Casper Wallet extension signs it in the browser, and the backend submits + polls the signed deploy. Owner operations (register, revoke, deposit) stay fully server-side. Existing single-agent endpoints are untouched.

**Tech Stack:** Node/Express backend, `casper-client` CLI (via child_process), `window.CasperWalletProvider` browser API, vanilla JS dashboard (no framework).

---

## File Map

| File | Change |
|---|---|
| `backend/src/casper.js` | Add `accountAddress()`, `makeCheckAndExecuteDeploy()`, `submitSignedDeploy()` |
| `backend/src/server.js` | Add `POST /api/agents`, `GET /api/agents/:hash`, `POST /api/agents/:hash/prepare-action`, `POST /api/agents/:hash/submit` |
| `backend/public/dashboard.html` | Add wallet connect button + provider logic; update `refresh()` for connected agent; replace action flow with prepare→sign→submit |

---

## CRITICAL: Read Before Implementing

All work in Tasks 2–6 runs in **WSL2 Ubuntu** (not Windows). See CLAUDE.md §2.6 — the backend must run from `~/agent-leash-backend` on the Linux filesystem, not `/mnt/c`. `casper-client` is on PATH in WSL. The Node server is started with `setsid nohup` to survive WSL bridge SIGTERM.

---

## Task 1: Verify casper-client unsigned deploy commands (WSL)

**Files:** None — verification only. Results gate Tasks 2–6.

- [ ] **Step 1: Check make-deploy flags**

In WSL, run:
```bash
casper-client make-deploy --help 2>&1 | head -80
```

Look for:
- An `--output <file>` flag (to write the unsigned deploy JSON to disk)
- A flag to set the account/sender public key WITHOUT a secret key file (candidate: `--account <hex>` or `--public-key <hex>`)
- Confirm the command exists (not just `put-deploy`)

- [ ] **Step 2: Check send-deploy flags**

```bash
casper-client send-deploy --help 2>&1 | head -40
```

Look for:
- `--input <file>` flag to submit a pre-signed deploy JSON from disk
- Confirm `--node-address` is accepted (consistent with other commands)

- [ ] **Step 3: Check account-address output format**

```bash
casper-client account-address --public-key 0171c6bddaec3e35df7fe9d8bbaa43ee35cb48060c9fc24f0e20c28a9f7d83db65
```

Confirm: output is a plain string `account-hash-<64 hex chars>` (no JSON wrapper).

- [ ] **Step 4: Record findings**

Fill in the VERIFY comments in Tasks 3 before proceeding. Specifically record:
- The exact flag name for setting the deploy account without a secret key
- Whether `make-deploy` exists as a standalone command or is only available as `put-deploy`

**If `make-deploy` does not exist or cannot produce an unsigned deploy:** The fallback is to use `casper-js-sdk` on the backend to construct the deploy. Stop and raise this with the user before continuing.

---

## Task 2: Add `accountAddress()` to casper.js

**Files:**
- Modify: `backend/src/casper.js`

- [ ] **Step 1: Add the function**

`account-address` outputs a plain string, not JSON — use a separate helper instead of `run()`.

Add at the end of `backend/src/casper.js`:

```javascript
// Returns "account-hash-<64hexchars>" for a given hex public key.
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
```

- [ ] **Step 2: Smoke-test in WSL**

With the backend server stopped, run directly in WSL:
```bash
node -e "
import('./src/casper.js').then(async m => {
  const h = await m.accountAddress('0171c6bddaec3e35df7fe9d8bbaa43ee35cb48060c9fc24f0e20c28a9f7d83db65');
  console.log(h);
});
"
```

Expected: prints `account-hash-<64 hex chars>`. If it prints an error, fix before continuing.

- [ ] **Step 3: Commit**

```bash
git add backend/src/casper.js
git commit -m "feat: add accountAddress() helper to casper.js"
```

---

## Task 3: Add `makeCheckAndExecuteDeploy()` and `submitSignedDeploy()` to casper.js

**Files:**
- Modify: `backend/src/casper.js`

- [ ] **Step 1: Add imports at top of casper.js**

Add after the existing imports:
```javascript
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
```

- [ ] **Step 2: Add `makeCheckAndExecuteDeploy()`**

Add after `accountAddress()`:

```javascript
// Produces an unsigned deploy JSON for check_and_execute, signed by the given public key.
// The deploy is written to a temp file and returned as a parsed object.
// VERIFY (Task 1): replace '--account' with the confirmed flag name if different.
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
        '--account', signingPublicKey,  // VERIFY: flag confirmed in Task 1
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
```

- [ ] **Step 3: Add `submitSignedDeploy()`**

Add after `makeCheckAndExecuteDeploy()`:

```javascript
// Submits a pre-signed deploy JSON (from CasperWalletProvider.sign()) to the network.
// Returns the deploy hash string.
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
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/casper.js
git commit -m "feat: add makeCheckAndExecuteDeploy() and submitSignedDeploy() to casper.js"
```

---

## Task 4: Add `POST /api/agents` registration endpoint

**Files:**
- Modify: `backend/src/server.js`

- [ ] **Step 1: Add endpoint after `/api/revoke`**

Add in `backend/src/server.js`:

```javascript
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
    const alreadyRegistered = !result.allowed && result.exec?.errorCode === 1;
    if (result.allowed || alreadyRegistered) {
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
    if (alreadyRegistered) result = { ...result, allowed: true };
    const agent = store.getAgent(agentAccountHash);
    res.json({ ...agent, agentAccountHash, allowed: result.allowed });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
```

- [ ] **Step 2: Test the endpoint from WSL**

With the server running (`setsid nohup node src/server.js &`), run:
```bash
curl -s -X POST http://localhost:3001/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"publicKey":"0171c6bddaec3e35df7fe9d8bbaa43ee35cb48060c9fc24f0e20c28a9f7d83db65","spendingCapCspr":10}' | jq .
```

Expected: `{ agentAccountHash: "account-hash-...", spendingCapCspr: 10, isActive: true, allowed: true, ... }`.

If the public key is already registered, `allowed` should still be `true` (AlreadyRegistered treated as idempotent).

- [ ] **Step 3: Commit**

```bash
git add backend/src/server.js
git commit -m "feat: add POST /api/agents registration endpoint"
```

---

## Task 5: Add `GET /api/agents/:hash` and `POST /api/agents/:hash/prepare-action`

**Files:**
- Modify: `backend/src/server.js`

- [ ] **Step 1: Add both endpoints after `POST /api/agents`**

```javascript
app.get('/api/agents/:hash', (req, res) => {
  const agent = store.getAgent(req.params.hash);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ ...agent, agentAccountHash: req.params.hash });
});

app.post('/api/agents/:hash/prepare-action', async (req, res) => {
  try {
    const agent = store.getAgent(req.params.hash);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!agent.publicKey) return res.status(400).json({ error: 'Agent has no associated public key (legacy agent)' });
    const amountMotes = csprToMotes(Number(req.body.amountCspr));
    const recipient = resolveRecipient(req.body.recipient);
    const deployJson = await casper.makeCheckAndExecuteDeploy(amountMotes, recipient, agent.publicKey);
    res.json({ deployJson, signingPublicKey: agent.publicKey });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
```

- [ ] **Step 2: Test GET endpoint**

```bash
# Replace <hash> with an account-hash from Task 4's curl
curl -s http://localhost:3001/api/agents/<hash> | jq .
```

Expected: the agent fields with `agentAccountHash` at top level.

- [ ] **Step 3: Test prepare-action endpoint**

```bash
curl -s -X POST http://localhost:3001/api/agents/<hash>/prepare-action \
  -H 'Content-Type: application/json' \
  -d '{"amountCspr":5,"recipient":"owner"}' | jq '.deployJson | keys'
```

Expected: JSON object with deploy fields (e.g. `["deploy"]` or similar). If `make-deploy` fails here, revisit Task 1's flag verification — this is where the unknown flag shows up.

- [ ] **Step 4: Commit**

```bash
git add backend/src/server.js
git commit -m "feat: add GET /api/agents/:hash and prepare-action endpoints"
```

---

## Task 6: Add `POST /api/agents/:hash/submit`

**Files:**
- Modify: `backend/src/server.js`

- [ ] **Step 1: Add submit endpoint**

```javascript
app.post('/api/agents/:hash/submit', async (req, res) => {
  try {
    const { signedDeployJson, amountCspr, recipient } = req.body;
    if (!signedDeployJson) return res.status(400).json({ error: 'signedDeployJson required' });
    const amountMotes = csprToMotes(Number(amountCspr));
    const recipientKey = resolveRecipient(recipient);
    const result = await runAction({
      type: 'transfer',
      submit: () => casper.submitSignedDeploy(signedDeployJson),
      amountMotes,
      recipient: recipientKey,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
```

- [ ] **Step 2: Verify shape**

This endpoint cannot be fully tested without a wallet-signed deploy. Verify the endpoint starts without error and returns 400 on missing body:

```bash
curl -s -X POST http://localhost:3001/api/agents/<hash>/submit \
  -H 'Content-Type: application/json' \
  -d '{}' | jq .
```

Expected: `{ "error": "signedDeployJson required" }`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/server.js
git commit -m "feat: add POST /api/agents/:hash/submit endpoint"
```

---

## Task 7: Frontend — wallet connect button and provider setup

**Files:**
- Modify: `backend/public/dashboard.html`

- [ ] **Step 1: Add connect button to header**

In `dashboard.html`, find the `<div class="header-end">` block and add the connect button before `.back-btn`:

```html
<div class="header-end">
  <button class="back-btn" id="connectBtn" style="background:var(--primary);color:#fff;border-color:var(--ink);">
    Connect Wallet
  </button>
  <a class="back-btn" href="/">← <span class="btn-label">Home</span></a>
  <button class="tour-btn" id="tourTrigger">
    <!-- existing SVG + span -->
  </button>
</div>
```

- [ ] **Step 2: Add wallet state variables and provider helpers**

In the `<script>` block, add after `let CFG = {};`:

```javascript
let currentPublicKey = null;
let currentAgentHash = null;

function getProvider() {
  return window.CasperWalletProvider?.();
}

function updateWalletUI() {
  const btn = $('connectBtn');
  if (currentAgentHash) {
    btn.textContent = short(currentAgentHash, 8) + ' ✓';
    btn.style.background = 'var(--ok)';
    btn.onclick = disconnectWallet;
  } else {
    btn.textContent = 'Connect Wallet';
    btn.style.background = 'var(--primary)';
    btn.onclick = connectWallet;
  }
  document.querySelectorAll('button[data-act="action"]').forEach(b => {
    b.disabled = !currentAgentHash;
    b.title = currentAgentHash ? '' : 'Connect your Casper Wallet to use this';
  });
}

async function connectWallet() {
  const provider = getProvider();
  if (!provider) {
    setStatus('Casper Wallet extension not installed — <a href="https://www.casperwallet.io" target="_blank" style="color:inherit">get it here</a>.', true);
    return;
  }
  try {
    setStatus('Waiting for wallet…');
    await provider.requestConnection();
    const publicKey = await provider.getActivePublicKey();
    const cap = +($('capIn').value || 10);
    setStatus('Registering agent on-chain (~15–40s)…');
    const agent = await api('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey, spendingCapCspr: cap }),
    });
    currentPublicKey = publicKey;
    currentAgentHash = agent.agentAccountHash;
    localStorage.setItem('al_wallet', JSON.stringify({ publicKey, agentAccountHash: agent.agentAccountHash }));
    setStatus('Agent registered ✓', false, true);
    updateWalletUI();
    await refresh();
  } catch (e) {
    setStatus('Wallet error: ' + e.message, true);
  }
}

function disconnectWallet() {
  currentPublicKey = null;
  currentAgentHash = null;
  localStorage.removeItem('al_wallet');
  updateWalletUI();
  refresh();
}
```

- [ ] **Step 3: Restore session on page load**

Add after the existing `let CFG = {};` line, before `loadConfig`:

```javascript
(function restoreSession() {
  try {
    const saved = JSON.parse(localStorage.getItem('al_wallet') || 'null');
    if (saved?.publicKey && saved?.agentAccountHash) {
      currentPublicKey = saved.publicKey;
      currentAgentHash = saved.agentAccountHash;
    }
  } catch {}
})();
```

- [ ] **Step 4: Call `updateWalletUI()` after `loadConfig`**

Find the bottom of the `<script>`:
```javascript
loadConfig().then(refresh);
```
Replace with:
```javascript
loadConfig().then(() => { updateWalletUI(); refresh(); });
```

- [ ] **Step 5: Verify in browser**

Open `http://localhost:3001/dashboard.html`. Confirm:
- "Connect Wallet" button appears in the header
- Clicking it with no extension installed shows the error message in the status area
- Page loads without JS errors in console

- [ ] **Step 6: Commit**

```bash
git add backend/public/dashboard.html
git commit -m "feat: add wallet connect button and session restore to dashboard"
```

---

## Task 8: Frontend — identity panel loads connected agent

**Files:**
- Modify: `backend/public/dashboard.html`

- [ ] **Step 1: Update `refresh()` to use connected agent**

Replace the existing `refresh()` function with:

```javascript
let _lastLogKey = null;

async function refresh() {
  const agentHash = currentAgentHash || CFG.agentAccountHash;

  // Load agent status — use new endpoint when a hash is known
  let agent = null;
  try {
    if (agentHash) {
      agent = await api(`/api/agents/${agentHash}`);
    }
  } catch { agent = null; }

  // Load log
  const log = await api('/api/log').catch(() => []);

  // Update identity panel
  $('agentHash').textContent = agentHash ? short(agentHash, 12) : '—';
  $('ownerHash').textContent = agent?.owner ? short(agent.owner, 12) : short(CFG.ownerAccountHash, 12);

  const badge = $('agentStatus');
  if (!agent) {
    badge.className = 'badge none';
    badge.innerHTML = '<span class="bdot"></span>not registered';
  } else if (agent.isActive) {
    badge.className = 'badge active';
    badge.innerHTML = '<span class="bdot"></span>active';
  } else {
    badge.className = 'badge revoked';
    badge.innerHTML = '<span class="bdot"></span>revoked';
  }
  $('createdAt').textContent = agent?.createdAt ? new Date(agent.createdAt).toLocaleString() : '—';
  const capEl = $('cap');
  capEl.innerHTML = agent
    ? `${agent.spendingCapCspr}<span class="cap-unit">CSPR</span>`
    : `—<span class="cap-unit">CSPR</span>`;
  $('allowed').textContent = agent?.allowedAction || '—';

  // Update log (unchanged logic)
  const el = $('log');
  const logKey = log.map(e => e.deployHash + e.status).join('|');
  if (logKey === _lastLogKey) return;
  _lastLogKey = logKey;

  if (!log.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">◎</div><div class="empty-title">No actions yet</div><div class="empty-body">Connect your Casper Wallet, register an agent, and attempt a transfer. Every action produces a real deploy hash verifiable on the Casper explorer.</div></div>`;
    return;
  }
  el.innerHTML = log.map(e => {
    const cls  = e.status === 'success' ? 'ok' : e.status === 'failure' ? 'blocked' : 'pending';
    const pill = e.status === 'success' ? 'Allowed' : e.status === 'failure' ? 'Blocked' : 'Pending';
    const verb = e.type === 'transfer' ? 'Transfer' : e.type[0].toUpperCase() + e.type.slice(1);
    const amt  = e.amountCspr != null ? ` ${e.amountCspr} CSPR` : '';
    const err  = e.errorName ? ` · ${e.errorName}` : '';
    return `<div class="entry ${cls}">
      <div class="etop"><span class="epill">${pill}</span><span class="etitle">${verb}${amt} — ${e.message}</span></div>
      <div class="emeta">${new Date(e.ts).toLocaleTimeString()}${err}</div>
      <div class="ehash mono"><a href="${explorerUrl(e.deployHash)}" target="_blank">${short(e.deployHash, 14)} ↗</a></div>
    </div>`;
  }).join('');
}
```

- [ ] **Step 2: Verify identity panel**

With a wallet connected (or a restored session with a known agent hash), open the dashboard. The identity panel should show the connected wallet's agent hash and status. With no wallet, it falls back to the default `CFG.agentAccountHash`.

- [ ] **Step 3: Commit**

```bash
git add backend/public/dashboard.html
git commit -m "feat: update refresh() to load connected agent identity"
```

---

## Task 9: Frontend — wallet-signed agent action flow

**Files:**
- Modify: `backend/public/dashboard.html`

- [ ] **Step 1: Add `actWalletAction()` function**

Add this function to the `<script>` block, after `disconnectWallet()`:

```javascript
async function actWalletAction() {
  const provider = getProvider();
  if (!provider) {
    setStatus('Casper Wallet extension not installed.', true);
    return;
  }
  try {
    busy(true);
    const amountCspr = +($('amtIn').value);
    const recipient = $('rcptIn').value;

    setStatus('Preparing deploy…');
    const { deployJson, signingPublicKey } = await api(
      `/api/agents/${currentAgentHash}/prepare-action`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amountCspr, recipient }) }
    );

    setStatus('Waiting for wallet signature…');
    const signedStr = await provider.sign(JSON.stringify(deployJson), signingPublicKey);
    const signedDeployJson = JSON.parse(signedStr);

    setStatus('Waiting for on-chain execution (~15–40s)…');
    const res = await api(
      `/api/agents/${currentAgentHash}/submit`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signedDeployJson, amountCspr, recipient }) }
    );

    const successMsg = res?.allowed
      ? `Transfer allowed ✓ — ${amountCspr} CSPR moved on-chain`
      : `Transfer blocked ✗ — ${res?.exec?.errorName || 'enforcement triggered'} (0 CSPR moved)`;
    setStatus(successMsg, false, true);
    await refresh();
  } catch (e) {
    const msg = e.message || String(e);
    setStatus(msg.includes('cancel') || msg.includes('reject') ? 'Signing cancelled.' : 'Error: ' + msg, true);
  } finally {
    busy(false);
  }
}
```

- [ ] **Step 2: Update `act()` to route action through wallet flow**

Find the existing `act()` function and update the `action` branch:

```javascript
async function act(name) {
  if (name === 'prompt') return runPrompt();
  if (name === 'action' && currentAgentHash) return actWalletAction();
  // existing flow for register/deposit/revoke and fallback action
  let errored = false;
  try {
    busy(true);
    setStatus('Submitting to Casper testnet…');
    let path, body;
    if      (name === 'register') { path = '/api/register'; body = { spendingCapCspr: +$('capIn').value }; }
    else if (name === 'deposit')  { path = '/api/deposit';  body = { amountCspr: +$('depIn').value }; }
    else if (name === 'revoke')   { path = '/api/revoke';   body = {}; }
    else if (name === 'action')   { path = '/api/action';   body = { amountCspr: +$('amtIn').value, recipient: $('rcptIn').value }; }
    setStatus('Waiting for on-chain execution (~15–40s)…');
    const res = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const successMsg = {
      register: `Agent registered on-chain ✓ — spending cap set, rules enforced`,
      deposit:  `Contract funded ✓ — ${$('depIn').value} CSPR deposited to contract purse`,
      revoke:   `Agent revoked on-chain ✓ — all future actions will be blocked`,
      action:   res?.allowed
        ? `Transfer allowed ✓ — ${$('amtIn').value} CSPR moved on-chain`
        : `Transfer blocked ✗ — ${res?.exec?.errorName || 'enforcement triggered'} (0 CSPR moved)`,
    }[name] || 'Done ✓';
    setStatus(successMsg, false, true);
    await refresh();
  } catch(e) {
    errored = true;
    setStatus('Error: ' + e.message, true);
  } finally {
    busy(false);
  }
}
```

- [ ] **Step 3: End-to-end manual test**

With Casper Wallet installed and the backend running:
1. Open dashboard, click "Connect Wallet", approve in extension
2. Verify identity panel shows your agent hash
3. Enter amount ≤ spending cap, click "Attempt transfer"
4. Approve signing in Casper Wallet extension
5. Wait ~15–40s, verify "Transfer allowed ✓" and log entry appears with a real deploy hash
6. Enter amount > spending cap, attempt transfer, verify "Transfer blocked ✗ — ExceedsCap"
7. Click deploy hash link — confirm it resolves on `testnet.cspr.live`

- [ ] **Step 4: Commit**

```bash
git add backend/public/dashboard.html
git commit -m "feat: wallet-signed agent action flow (prepare → sign → submit)"
```

---

## Task 10: Frontend — disabled state and not-installed guard

**Files:**
- Modify: `backend/public/dashboard.html`

- [ ] **Step 1: Add not-registered message to identity panel**

Find `<div class="sec" id="secIdentity">` and add a conditional message below the data rows:

```html
<div id="walletPrompt" class="sec" style="border-top:var(--bw) solid var(--ink);padding:14px 18px;font-size:12.5px;color:var(--muted);display:none;">
  Connect your Casper Wallet to create your own agent — spending cap enforced on-chain.
</div>
```

- [ ] **Step 2: Show/hide the prompt in `updateWalletUI()`**

Add to `updateWalletUI()`:

```javascript
const prompt = $('walletPrompt');
if (prompt) prompt.style.display = currentAgentHash ? 'none' : 'block';
```

- [ ] **Step 3: Verify disabled state**

Load dashboard with no wallet session (clear localStorage or open incognito):
- "Connect Wallet" button is visible (orange)
- "Attempt transfer" button is disabled (greyed, tooltip says "Connect your Casper Wallet to use this")
- Identity panel shows wallet prompt message

With wallet connected:
- Button shows truncated agent hash in green
- "Attempt transfer" is enabled
- Wallet prompt is hidden

- [ ] **Step 4: Commit**

```bash
git add backend/public/dashboard.html
git commit -m "feat: disabled state and wallet-not-installed guard on dashboard"
```

---

## Self-Review Notes

**Spec coverage check:**
- ✅ Wallet connect button (Task 7)
- ✅ `accountAddress()` (Task 2)
- ✅ `makeCheckAndExecuteDeploy()` + `submitSignedDeploy()` (Task 3)
- ✅ `POST /api/agents` (Task 4)
- ✅ `POST /api/agents/:hash/prepare-action` (Task 5)
- ✅ `GET /api/agents/:hash` (Task 5)
- ✅ `POST /api/agents/:hash/submit` (Task 6)
- ✅ Identity panel loads connected agent (Task 8)
- ✅ Prepare → sign → submit flow (Task 9)
- ✅ Disabled/not-installed state (Task 10)
- ✅ AlreadyRegistered idempotent (Task 4)
- ✅ Session restore via localStorage (Task 7)
- ✅ Casper Wallet not installed guard (Tasks 7 + 10)
- ✅ Spec known unknowns flagged with VERIFY comments in Tasks 1 + 3

**Type consistency:**
- `makeCheckAndExecuteDeploy(amountMotes, recipientKey, signingPublicKey)` — used identically in Tasks 3 and 5
- `submitSignedDeploy(signedDeployJson)` — used identically in Tasks 3 and 6
- `accountAddress(publicKeyHex)` — used identically in Tasks 2 and 4
- Agent shape `{ agentAccountHash, owner, publicKey, spendingCapCspr, isActive, ... }` — consistent across Tasks 4, 5, 8
