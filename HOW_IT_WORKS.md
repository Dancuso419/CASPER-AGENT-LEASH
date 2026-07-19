# Leash — What It Does & How It Functions


## The problem


AI agents are increasingly handed wallets and private keys so they can transact on
their own. But a private key is all-or-nothing: once an agent holds it, nothing stops
a buggy, jailbroken, or misaligned agent from draining the wallet or sending payments
you never authorized. There's no native "spending limit" for an autonomous agent.


## What Leash does


Leash is an **on-chain permission boundary** for AI agents on the Casper Network. An
owner registers an agent with a **per-transaction spending cap** and an **allowed action
type**, and funds a contract-controlled purse. From then on, the agent can only move
money by asking the contract — and the contract itself checks every request against the
rules before releasing a single mote. Break a rule and the blockchain **reverts the whole
transaction**: zero funds move, and a specific error code is recorded permanently.

Anyone can participate: connect the **Casper Wallet** browser extension and your wallet
becomes its own distinct on-chain agent with its own spending cap, independent of any
other user. Actions are signed by your own wallet — the contract sees your account as the
caller and enforces your cap.


## The core idea (the trust model)


The single most important design decision:


> **The backend never decides whether a payment is allowed. It only submits the attempt.
> The smart contract makes the decision and either executes or reverts.**


This cleanly separates two roles that are dangerous to conflate:


- **The AI (Gemini) decides what to *attempt*.**
- **The blockchain decides what is *permitted*.**


Even the agent's own signing key can't bypass it — the agent signs the request, but the
contract owns the funds and gates their release. Owner operations (register, change cap,
revoke, reactivate) are signed by a separate owner key, so an agent can never loosen its
own leash.


---


## Architecture


```
Browser dashboard  ──HTTP──▶  Node/Express backend
                                    │        │
                                    │        └──▶ Gemini (function-calling)
                                    │              "send 50 CSPR to owner" → tool call
                                    ▼
                             casper-client (Rust CLI)
                                    │  signs + submits a Deploy
                                    ▼
                             Casper Testnet  ──▶  AgentLeash contract
                                                   enforces cap + active flag,
                                                   moves funds from its own purse
                                                   or reverts with an error code
```

Four moving parts:

1. **Smart contract** (`contracts/agent_leash/src/agent_leash.rs`, Odra/Rust) — the
   enforcement engine. The only source of truth.
2. **Backend** (`backend/src/`, Node/Express) — submits deploys via `casper-client`,
   polls for the result, exposes a REST API.
3. **Gemini layer** (`backend/src/gemini.js`) — turns natural language into a structured
   tool call.
4. **Dashboard** (`backend/public/dashboard.html`) — identity, rules, controls, wallet
   connection, and a live allowed/blocked activity log.


---


## The smart contract (the heart of it)


**Data model** — one record per agent, stored in a `Mapping<Address, AgentRecord>`:

```
struct AgentRecord {
    owner: Address,              // who controls this agent
    spending_cap: U512,          // max motes per single action
    allowed_action: ActionType,  // TransferOnly (enum leaves room to widen)
    is_active: bool,             // false once revoked
    created_at: u64,
}
```

**Entry points:**

| Function | Signer | What it does |
|---|---|---|
| `register_agent(agent, spending_cap, allowed_action)` | Owner | Stores the rule; caller becomes owner. Reverts `AlreadyRegistered` if it exists. |
| `deposit()` *(payable)* | Owner | Funds the contract's own purse so it has CSPR to send. |
| `check_and_execute(amount, recipient)` | **Agent** | The enforced spend path (below). |
| `update_cap(agent, new_cap)` | Owner only | Changes an agent's spending cap without re-registering. Reverts `NotOwner` or `AgentNotFound`. |
| `revoke_agent(agent)` | Owner only | Sets `is_active = false`. Non-owner → `NotOwner`. |
| `reactivate_agent(agent)` | Owner only | Reverses a revoke — sets `is_active = true` so the agent can act again. |
| `get_agent_status(agent)` | Anyone | Read-only view of the on-chain record. |

Cap changes, revocation, and reactivation are **owner-only** by design: an agent (or the
AI holding its key) can never raise its own cap or un-revoke itself.

The contract has been **upgraded twice in place** (same package hash, all prior agent
state preserved) — v2 added `update_cap`, v3 added `reactivate_agent`. See
`DEPLOYMENT.md` for the upgrade deploy hashes.


