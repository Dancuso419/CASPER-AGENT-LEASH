# CLAUDE.md — Casper Agent Leash

Instructions for any AI coding agent (Claude Code or similar) working on this repository.
Read this file in full before writing or modifying any code.

---

## 0. Prime Directive

**Do not guess API signatures, function names, CLI flags, or contract syntax.**
This project uses tooling (Odra 2.8.0, Casper MCP Server, CSPR.cloud, casper-client) that is
recent and not fully represented in most models' training data. If you are not certain an API
call, macro, or CLI command exists exactly as written, STOP and verify against the linked docs
below before using it. A wrong guess that compiles-by-accident is worse than an honest pause to
check documentation.

If you cannot verify something (e.g. no internet access in this environment), leave a clearly
marked `// VERIFY:` comment explaining exactly what needs confirming and why, rather than
silently proceeding on an assumption.

---

## 1. Project Summary

Casper Agent Leash gives AI agents a verifiable on-chain identity and enforced permissions
(spending cap + allowed action type) on the Casper Network, combining:
- A custom Odra smart contract (identity + permission storage + enforcement)
- Casper's native associated-keys / action-threshold account model (coarse key scoping)
- A backend service (Gemini function calling + CSPR.cloud/casper-client)
- A dashboard showing agent identity, rules, and a live allowed/blocked action log

Full context: see `PRD.md` and `TRD.md` in this repo before implementing anything.

---

## 2. Required Dependencies — Install in This Order

### 2.1 Rust toolchain
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.dev | sh
rustup target add wasm32-unknown-unknown
```
Verify: `rustc --version` and `rustup target list --installed` shows `wasm32-unknown-unknown`.

### 2.2 Odra Framework + CLI
```bash
cargo install cargo-odra
cargo odra new --name agent_leash
```
- **Pin the exact Odra version** used, in `Cargo.toml`. Do not assume version parity with any
  code example without checking `Cargo.toml` after `cargo odra new` runs — record the version
  installed, and note it in this file's changelog (Section 6) once known.
- Docs: https://odra.dev/docs/ — read the **Getting Started** and **Basics** sections before
  writing contract logic. Do NOT write `self.env().transfer_tokens(...)`, event emission macros,
  or `caller()` calls from memory — confirm exact method names against the live docs first.
- Test locally with the mock backend, then confirm against the real VM backend:
  ```bash
  cargo odra test          # mock backend, fast iteration
  cargo odra test -b casper  # real CasperVM semantics — required before any testnet deploy
  ```

### 2.3 casper-client (CLI)
```bash
# Install via cargo or your OS package manager — verify current install instructions at:
# https://docs.casper.network (search "casper-client installation")
casper-client --version
```
Used for: deploying contracts, calling contract entry points, managing associated keys,
querying account state, querying deploy execution results. **This is the tool used for all
write operations** (register_agent, check_and_execute, revoke_agent) — the MCP server below is
read-only and cannot execute these.

### 2.4 Casper MCP Server (community, read-only)
Repo: https://github.com/msanlisavas/casper-mcp
Two install paths — pick based on your environment:
```bash
# Option A: Docker (recommended if avoiding .NET install)
docker pull ghcr.io/msanlisavas/casper-mcp:latest

# Option B: .NET tool (requires .NET 10 SDK)
dotnet tool install -g CasperMcp
```
**Confirmed scope:** 92 read-only tools (accounts, blocks, deploys, transfers, tokens, NFTs,
network status) plus two multi-sig collection tools (`CreateAwaitingDeploy`,
`AddAwaitingDeployApproval`). It does **not** expose a generic "call any contract function" tool.
Do not attempt to use this MCP server to invoke `register_agent`, `check_and_execute`, or
`revoke_agent` — those go through `casper-client` directly.

### 2.5 CSPR.cloud API key
- Sign up at https://cspr.cloud, generate a **testnet** API key.
- Docs: https://docs.cspr.cloud
- Used by: backend service for read queries (balances, deploy status, transaction history) as
  an alternative/supplement to the MCP server, and by CSPR.click Agent Skill under the hood.

### 2.6 CSPR.click AI Agent Skill
- Docs: https://docs.cspr.click/documentation/ai-agent-skills
- Provides wallet creation, transaction signing, CSPR.cloud proxy access for the demo agent.
- Verify install/import steps against the live docs page before wiring into the backend —
  do not assume npm package name or API surface from general knowledge.

### 2.7 Gemini API
- Get an API key with function-calling support enabled.
- Verify current SDK package name and function-declaration schema format against Google's
  current docs before writing integration code — function-calling schemas change between
  SDK versions, do not copy from memory of older versions.

### 2.8 Backend runtime
- Node.js (recommended, for easiest CSPR.cloud + Gemini SDK compatibility) or Python — pick one
  and confirm SDK availability for both CSPR.cloud and Gemini in that language before committing
  to it.

---

## 3. Verification Checklist — Complete BEFORE Writing Contract Logic

Do not proceed to implementation (Section 4 of TRD.md) until each item below is confirmed,
not assumed:

- [ ] Confirmed exact Odra syntax for: module storage (`Mapping`, `Var`), `#[odra::module]`,
      `#[odra::odra_type]`, `#[odra::odra_error]` macros — checked against a working example
      in the current Odra docs (e.g. the Flipper example), not from memory
