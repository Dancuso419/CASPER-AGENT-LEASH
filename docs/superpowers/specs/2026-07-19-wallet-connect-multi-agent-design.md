# Wallet-Connect Multi-Agent Design

**Date:** 2026-07-19  
**Status:** Approved  
**Scope:** Allow any user to create and control their own agent on the Casper Agent Leash dashboard by connecting their Casper Wallet browser extension.

---

## Problem

The current dashboard is single-tenant: one hardcoded owner key and one hardcoded agent key in server config. Users visiting the live deployment can trigger actions but cannot create or own their own agent. For the Casper Agentic Buildathon final round, judges and visitors should be able to create a real on-chain agent with verifiable ownership.

---

## Chosen Approach

**Approach A: Backend prepares unsigned deploy → Casper Wallet signs → backend submits.**

- All deploy construction stays in the proven `casper-client` path (exact args validated on testnet per DEPLOYMENT.md).
- Only signing moves to the browser via `window.CasperWalletProvider`.
- Owner ops (register, revoke, deposit) remain fully server-side, signed with the owner key.

Rejected: casper-js-sdk in the browser (Approach B) — too much new surface area, deploy format must exactly match what works on testnet.

---

## Architecture

### Three flows

**1. Identity — wallet connect + registration**
```
User clicks "Connect Wallet"
  → CasperWalletProvider.requestConnection()
  → provider.getActivePublicKey() → publicKeyHex
  → POST /api/agents { publicKey, spendingCapCspr }
      → casper-client account-address --public-key <hex> → accountHash
      → registerAgent(accountHash, capMotes)   [owner key, server-side]
      → store.upsertAgent(accountHash, { ... })
      → return { agentAccountHash, publicKey, spendingCapCspr, ... }
  → dashboard loads identity panel for this agent
  → localStorage stores { publicKey, agentAccountHash }
```

**2. Agent action — prepare / sign / submit**
```
User clicks "Attempt transfer"
  → POST /api/agents/:hash/prepare-action { amountCspr, recipient }
      → casper-client make-deploy (no --secret-key) → unsigned deploy JSON
      → return { deployJson, signingPublicKey }
  → provider.sign(deployJson, signingPublicKey) → signedDeployJson
  → POST /api/agents/:hash/submit { signedDeployJson, amountCspr, recipient }
      → casper-client send-deploy → deployHash
      → pollDeploy(deployHash)
      → store.addLog(...)
      → return { allowed, deployHash, explorer, exec, row }
```

**3. Owner ops — unchanged**
```
POST /api/deposit  → owner key, server-side (funds contract purse)
POST /api/revoke   → owner key, server-side (accepts agentAccountHash param)
```

---

## Backend Changes

### `backend/src/casper.js`

Add three functions:

**`accountAddress(publicKeyHex)`**
- Runs: `casper-client account-address --public-key <hex>`
- Returns: `"account-hash-<64hexchars>"`
- Used by: `POST /api/agents` to derive account hash from wallet public key

**`makeCheckAndExecuteDeploy(amountMotes, recipientKey, signingPublicKey)`**
- Runs: `casper-client make-deploy` with all proven session args (amount, recipient, package hash, entry point, payment amount) but WITHOUT `--secret-key`
- Exact flags for unsigned deploy production: VERIFY against `casper-client make-deploy --help` in WSL before implementation — do not guess
- Writes output JSON to a temp file, returns parsed JSON

**`submitSignedDeploy(signedDeployJson)`**
- Writes signed deploy JSON to a temp file
- Runs: `casper-client send-deploy --node-address <node> --input <file>`
- Returns: deploy hash string

### `backend/src/server.js`

Add three endpoints:

**`POST /api/agents`**
```
body: { publicKey: string, spendingCapCspr: number }
- derive accountHash via accountAddress(publicKey)
- call registerAgent(accountHash, csprToMotes(spendingCapCspr))
- treat error code 1 (AlreadyRegistered) as idempotent success
- upsertAgent(accountHash, { owner, spendingCapCspr, publicKey, isActive: true, ... })
- return { agentAccountHash, publicKey, spendingCapCspr, isActive, registerDeploy }
```

**`POST /api/agents/:hash/prepare-action`**
```
body: { amountCspr: number, recipient: string }
- resolve recipient via resolveRecipient()
- call makeCheckAndExecuteDeploy(amountMotes, recipient, agent.publicKey)
- return { deployJson, signingPublicKey: agent.publicKey }
```