**The enforcement logic** — `check_and_execute`, run in this exact order, identifying the
agent by `caller()`:

```
Look up the agent's record        → revert AgentNotFound (3) if unknown
if !is_active                     → revert Revoked (4)
match allowed_action              (TransferOnly guard)
if amount > spending_cap          → revert ExceedsCap (5)
transfer_tokens(recipient, amount) + emit ActionAllowed
```

The critical property: **a revert rolls back all state and events.** So a blocked action
moves nothing *and* emits nothing — there's no partial effect to clean up. The backend
detects the block purely from the deploy's execution result.


**Error codes** (stable; the backend maps them to human messages):

| Code | Name | Meaning |
|---|---|---|
| 1 | `AlreadyRegistered` | Agent was already registered |
| 2 | `NotOwner` | Caller is not the contract owner |
| 3 | `AgentNotFound` | No agent with that address registered |
| 4 | `Revoked` | Agent has been revoked by the owner |
| 5 | `ExceedsCap` | Transfer amount is above the spending cap |
| 6 | `ActionNotAllowed` | Action type not in the agent's permission list |

The contract has **15 unit tests** covering each path (compliant transfer moves funds,
over-cap reverts *and moves nothing*, revoked can't act, non-owner can't revoke,
`update_cap` enforced immediately, reactivated agent can act again, etc.), passing on
both the mock VM and the real CasperVM.


---


## How one action flows end-to-end


### Demo agent path (no wallet)

Take the flagship "blocked" case — agent tries to send 50 CSPR against a 10 CSPR cap:

1. **Dashboard** → user sets amount 50, clicks *Attempt transfer* → `POST /api/action`.
2. **Backend** (`runAction`) calls `casper.checkAndExecute(50e9 motes, recipient)`, which
   shells out to `casper-client put-deploy` with the entry point `check_and_execute`,
   signed by the **agent's** key (`--session-arg amount:u512`, `recipient:key`).
3. **casper-client** returns a `deploy_hash` immediately (submission ≠ execution).
4. **Backend polls** `get-deploy` every 4s (up to 30 tries) until the deploy executes.
5. **Contract** runs the checks → `50 > 10` → `revert(ExceedsCap)`. Nothing moves.
6. **Backend** parses the execution result: `error_message` contains `"User error: 5"` →
   maps to `status: failure`, `errorName: ExceedsCap`, logs a row.
7. **Dashboard** (polling `/api/status` + `/api/log` every 5s) renders a red
   **Blocked — ExceedsCap** entry with a clickable deploy hash → anyone can verify the
   revert on `testnet.cspr.live`.


### Wallet-connect path (bring your own wallet)

When a user connects their Casper Wallet, their transfers follow a different signing
flow so the contract sees *their* account as the caller and enforces *their* cap:

1. **Connect** — dashboard calls `CasperWalletProvider.requestConnection()` then
   `getActivePublicKey()`. Backend derives the account hash via
   `casper-client account-address` (`POST /api/derive-hash`) — no transaction, no
   auto-registration.
2. **Register** — user sets a spending cap and clicks *Register*. Backend calls
   `POST /api/agents`, which runs `register_agent` signed by the **owner key**
   (the platform controls who gets an agent slot).
3. **Prepare** — user sets amount and clicks *Attempt transfer*. Backend builds an
   **unsigned** deploy via `casper-client make-deploy --session-account <pubkey>` and
   returns the raw JSON (`POST /api/agents/:hash/prepare-action`).
4. **Sign** — dashboard calls `provider.sign({ deploy: deployJson }, publicKey)`.
   Casper Wallet returns `{ signatureHex, cancelled }` — a raw 64-byte signature,
   **not** a signed deploy.
5. **Attach + submit** — backend prepends the algorithm tag byte (ed25519 = `01`,
   secp256k1 = `02`) to make a full 65-byte Casper approval, attaches it to the deploy
   JSON (`attachApproval`), and submits via `casper-client send-deploy`
   (`POST /api/agents/:hash/submit`).
6. **Contract enforces** — same path as above; the deploy's session account is the
   user's wallet, so `caller()` returns their address and their cap is checked.

The **Gemini path** in wallet mode works identically: `POST /api/prompt` with
`publicKey` + `agentAccountHash` in the body → backend returns `{ needsSignature: true,
deployJson }` → dashboard calls `provider.sign()` → submits via `/api/agents/:hash/submit`.
This means Gemini transfers are enforced against the connected wallet's cap, not the demo
agent's.


