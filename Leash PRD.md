## **Product Requirements Document (PRD)**

### **Project Name**

Leash — Identity & Permissions for Autonomous Agents

### **Author / Team**

Solo builder — Casper Agentic Buildathon 2026 (Qualification Round)

### **Date**

July 2026

---

### **1\. Problem Statement**

As AI agents gain wallets and act autonomously on-chain, there's no standard way to answer: *who owns this agent, what is it allowed to do, and what stops it from overstepping?* Today, an agent with a private key can do anything that key permits — there's no scoped, verifiable, revocable boundary around its authority. This is a structural gap in the emerging agent economy, not a convenience problem.

### **2\. Goal**

Build a system that gives any AI agent a **verifiable on-chain identity** owned by a human/organization, with **scoped permissions** (spending cap \+ allowed actions) enforced through a combination of Casper's native account security model and a custom on-chain policy contract — and demonstrate it live: a compliant agent action succeeds, a non-compliant one is blocked on-chain.

### **3\. Target Users**

* Developers building autonomous agents on Casper who need a safe way to grant limited authority  
* DAOs/organizations wanting to deploy agents without giving them unbounded control of funds  
* Buildathon judges evaluating genuine agentic-AI infrastructure (not just a UX wrapper)

### **4\. Success Criteria (Qualification Round)**

* Working prototype on Casper Testnet  
* At least one real on-chain transaction demonstrating a **permitted** agent action, and one demonstrating a **blocked** agent action (rejected by the policy contract) — both verifiable on-chain  
* Clear demo video showing the full flow: identity creation → compliant action → attempted violation → block  
* Clean GitHub repo with README and setup instructions

### **5\. Scope**

#### **In Scope (MVP)**

1. **Agent Identity Registration** — owner registers an agent: agent's public key, owner's public key, creation timestamp, active/revoked flag — stored in one on-chain contract  
2. **Native Key Scoping** — agent's key added as a low-weight associated key on the owner's account (enough to sign transfers, not enough to alter key management), using Casper's native associated-keys/weight-threshold model  
3. **Custom Permission Contract** — stores a single enforced rule per agent: **spending cap** (e.g. max X CSPR per transaction or per day) and a simple allowed-action flag (e.g. "transfers only")  
4. **Enforcement** — the policy contract checks the spending cap before allowing a transfer to execute; a request that exceeds the cap is rejected on-chain  
5. **Revocation** — owner can flag an agent as revoked; revoked agents are rejected by the policy contract on their next attempted action (no in-flight edge case handling — explicitly out of scope, noted below)  
6. **Demo Agent** — a minimal script/agent that:  
   * Attempts a compliant transfer (within cap) → succeeds  
   * Attempts a non-compliant transfer (exceeds cap) → blocked on-chain  
7. **Simple Dashboard** — shows agent identity card, current permission rule, and a live action log (green \= permitted, red \= blocked)

#### **Stretch Goals (only if ahead of schedule)**

8. Multiple allowed-action types beyond transfers (e.g. specific contract calls)  
9. Time-window spending caps (per-day vs per-transaction)  
10. Multi-agent view (owner manages several agents from one dashboard)

#### **Explicitly Out of Scope**

* Handling in-flight transaction edge cases during revocation  
* Multi-owner / multi-sig ownership of an agent  
* Reputation scoring (separate concept, not built here)  
* Mainnet deployment  
* General-purpose rule engine (only spending cap \+ allowed-action flag for MVP)

### **6\. Tech Stack**

| Layer | Technology |
| ----- | ----- |
| Identity & Permission Logic | Odra Framework (Rust) — custom smart contract |
| Account-level Scoping | Casper native associated keys / action thresholds |
| Reasoning Layer (demo agent) | Gemini API (function calling) |
| Blockchain Data/Actions | CSPR.cloud (REST API) |
| Wallet & Signing | CSPR.build Agent Skill |
| Network | Casper Testnet |
| Frontend | Simple web dashboard |
| Backend | Node.js/Python service orchestrating Gemini ↔ CSPR.cloud ↔ contract calls |

### **7\. System Architecture**

Owner registers agent  
   ↓  
Identity/Permission Contract (Odra) — stores agent identity \+ spending cap \+ active flag  
   ↓  
