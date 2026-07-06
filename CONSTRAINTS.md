# CONSTRAINTS & RISKS — Casper Agent Leash

Living checklist of the major constraints, unknowns, and risks that can bite us.
Update status as each is resolved. Keep this honest — a hidden risk is worse than a known one.

Legend: 🔴 blocking / unverified · 🟡 partially known / watch · 🟢 resolved

---

## A. Environment / Toolchain

- 🔴→🟢 **PLATFORM PIVOT: Casper stack does NOT build on Windows.** `casper-types 6.1.0`
  (a hard dep of Odra 2.8.2 via casper-client 5.0.0) uses Unix-only APIs (`std::os::unix`,
  `libc::sysconf`, `OpenOptionsExt::mode`) with no cfg guards → won't compile on MSVC.
  RESOLVED by moving all Rust/Casper work into **WSL2 Ubuntu 24.04**. The Windows
  MSVC/rustup install is unused for contracts (Node backend/dashboard can still run on
  Windows). Building on Linux is the supported path.
- 🟡 **WSL2 required a firmware-adjacent fix:** VM Platform + WSL features were enabled but
  `bcdedit hypervisorlaunchtype` was **Off** → set to **Auto** + reboot to make WSL2 start.
  Firmware virtualization itself was already on.
- 🟢 **Linux toolchain:** rustup + stable 1.96.1 + nightly-2026-01-01 (rust-src) +
  wasm32-unknown-unknown; apt: build-essential, pkg-config, libssl-dev, cmake.
- 🟢 **`cargo-odra` (Linux) + full pipeline VALIDATED.** `cargo odra test` on the flipper
  passes (1 passed; 0 failed). casper-types 6.1.0 compiles fine on Linux. First cold build
  ~44 min; incremental builds now seconds.
- 🟡 **Repo spans two filesystems now:** docs/backend/dashboard on Windows Desktop;
  Rust contract builds run in WSL. Decide canonical location for `contracts/` to avoid
  drift (leaning: build in-place via /mnt/c with CARGO_TARGET_DIR on Linux fs for speed).
- 🟡 **`casper-client` not installed.** Install path on Windows unconfirmed — may need
  `cargo install casper-client` (another long native build) or a prebuilt binary. Verify.
- 🟡 **Casper MCP Server** needs Docker OR .NET 10 SDK — neither present. Docker not
  installed; `dotnet` present but returned no SDK version. Read-only tool, not on the
  critical path — defer until reads are needed.
- 🟢 **Node 24 + npm 11 present**, **Python 3.14 present** — backend runtime available.

## B. Odra Contract (Prime Directive territory — do NOT guess)

- 🟢 **All Odra APIs verified from 2.8.2 source** (odra-core src, not docs-from-memory):
  `transfer_tokens(&Address, &U512)`, `emit_event(T)`, `caller() -> Address` (NOT
  PublicKey — contract keys on `Address`), `#[odra::event]`, `#[odra::odra_error]`,
  payable via `#[odra(payable)]`, `get_block_time() -> u64`.
- 🟢 **Contract written & fully tested**: src/agent_leash.rs — register/check_and_execute/
  revoke/get_status/deposit. 8/8 tests pass on OdraVM mock AND real CasperVM (`-b casper`),
  incl. real purse transfers. Optimized wasm artifact built (258 KB).
- 🟢 **Revert-rolls-back-events**: blocked actions revert with error codes 1–6 and emit
  nothing; only allowed actions emit `ActionAllowed`. Backend must map deploy failure
  codes → messages (TRD §5.4).
- 🟢 **wasm tooling**: cargo-odra needs `wasm-opt` (binaryen) + `wasm-strip` (wabt);
  installed from official release tarballs into ~/.cargo/bin (no sudo).

## C. Native Associated-Keys Scoping (highest lockout risk)

- 🔴 **Session WASM for adding a weighted associated key** — must read actual `.rs` source
  from `casper-ecosystem/tutorials-example-wasm` multi-sig folder, not reconstruct from prose.
- 🔴 **Account-lockout risk.** Misconfigured weight/threshold can permanently lock an
  account. Mitigation: throwaway funded testnet accounts only; keep an independent
  recovery key at sufficient weight; never touch thresholds on a keeper account.
- 🟡 **Interaction between contract-level cap and account-level key weight** is two separate
  enforcement layers — make sure the demo clearly shows the *contract* doing the blocking,
  not just the key weight.

## D. Backend / Integration

- 🔴 **casper-client scriptability from Node/Python** (subprocess + JSON parse) vs native
  SDK path — undecided. Resolve before writing integration code.
- 🔴 **Deploy revert reason surfacing.** A blocked action *reverts the deploy*; there's no
  clean error payload. Must poll `get-deploy`, parse `execution_results`, and map numeric
  error codes (1–6) to human messages. Verify the exact JSON shape.
- 🟡 **CSPR.click Agent Skill** package/import name unverified. Check docs before importing.
- 🟡 **Gemini function-calling schema** changes between SDK versions. Verify current schema
  format; don't copy from memory.
- 🟡 **API keys required:** CSPR.cloud (testnet), Gemini (function-calling enabled). Not yet
  obtained — will block backend testing.

## E. Async / On-chain Realities

- 🟡 **Deploy latency + polling.** Testnet deploys aren't instant; dashboard log needs
  polling with sane timeouts, not assume synchronous execution.
- 🟡 **Testnet CSPR faucet** needed to fund owner + agent accounts. Faucet limits/availability
  unverified.
- 🟡 **Gas/payment amount** for each deploy must be set correctly or deploys fail with
  out-of-gas — separate from the contract's spending-cap logic. Don't confuse the two.

## F. Scope / Timeline (deadline July 7)

- 🟡 **Odra/Casper tooling is recent** — integration friction is expected, not exceptional.
  Buffer time; don't assume first-try success.
- 🟢 **In-flight revocation edge cases** — explicitly OUT of scope (documented limitation).
- 🟡 **Cut order if behind:** (1) drop dashboard styling → plain log, (2) drop stretch goals,
  (3) transfers-only (already MVP default).
- 🔴 **Every "on-chain enforcement" claim** in demo/README must be backed by a real,
  verifiable testnet deploy hash. No mocked behavior described as on-chain.

---

## Immediate Next Actions

1. ⏳ Finish VS C++ Build Tools install (in progress).
2. Install Rust via rustup; add `wasm32-unknown-unknown`; verify.
3. `cargo install cargo-odra`; `cargo odra new`; pin real version → CLAUDE.md changelog.
4. Install/verify `casper-client`.
5. Work the CLAUDE.md §3 verification checklist against live Odra/Casper docs BEFORE
   writing any contract logic (items B/C above).