**`POST /api/agents/:hash/submit`**
```
body: { signedDeployJson: object, amountCspr: number, recipient: string }
- call submitSignedDeploy(signedDeployJson) → deployHash
- pollDeploy(deployHash)
- store.addLog({ type: 'transfer', amountCspr, recipient, deployHash, ... })
- return { allowed, deployHash, explorer, exec, row }
```

**`GET /api/agents/:hash`** (new, minimal)
```
- return store.getAgent(hash) or 404
```

Existing endpoints (`/api/register`, `/api/action`, `/api/status`) stay untouched — they back the hardcoded single-agent demo path and keep existing deploys verifiable.

---

## Frontend Changes (`backend/public/dashboard.html`)

### Wallet connect UI

Add to `.header-end` (before the Tour button):
- "Connect Wallet" button when disconnected
- Connected state: shows truncated account hash + "Disconnect" option

### Connection logic

```js
const provider = window.CasperWalletProvider?.();

async function connectWallet() {
  await provider.requestConnection();
  const publicKey = await provider.getActivePublicKey();
  const agent = await api('/api/agents', {
    method: 'POST',
    body: JSON.stringify({ publicKey, spendingCapCspr: +(capIn.value || 10) })
  });
  localStorage.setItem('al_wallet', JSON.stringify({ publicKey, agentAccountHash: agent.agentAccountHash }));
  currentAgent = agent;
  refresh();
}
```

On page load: if `localStorage` has `al_wallet`, restore and refresh identity panel without re-registering.

### Identity panel

`loadConfig` and `refresh` use `currentAgent.agentAccountHash` when a wallet is connected, falling back to `CFG.agentAccountHash` for the default demo agent.

### Agent action flow

Replace the current direct `POST /api/action` with:
```js
async function act_action() {
  const { deployJson, signingPublicKey } = await api(
    `/api/agents/${currentAgent.agentAccountHash}/prepare-action`,
    { method: 'POST', body: JSON.stringify({ amountCspr, recipient }) }
  );
  const signedDeployJson = await provider.sign(JSON.stringify(deployJson), signingPublicKey);
  const result = await api(
    `/api/agents/${currentAgent.agentAccountHash}/submit`,
    { method: 'POST', body: JSON.stringify({ signedDeployJson: JSON.parse(signedDeployJson), amountCspr, recipient }) }
  );
  // existing result handling unchanged
}
```

### Disabled state

If no wallet connected and no default agent: action buttons are disabled, identity panel shows "Connect your Casper Wallet to create an agent."

---

## Data Flow — Multi-Agent

`store.js` already stores agents as a map keyed by account hash. No changes needed. Each connected user loads their agent by hash. The activity log shows all agents' actions (global log) — simple for demo, sufficient for judges.

---

## Error Handling

| Scenario | Handling |
|---|---|
| Casper Wallet not installed | Catch `window.CasperWalletProvider` undefined → show "Install Casper Wallet" link |
| User rejects wallet connection | Catch provider error → show inline message |
| User rejects signing | Catch provider error → clear status, re-enable buttons |
| AlreadyRegistered (error code 1) | Treat as success — agent is registered, just load their state |
| `make-deploy` flag unknown | VERIFY before implementation — see note in casper.js section |

---

## Known Unknowns — Must Verify Before Implementation

1. **`casper-client make-deploy` unsigned deploy flags** — the exact flag to produce an unsigned deploy JSON (without `--secret-key`) is not confirmed. Run `casper-client make-deploy --help` in WSL and confirm the output format matches what `casper-client send-deploy --input` expects.

2. **`casper-client send-deploy` input format** — confirm it accepts a signed deploy JSON file produced by `CasperWalletProvider.sign()`. The wallet returns a JSON string; confirm the schema matches what `send-deploy` expects.

3. **`casper-client account-address` output format** — confirm it returns `account-hash-<hex>` (the format the contract expects for the `agent:key` session arg).

4. **`CasperWalletProvider.sign()` return format** — the wallet returns a JSON string. Confirm whether it wraps the deploy in a `{ deploy: { ... } }` envelope or returns the deploy directly.

---

## What Does NOT Change

- `config.js` — owner/agent keys, package hash, node address
- `store.js` — no schema changes
- `casper.js` — existing `registerAgent`, `revokeAgent`, `deposit`, `pollDeploy` functions
- `server.js` — existing `/api/register`, `/api/deposit`, `/api/revoke`, `/api/action`, `/api/status` endpoints
- Dashboard tour, log rendering, Gemini prompt section
- Deployment infrastructure (Render, env vars)