- [ ] Confirmed exact method for native token transfer within an Odra module
- [ ] Confirmed exact method for reading the caller's address/public key within a module
- [ ] Confirmed exact event emission pattern in Odra 2.8.0
- [ ] Confirmed `casper-client` subcommands for: deploying a contract, calling a contract entry
      point with arguments, querying account info, querying deploy execution results
- [ ] Confirmed the exact session-code pattern for adding an associated key with a specific
      weight (reference: `casper-ecosystem/tutorials-example-wasm`, `multi-sig` folder) —
      read the actual `.rs` source in that repo rather than reconstructing it from the tutorial
      prose alone
- [ ] Confirmed how deploy execution failure/revert reasons are surfaced in the JSON response
      from `casper-client get-deploy` (needed to map contract error codes to human-readable
      messages in the dashboard)

If any of these cannot be verified in this environment (no internet access), mark the relevant
code with `// VERIFY:` and flag it explicitly in your response to the user rather than proceeding
silently.

---

## 4. Known Unknowns (do not paper over these)

- Exact Odra 2.8.0 API for token transfer and event emission was **not confirmed** at time of
  writing this file — flagged in TRD.md Section 3.2 as requiring a direct doc check on Day 1.
- Whether `casper-client` deploy submission/polling is cleanly scriptable from Node/Python via
  subprocess, or whether a native JS/Rust SDK path is cleaner, is **undecided** — resolve this
  on Day 1 before writing backend integration code (TRD.md Section 8, item 2).
- CSPR.click Agent Skill's exact package/import name was **not verified** — check docs directly
  before importing.

---

## 5. File/Repo Structure (expected)

```
/contracts/agent_leash/       # Odra contract source
/backend/                     # Node or Python service
/dashboard/                   # Frontend
/docs/PRD.md
/docs/TRD.md
/docs/CLAUDE.md               # this file
README.md                     # setup + usage instructions for judges
```

---

## 6. Changelog (update as unknowns get resolved)

- 2026-07-05 — Odra framework version pinned: **2.8.2** (crates: odra, odra-test,
  odra-build, odra-cli — all 2.8.2). cargo-odra CLI: 0.1.7. NOTE: docs/TRD assumed 2.8.0;
  actual latest release scaffolded is 2.8.2. Project also pins Rust **nightly-2026-01-01**
  via `contracts/agent_leash/rust-toolchain` (stable will NOT build it).
- 2026-07-05 — Toolchain: VS 2022 C++ Build Tools (MSVC 14.44.35207) + rustup + Rust
  stable 1.96.1; wasm32-unknown-unknown target added. Host x86_64-pc-windows-msvc.
- 2026-07-06 — **PLATFORM: build in WSL2 Ubuntu 24.04, NOT Windows.** casper-types 6.1.0
  (Odra 2.8.2 dep) uses unguarded Unix-only APIs → will not compile on MSVC. WSL2 needed
  `bcdedit /set hypervisorlaunchtype Auto` + reboot to start. Linux toolchain: rustup
  stable 1.96.1 + nightly-2026-01-01 (rust-src) + wasm32; apt build-essential, pkg-config,
  libssl-dev, cmake; cargo-odra 0.1.7. Contract source in Desktop repo, built from WSL via
  /mnt/c with CARGO_TARGET_DIR=$HOME/target/agent_leash. `cargo odra test` (flipper) PASSES.
  Node backend/dashboard can still run on Windows.
