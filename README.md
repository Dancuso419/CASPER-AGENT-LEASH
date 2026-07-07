# Leash — On-Chain Permission Enforcement for AI Agents

> **Give your AI agent a wallet. Give yourself a leash.**

Live demo: **[casper-agent-leash.onrender.com](https://casper-agent-leash.onrender.com)**
Contract on Casper Testnet: [`a7d018fc…acd660`](https://testnet.cspr.live/contract-package/a7d018fcc02bec1a44d1060c6ea77be8869919a91ab4e8f5daf66ecf86acd660)

---

## What is this?

AI agents are increasingly being given access to money — wallets, tokens, the ability to send funds on their own. That's powerful, but it's also a problem: once you hand an AI agent a private key, there's nothing stopping it from spending all your money, making transactions you didn't intend, or acting in ways you can't predict.

**Leash solves this.** It's an on-chain smart contract on the Casper blockchain that acts as a permission boundary for AI agents. Before an agent can move a single token, the contract checks:

1. Is this agent registered?
2. Is the amount within the owner's set spending cap?
3. Is the agent still active (not revoked)?

If any check fails, the transaction is **rejected by the blockchain itself** — not by a server, not by software that could be hacked or bypassed, but by immutable code running on a decentralised network. The enforcement cannot be overridden.

---

## See it in action (no setup needed)

Visit the live dashboard at **[casper-agent-leash.onrender.com/dashboard.html](https://casper-agent-leash.onrender.com/dashboard.html)**.

The dashboard connects to a real smart contract already deployed on the Casper testnet. You can watch the agent's identity, spending rules, and a live log of every allowed and blocked action — each backed by a real blockchain transaction you can verify.

Hit **"Take Tour"** in the top right for a guided walkthrough of every panel.

---

## The proof (non-technical version)

Here is what actually happened on the Casper blockchain during development — every row below is a real transaction, permanently recorded, that anyone can verify:

| What happened | Was it allowed? | Why |
|---|---|---|
| Owner installs the contract | ✅ Yes | Setup |
| Owner registers the AI agent with a **10 CSPR spending cap** | ✅ Yes | Rules stored on-chain |
| Owner deposits 100 CSPR into the contract | ✅ Yes | Funds loaded |
| Agent attempts to send **5 CSPR** (under the cap) | ✅ **Allowed** — funds moved | Within the leash |
| Agent attempts to send **50 CSPR** (over the cap) | ❌ **Blocked** — zero funds moved | Contract rejected it |
| Owner revokes the agent | ✅ Yes | Agent deactivated |
| Agent attempts to send 5 CSPR again | ❌ **Blocked** | Revocation enforced |

The critical point: rows 4 and 5 use the **exact same agent, exact same contract, exact same code path**. Only the amount differs. The blockchain blocked the over-cap attempt automatically — no human intervention, no server-side check, no way to bypass it.

---

## The proof (technical version)

All 7 deploy hashes are verifiable at `https://testnet.cspr.live/deploy/<hash>`:

| # | Action | Deploy hash | Result |
|---|--------|-------------|--------|
| 1 | Install contract | `c77f7080…dca79df` | ✅ Success |
| 2 | `register_agent` (cap 10 CSPR) | `af5f91ee…bc0408` | ✅ Success |
| 3 | `deposit` 100 CSPR (proxy_caller) | `120cbb4a…ea2d78` | ✅ Success |
| 4 | `check_and_execute` 5 CSPR | `41bdcf35…0f99` | ✅ **Success** — funds moved |
| 5 | `check_and_execute` 50 CSPR | `f749daae…deb9d` | ❌ **User error: 5** (ExceedsCap) |
| 6 | `revoke_agent` | `53c48a21…3491` | ✅ Success |
| 7 | `check_and_execute` 5 CSPR (post-revoke) | `fe6fb4b0…34c61` | ❌ **User error: 4** (Revoked) |

Contract package hash: `a7d018fcc02bec1a44d1060c6ea77be8869919a91ab4e8f5daf66ecf86acd660`
Full deployment notes: [`DEPLOYMENT.md`](./DEPLOYMENT.md)

---

## How it works (architecture)

```
You (browser dashboard)
        │
        │  HTTP
        ▼
Backend  (Node.js / Express)
        │                    │
        │                    ▼
        │             Gemini AI  ←── "send 5 CSPR to owner"
        │             (figures out what action to take)
        │
        ▼
casper-client  (Rust binary)
        │
        ▼
Casper Testnet blockchain
        │
        ▼
AgentLeash smart contract  ←── enforces the spending cap & active flag
```

**Key design decision:** the backend never decides whether a transaction is allowed. It just submits the request. The smart contract makes the enforcement decision and either executes the transfer or reverts the entire transaction. The backend reads the outcome from the deploy execution result and shows it on the dashboard.

This means:
- The AI (Gemini) decides *what to attempt*
- The blockchain decides *what is permitted*
- Those two roles are cleanly separated and cannot be confused

---

## The smart contract

Written in **Rust** using the [Odra framework](https://odra.dev) (v2.8.2). Source: `contracts/agent_leash/src/agent_leash.rs`.

### Entry points

| Function | Who can call it | What it does |
|---|---|---|
| `register_agent(agent, spending_cap, allowed_action)` | Owner only | Stores the agent's identity and permission rules on-chain |
| `check_and_execute(amount, recipient)` | The agent | Checks the rules, then either transfers funds or reverts |
| `revoke_agent(agent)` | Owner only | Marks the agent as inactive — all future actions blocked |
| `deposit()` | Owner only | Funds the contract's purse so it has CSPR to send |
| `get_agent_status(agent)` | Anyone | Read-only view of an agent's current rules and status |

### Error codes

When the contract blocks an action, it reverts with a specific error code visible in the deploy result:

| Code | Name | Meaning |
|---|---|---|
| 1 | `AlreadyRegistered` | Agent was already registered |
| 2 | `NotOwner` | Caller is not the contract owner |
| 3 | `AgentNotFound` | No agent with that address registered |
| 4 | `Revoked` | Agent has been revoked by the owner |
| 5 | `ExceedsCap` | Transfer amount is above the spending cap |
| 6 | `ActionNotAllowed` | Action type not in the agent's permission list |

---

## Repository layout

```
/contracts/agent_leash/     Rust smart contract (Odra 2.8.2)
  src/agent_leash.rs        Contract logic — 8 unit tests, all pass
  wasm/AgentLeash.wasm      Compiled contract (258 KB, optimised)

/backend/                   Node.js service
  src/server.js             Express API — register, deposit, action, revoke, prompt
  src/config.js             Env vars + key file handling (local + Render cloud)
  public/index.html         Landing page
  public/dashboard.html     Live dashboard
  Dockerfile                Multi-stage build (Rust for casper-client + Node runtime)

/docs/ (root level)
  Leash PRD.md              Product requirements document
  Casper TRD.md             Technical requirements document
  DEPLOYMENT.md             Every testnet deploy hash + raw casper-client commands used
  CONSTRAINTS.md            Known limitations and risk log
  CLAUDE.md                 Build notes and toolchain changelog (for AI coding agents)
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Smart contract | Rust · [Odra 2.8.2](https://odra.dev) · Casper Testnet |
| Contract deployment | casper-client 5.0.1 (legacy `put-deploy` format) |
| Backend | Node.js 20 · Express |
| AI reasoning | Google Gemini (`@google/genai` 2.10.0 · function-calling) |
| Frontend | Vanilla HTML/CSS/JS — no framework |
| Cloud hosting | [Render.com](https://render.com) — Docker, auto-deploy on push |

---

## Running it locally

> **Platform note:** The Casper/Odra Rust stack uses Unix-only system APIs. If you are on Windows, you must use **WSL2 (Ubuntu)**. The contract and backend both run inside WSL2; the dashboard is served from there and accessed in any browser.

### Prerequisites

```bash
# 1. Rust toolchain (inside WSL2)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# 2. Odra CLI
cargo install cargo-odra

# 3. casper-client
cargo install casper-client

# 4. Node.js 20+
# Use nvm or your distro's package manager
```

### Build and test the contract

```bash
cd contracts/agent_leash

# Fast tests against the mock VM (no blockchain needed)
cargo odra test

# Full tests against the real CasperVM semantics
cargo odra test -b casper

# Compile to WASM
cargo odra build
# → wasm/AgentLeash.wasm
```

All 8 tests pass on both backends.

### Run the backend + dashboard

```bash
cd backend
cp .env.example .env
# Edit .env — set your GEMINI_API_KEY at minimum
# Also set OWNER_KEY_CONTENT and AGENT_KEY_CONTENT (PEM file contents)
# or point OWNER_KEY / AGENT_KEY at your local key file paths

npm install
node src/server.js
# Dashboard at http://localhost:3001
```

The backend expects `casper-client` on PATH and key files for the owner and agent accounts. See `.env.example` for all options.

### Deploy your own contract instance

```bash
# From WSL2, inside contracts/agent_leash/
casper-client put-deploy \
  --node-address https://node.testnet.casper.network \
  --chain-name casper-test \
  --secret-key ~/casper-keys/owner/secret_key.pem \
  --session-path wasm/AgentLeash.wasm \
  --payment-amount 350000000000 \
  --session-arg "odra_cfg_is_upgradable:bool='true'" \
  --session-arg "odra_cfg_is_upgrade:bool='false'" \
  --session-arg "odra_cfg_allow_key_override:bool='true'" \
  --session-arg "odra_cfg_package_hash_key_name:string='AgentLeash'"
```

Get testnet CSPR from the [faucet](https://testnet.cspr.live/tools/faucet). Full deployment notes, including all working raw commands, are in [`DEPLOYMENT.md`](./DEPLOYMENT.md).

---

## Deploying to the cloud (Render)

The `backend/Dockerfile` does everything:

1. Stage 1 — compiles `casper-client` from source (Rust)
2. Stage 2 — installs Node dependencies and copies the binary

**Render environment variables to set:**

| Variable | Value |
|---|---|
| `OWNER_KEY_CONTENT` | Full contents of your owner `secret_key.pem` |
| `AGENT_KEY_CONTENT` | Full contents of your agent `secret_key.pem` |
| `PROXY_WASM` | `/app/proxy_caller.wasm` |
| `GEMINI_API_KEY` | Your Gemini API key |
| `PACKAGE_HASH` | Your deployed contract package hash (without `hash-` prefix) |
| `OWNER_ACCOUNT_HASH` | `account-hash-...` of the owner key |
| `AGENT_ACCOUNT_HASH` | `account-hash-...` of the agent key |

At startup, the backend writes the key file contents to `/tmp` so `casper-client` can read them. Keys are never written to disk in the repository.

---

## Known limitations

These are honest, documented scope boundaries — not bugs:

- **In-flight revocation** — if an agent submits a transaction and the owner revokes in the same block, the already-submitted transaction may still land. Revocation blocks the *next* action, not one already in flight. This is a known property of any blockchain system and is documented in the PRD.
- **Single action type** — the MVP enforces spending caps on token transfers. The `ActionType` enum is designed to be extended but only `transfer` is wired up.
- **Associated-key scoping** — Casper's native account-level key-weight system was designed as a second enforcement layer but is not yet wired up. The contract-level enforcement is the primary, fully working mechanism.
- **Testnet only** — all keys are throwaway testnet accounts. Do not use on mainnet without a security audit.

---

## Built for

**Casper Agentic Buildathon 2026**

Every on-chain claim in this README and dashboard is backed by a real testnet deploy hash. Nothing is simulated or mocked. See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the complete record.