Agent's key added as low-weight associated key on owner's account (native Casper scoping)  
   ↓  
Demo Agent (Gemini-driven) attempts an action  
   ↓  
Backend routes action through Policy Contract check  
   ↓  
   ├── Within cap \+ active → transaction executes on Casper Testnet  
   └── Exceeds cap / revoked → transaction rejected on-chain  
   ↓  
Dashboard reads contract \+ transaction log via CSPR.cloud → displays identity, rule, action log

### **8\. Core Contract Functions (Odra)**

1. `register_agent(agent_pubkey, owner_pubkey, spending_cap, allowed_action)` → creates identity \+ rule record  
2. `check_and_execute(agent_pubkey, action_type, amount)` → validates against cap/active flag, executes or reverts  
3. `revoke_agent(agent_pubkey)` → owner-only, sets active flag to false  
4. `get_agent_status(agent_pubkey)` → returns identity, rule, active flag (read-only, for dashboard)

### **9\. User Flow (Demo)**

1. Owner registers Agent A with a 10 CSPR spending cap  
2. Dashboard shows Agent A: active, cap \= 10 CSPR, 0 actions logged  
3. Demo agent attempts to send 5 CSPR → **contract allows** → dashboard logs green entry, real testnet transaction visible  
4. Demo agent attempts to send 50 CSPR → **contract rejects** → dashboard logs red entry, no funds move  
5. Owner revokes Agent A → demo agent attempts any action → rejected due to revoked flag

### **10\. Risks & Mitigations**

| Risk | Mitigation |
| ----- | ----- |
| Off-chain-only enforcement could be bypassed | Enforcement lives in the on-chain contract itself, not just middleware |
| Contract bugs / edge cases (Rust, tight timeline) | Keep rule logic to one check (spending cap) for MVP; test manually before wiring up agent |
| Odra/AI toolkit tooling immaturity (recently launched) | Budget explicit buffer time for integration friction; don't assume first-try success |
| Revocation in-flight edge cases | Explicitly scoped out for MVP; stated as a known limitation, not hidden |
| Demo feels abstract to judges | Centerpiece demo is the "blocked" moment — rehearse this specifically, dashboard shows it visually |
| Running out of time | Cut order if behind: (1) drop dashboard styling → plain log, (2) drop stretch goals, (3) narrow allowed-action to transfers only (already MVP default) |
| Native associated-key setup misconfigured, locking owner out | Test key-weight changes only on throwaway testnet accounts first; keep a documented recovery key at higher weight |

### **11\. Milestones / Timeline (to July 7 deadline)**

| Day | Milestone |
| ----- | ----- |
| Day 1 | Set up Odra project, write and test `register_agent` \+ `get_agent_status` on local/testnet |
| Day 2 | Implement `check_and_execute` (spending cap logic) \+ `revoke_agent`; test compliant/non-compliant cases manually |
| Day 3 | Wire native associated-key scoping on a test owner account; confirm agent key has correct limited weight |
| Day 4 | Build demo agent (Gemini-driven) that triggers compliant \+ non-compliant actions through the contract |
| Day 5 | Build dashboard (identity card, rule, action log) reading from CSPR.cloud \+ contract state |
| Day 6 | Full run-through, fix integration issues, add revocation demo step |
| Final 1 day | Record demo video (registration → success → block → revoke), write README, submit BUIDL |

### **12\. Demo Video Script**

1. Show dashboard: register Agent A, cap \= 10 CSPR  
2. Agent attempts 5 CSPR transfer → succeeds, shown live on testnet explorer, dashboard logs green  
3. Agent attempts 50 CSPR transfer → rejected on-chain, dashboard logs red  
4. Owner revokes agent → next action blocked regardless of amount  
5. 20–30 seconds: why this matters — "agents can now hold money; this gives them a leash, verifiably, on-chain"

### **13\. Submission Requirements Checklist**

* GitHub/GitLab repo link  
* Demo video (shows real on-chain permitted \+ blocked actions)  
* Working prototype on Casper Testnet with transaction-producing on-chain component  
* README with setup instructions and known limitations (e.g. revocation in-flight scope)  
* BUIDL submitted on DoraHacks before July 7, 23:59 UTC