- 2026-07-06 — Confirmed transfer method: `self.env().transfer_tokens(&to: &Address, &amount: &U512)`
  (verified in odra-core-2.8.2/src/contract_env.rs).
- 2026-07-06 — Confirmed event emission: `self.env().emit_event(EventStruct{..})` where the
  struct derives `#[odra::event]`. NOTE: revert rolls back events → blocked actions emit
  nothing and revert with an error code (backend reads deploy execution result instead).
- 2026-07-06 — Confirmed `caller() -> Address` (NOT PublicKey). Contract keys on `Address`;
  `check_and_execute` identifies the agent via `caller()`. Errors are `#[odra::odra_error]`
  enum (codes 1-6). Contract in src/agent_leash.rs; 8 unit tests pass on OdraVM.
- 2026-07-06 — **Contract validated on real CasperVM**: `cargo odra build` produces
  optimized `wasm/AgentLeash.wasm` (258 KB; needs `wasm-opt` from binaryen + `wasm-strip`
  from wabt — installed to ~/.cargo/bin in WSL, no sudo). `cargo odra test -b casper`:
  **8/8 pass** incl. real purse transfer + blocked-transfer-moves-nothing. NOTE: cargo-odra
  ignores CARGO_TARGET_DIR for its copy step — project `./target` is a symlink to
  ~/target/agent_leash on the Linux fs. Contract is testnet-deploy-ready.
- 2026-07-06 — **CONTRACT DEPLOYED TO TESTNET.** Deploy hash c77f7080...dca79df, package
  hash-a7d018fcc02bec1a44d1060c6ea77be8869919a91ab4e8f5daf66ecf86acd660 (see DEPLOYMENT.md).
  KEY FINDINGS: (1) odra-cli livenet deploy broken in 2.8.2 — CSPR_CLOUD_AUTH_TOKEN read but
  never sent; (2) `put-transaction` V1 format rejected by testnet ("invalid pricing mode") —
  use legacy `put-deploy` with odra_cfg_* session args; (3) Casper 2.0 get-deploy success test
  is `"error_message": null` (no "Success" key). Owner/agent keys in WSL ~/casper-keys/.
- 2026-07-06 — **FULL DEMO FLOW LIVE ON TESTNET (7 deploys, all in DEPLOYMENT.md).**
  register✅ → deposit 100 CSPR✅ → compliant 5 CSPR✅ (purse 100→95, funds moved) →
  over-cap 50 CSPR❌ "User error: 5" (ExceedsCap) → revoke✅ → post-revoke 5 CSPR❌
  "User error: 4" (Revoked). On-chain enforcement proven. Payable calls done via Odra's
  proxy_caller_with_return.wasm; unit enums encode as u8, Address as key. odra-cli livenet
  unusable (needs raw node SSE; CSPR.cloud only exposes WS streaming). Backend/dashboard next.
- 2026-07-06 — Backend runtime: **Node (Express) in WSL**, deps + casper-client both on the
  Linux fs (express import HANGS on /mnt/c 9p — must run from ~/agent-leash-backend, source
  synced from repo). SDK path: `casper-client` via child_process.execFile (no shell, no
  quoting issues); reads via get-deploy polling + local JSON store (not CSPR.cloud REST).
  Gemini: **@google/genai 2.10.0**, `ai.models.generateContent` + `response.functionCalls`.
  Backend in /backend; read + write (register/deposit/action/revoke) endpoints verified live
  on testnet. get-deploy takes only --node-address (NOT --chain-name). Launch server detached
  (setsid nohup) or the WSL bridge SIGTERMs it. Gemini /api/prompt untested (needs API key).

---

## 7. Reminders for Every Session

1. Re-read this file's "Known Unknowns" section before touching related code — check if they've
   since been resolved and update the changelog.
2. Never invent a contract error code, CLI flag, or SDK method name to "make the code compile" —
   if unsure, pause and say so.
3. All testnet key/weight experiments happen on disposable accounts only — never on an account
   you intend to keep, until the exact commands are verified working.
4. Every claim in the demo video and README about "real on-chain enforcement" must be backed by
   an actual verifiable testnet deploy hash — do not describe simulated or mocked behavior as
   on-chain in any submission material.