**Signing model:**
- **Owner key** (server-held) signs: `register_agent`, `deposit`, `update_cap`,
  `revoke_agent`, `reactivate_agent`.
- **Agent key** (server-held, demo path) signs: `check_and_execute` in demo mode.
- **User's wallet** (browser, wallet-connect path) signs: `check_and_execute` when a
  wallet is connected. The server never sees the private key.

**Deposit** is special — it's payable, and raw `casper-client` can't attach value to an
Odra entry point directly, so the backend routes it through Odra's `proxy_caller.wasm`,
which creates and funds a purse and forwards it to `deposit()`. The contract purse is
shared across all agents; each agent's cap limits what they can withdraw per action.


---


## REST API (backend)


| Endpoint | Method | Purpose |
|---|---|---|
| `/api/config` | GET | Network, contract package hash, owner/agent hashes, `geminiEnabled` |
| `/api/status` | GET | Demo agent identity + rules (from display store) |
| `/api/log` | GET | Activity log (newest first) |
| `/api/deploy/:hash` | GET | Parsed execution result for any deploy hash |
| `/api/health` | GET | Diagnostics: binary/key/wasm presence, casper-client version |
| `/api/register` | POST | Owner registers the demo agent with a spending cap |
| `/api/deposit` | POST | Owner funds the contract purse |
| `/api/action` | POST | Demo agent attempts a transfer (enforced path, server-signed) |
| `/api/revoke` | POST | Owner revokes an agent (demo agent or connected wallet's agent) |
| `/api/reactivate` | POST | Owner reactivates a revoked agent |
| `/api/prompt` | POST | Natural language → Gemini → tool call → on-chain action |
| `/api/derive-hash` | POST | Derives account hash from a public key — no transaction |
| `/api/agents` | POST | Registers a wallet-connected user's public key as a new agent |
| `/api/agents/:hash` | GET | Returns the stored record for any agent hash |
| `/api/agents/:hash/cap` | POST | Owner changes an agent's spending cap on-chain |
| `/api/agents/:hash/prepare-action` | POST | Builds an unsigned deploy for wallet signing |
| `/api/agents/:hash/submit` | POST | Attaches wallet signature and submits the signed deploy |
| `/api/balance/:hash` | GET | Main-purse CSPR balance for any account hash |
| `/api/contract-balance` | GET | Balance of the shared contract purse |


---


## On-chain vs off-chain (the honest line)


- **On-chain (ground truth):** every rule, every enforcement decision, every fund
  movement. All demo deploy hashes are verifiable on testnet, and their execution
  results match exactly (compliant transfers succeed, over-cap → `User error: 5`,
  post-revoke → `User error: 4`).
- **Off-chain (convenience only):** a small JSON store (`/tmp/leash-data.json`) caches
  the dashboard's identity panel and activity log so the UI is snappy. It's *display
  state*, not authority — `get_agent_status` exists for true on-chain reads, and the
  store is explicitly marked as swappable for on-chain reads if multi-writer truth is
  ever needed.


---


## Tech stack


| Layer | Technology |
|---|---|
| Smart contract | Rust · Odra 2.8.2 · Casper Testnet · upgradeable (v3) |
| Contract deployment | casper-client 5.0.1 (legacy `put-deploy` format) |
| Wallet | Casper Wallet browser extension (`window.CasperWalletProvider`) |
| Backend | Node.js 20 · Express |
| AI reasoning | Google Gemini (`@google/genai` 2.10.0 · function-calling) |
| Frontend | Vanilla HTML/CSS/JS — no framework |
| Cloud hosting | Render.com — Docker, auto-deploy on push |


---


## Honest limitations


- **In-flight revocation** — revocation blocks the *next* action; a transaction already
  submitted in the same block may still land (true of any blockchain).
- **Single action type** — only `TransferOnly` is wired; the `ActionType` enum is built
  to widen.
- **Registration doesn't prove wallet ownership** — anyone can register a public key as
  an agent. This is harmless because *actions* still require the real wallet's signature,
  so a mis-registered key can never actually spend. Proving ownership at registration
  (via a signed message challenge) is a future hardening step.
- **Shared owner-funded pool** — the contract purse is funded by the platform owner, and
  every agent spends from it. Per-agent funding (each user deposits their own CSPR) is
  out of scope for the demo.
- **Testnet only** — throwaway keys; no mainnet without an audit.
