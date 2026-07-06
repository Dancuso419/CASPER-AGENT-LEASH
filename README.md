# Casper Agent Leash

**A verifiable, enforced, revocable on-chain leash for AI agents that hold money.**

AI agents are getting wallets. A private key can do *anything* it permits — there is no scoped,
verifiable boundary on an autonomous agent's authority. Agent Leash closes that gap: an owner
registers an agent on-chain with a **spending cap** and an **allowed action**, and a custom Casper
smart contract **enforces those limits at execution time**. A compliant action succeeds; a
non-compliant one is *reverted on-chain* — not by middleware that could be bypassed, but by the
contract itself.

> Built for the Casper Agentic Buildathon 2026. Live on Casper Testnet — every claim below is
> backed by a real, explorer-verifiable deploy hash (see [`DEPLOYMENT.md`](./DEPLOYMENT.md)).

---

## The demo in one screen

The dashboard drives a real agent through its lifecycle, each action a real testnet transaction:

| Action | Result | Why |
|--------|--------|-----|
| Owner registers agent (cap 10 CSPR) | ✅ on-chain | identity + rule stored in contract |
| Agent sends **5 CSPR** (≤ cap) | ✅ **Allowed** — funds move | within the leash |
| Agent sends **50 CSPR** (> cap) | ❌ **Blocked** — `ExceedsCap`, 0 funds move | contract reverts on-chain |
| Owner revokes agent | ✅ on-chain | agent set inactive |
| Agent sends 5 CSPR after revoke | ❌ **Blocked** — `Revoked` | revocation enforced |

The centerpiece: rows 2 and 3 are the **same entry point, same agent, same contract** — only the
amount differs. Enforcement lives in the contract, and it is verifiable by anyone.

An AI layer makes it agentic: a natural-language instruction ("send 50 CSPR to the owner") is
routed through **Gemini function-calling**, which chooses the `attempt_transfer` tool; the backend
submits it, and the contract blocks it. The reasoning is off-chain; the enforcement is on-chain.

---

## Architecture

```
Dashboard (browser)                          ← identity card, rule panel, green/red action log
      │  HTTP
Backend (Node/Express, in WSL)               ← Gemini reasoning + orchestration
      │                     │
 casper-client            Gemini API          ← reasons over natural language, picks a tool
 (put-deploy / get-deploy)
      │
 Casper Testnet
      │
 AgentLeash contract (Odra/Rust)             ← stores identity + rule, ENFORCES cap & active flag
```

- **On-chain enforcement, not middleware.** The backend never decides whether a transfer is
  allowed. It submits `check_and_execute`; the contract accepts or reverts with a specific error
  code, which the backend reads from the deploy execution result and surfaces to the dashboard.
- **Reasoning vs. enforcement are cleanly separated.** Gemini decides *what to attempt*; the
  contract decides *what is permitted*.

---

## Repository layout

```
contracts/agent_leash/   Odra smart contract (Rust) — src/agent_leash.rs, 8 unit tests
backend/                 Node/Express service: casper-client + Gemini + dashboard (public/)
Leash PRD.md             Product requirements
Casper TRD.md            Technical requirements
DEPLOYMENT.md            Every testnet deploy hash + how each call was made
CONSTRAINTS.md           Risk/constraint log (platform, tooling, on-chain realities)
CLAUDE.md                Build notes & changelog for AI coding agents
```

## The contract (`contracts/agent_leash/src/agent_leash.rs`)

Odra 2.8.2. Entry points:

| Fn | Who | Effect |
|----|-----|--------|
| `register_agent(agent, spending_cap, allowed_action)` | owner | store identity + rule |
| `check_and_execute(amount, recipient)` | agent (`caller()`) | transfer if compliant, else revert |
| `revoke_agent(agent)` | owner | set inactive |
| `get_agent_status(agent)` | anyone | read identity/rule |
| `deposit()` (payable) | owner | fund the contract purse |

Error codes (surfaced as `User error: N`): 1 AlreadyRegistered · 2 NotOwner · 3 AgentNotFound ·
4 Revoked · 5 ExceedsCap · 6 ActionNotAllowed. A blocked action **reverts** (rolling back any
event), so blocked actions are detected via the deploy's execution result, not events.

---

## Running it

**Platform note:** the Casper/Odra Rust stack and Node's dependencies do **not** build on Windows
(`casper-types` uses Unix-only APIs; Node deps hang on the `/mnt/c` mount). Everything runs in
**WSL2 Ubuntu**. See `CLAUDE.md` for the full toolchain.

### Contract
```bash
cd contracts/agent_leash
cargo odra test            # OdraVM (fast) — 8/8 pass
cargo odra test -b casper  # real CasperVM — 8/8 pass
cargo odra build           # -> wasm/AgentLeash.wasm
```

### Backend + dashboard
```bash
cd backend
cp .env.example .env       # set GEMINI_API_KEY
bash start.sh              # syncs to Linux fs, installs, launches detached
# open http://localhost:3001
```

Requires `casper-client` on PATH, owner/agent keys in `~/casper-keys/`, and Odra's
`proxy_caller_with_return.wasm` at `~/proxy_caller.wasm` (used to call the payable `deposit`).

---

## Known limitations (honest scope)

- **In-flight revocation** is out of scope — revocation blocks the *next* action, not one already
  in a block (documented in the PRD).
- **Native associated-keys scoping** (account-level key-weight layer, PRD §5.2) is designed but not
  yet wired up; contract-level enforcement is the primary, working mechanism.
- **Single allowed action** (transfers) for the MVP; the `ActionType` enum leaves room to widen.
- Testnet only. Throwaway keys.

## Tech stack

Odra 2.8.2 (Rust) · Casper Testnet · casper-client 5.0.1 · Node/Express · Gemini
(`@google/genai`, function-calling) · vanilla-JS dashboard.
