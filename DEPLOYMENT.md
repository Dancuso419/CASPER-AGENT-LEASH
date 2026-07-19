# AgentLeash — Testnet Deployment Record

All hashes verifiable on https://testnet.cspr.live

## Contract (deployed 2026-07-06)

| Item | Value |
|---|---|
| Network | Casper Testnet (`casper-test`) |
| Install deploy hash | `c77f7080337fb54dca1a0e041ad6b5ad78d457aef0d8ffcbe4d022400dca79df` |
| Contract package hash | `hash-a7d018fcc02bec1a44d1060c6ea77be8869919a91ab4e8f5daf66ecf86acd660` |
| Named key (on owner acct) | `AgentLeash` |
| Gas consumed | 238,685,609,533 motes (~238.7 CSPR) |
| WASM | `contracts/agent_leash/wasm/AgentLeash.wasm` (258 KB, optimized) |

## Contract upgrade — v2 (2026-07-19): adds `update_cap`

In-place upgrade (same package hash, prior agent state preserved) adding the owner-only
`update_cap(agent, new_cap)` entry point so an owner can change an agent's spending cap
without re-registering. 12/12 unit tests pass on OdraVM and CasperVM.

| Item | Value |
|---|---|
| Upgrade deploy hash | `13e9e28e74733317b9970ea2ac62a3f2a0ad542c67dba109d71e9678f86047f5` (block 8554929) |
| Package hash | **unchanged** — `a7d018fcc02bec1a44d1060c6ea77be8869919a91ab4e8f5daf66ecf86acd660` |
| New entry point | `update_cap(agent: key, new_cap: u512)` — owner-only (reverts `NotOwner`=2 / `AgentNotFound`=3) |
| Proof — update_cap live | register test agent `85bf7dc0…` ✅ → `update_cap` 10→99 CSPR `4e58205…` ✅ (block 8554958) |

**Upgrade command** (differs from install — the upgrade path needs two extra `odra_cfg_` args,
verified against `odra-casper-wasm-env-2.8.2/src/host_functions.rs`, NOT guessed):

```bash
casper-client put-deploy \
  --node-address https://node.testnet.casper.network --chain-name casper-test \
  --secret-key ~/casper-keys/owner/secret_key.pem \
  --session-path wasm/AgentLeash.wasm --payment-amount 350000000000 \
  --session-arg "odra_cfg_is_upgradable:bool='true'" \
  --session-arg "odra_cfg_is_upgrade:bool='true'" \
  --session-arg "odra_cfg_allow_key_override:bool='true'" \
  --session-arg "odra_cfg_create_upgrade_group:bool='false'" \
  --session-arg "odra_cfg_package_hash_key_name:string='AgentLeash'" \
  --session-arg "odra_cfg_package_hash_to_upgrade:byte_array_32='a7d018fcc02bec1a44d1060c6ea77be8869919a91ab4e8f5daf66ecf86acd660'"
```

Gotcha: omitting `odra_cfg_package_hash_to_upgrade` + `odra_cfg_create_upgrade_group`
reverts with `ApiError::MissingArgument [2]` (first attempt `55ea78c9…` failed this way — the
existing contract was untouched, only gas lost).

## Contract upgrade — v3 (2026-07-19): adds `reactivate_agent`

Same in-place upgrade mechanism (identical command as v2, just the new WASM). Adds owner-only
`reactivate_agent(agent)` — reverses a revoke by setting `is_active = true`, so a revoked agent
is no longer a permanent dead-end (important for a replayable demo). 15/15 tests pass on
OdraVM + CasperVM.

| Item | Value |
|---|---|
| Upgrade deploy hash | `a9a3b560fd5e25e005b782265063716753f743bf24c7d952833dc3acb6a50bde` (block 8555386) |
| Package hash | **unchanged** — `a7d018fcc02bec1a44d1060c6ea77be8869919a91ab4e8f5daf66ecf86acd660` |
| New entry point | `reactivate_agent(agent: key)` — owner-only |
| Proof — reactivate live | revoke `fd53ace0…` ✅ → reactivate `e04ab742…` ✅ (blocks 8555395/8555397) |

## Accounts (throwaway testnet keys, stored in WSL `~/casper-keys/`, NOT in repo)

| Role | Public key | Account hash |
|---|---|---|
| Owner | `018ad8719a59a4d282d3c829c41686de36d28eb0705502b4d6c0bd61667a1c58d9` | `account-hash-104a19bb...054dc3` |
| Agent | `016d7987bf702fe51e467bba852ae479067f4c8e7eb2573b9840679b4df4194da4` | `account-hash-f6bb58c0...cf33f3` |

## Live demo flow — all verifiable on testnet.cspr.live/deploy/<hash>

Contract package hash: `a7d018fcc02bec1a44d1060c6ea77be8869919a91ab4e8f5daf66ecf86acd660`
Contract purse (created by deposit): `uref-0210588032158729b3ed0ff0bcedc72787e733186df2d7275c1b9f438f17141d`

| # | Action | Signer | Deploy hash | Result | Proof |
|---|--------|--------|-------------|--------|-------|
| 1 | Install contract | owner | `c77f7080337fb54dca1a0e041ad6b5ad78d457aef0d8ffcbe4d022400dca79df` | ✅ Success | contract on-chain |
| 2 | register_agent (cap 10 CSPR) | owner | `af5f91eed91f8df69a2cbb05297a69a90e0997d57343d6b5944776645abc0408` | ✅ Success | agent identity stored |
| 3 | deposit 100 CSPR (via proxy_caller) | owner | `120cbb4ac68bde0a32b6af7125b9d690005478f05e116976c1d6ab4115ea2d78` | ✅ Success | contract purse = 100 CSPR |
| 4 | **check_and_execute 5 CSPR (≤ cap)** | agent | `41bdcf35cc367d678dc5686b9143096a86ee672466cb4bef4decedd439f20f99` | ✅ **Success** | purse 100→95, funds MOVED |
| 5 | **check_and_execute 50 CSPR (> cap)** | agent | `f749daaeb99e21724b3829d3bfa0df8377213cf4d17b2d7f03d6b9701b2deb9d` | ❌ **Failure "User error: 5"** (ExceedsCap) | BLOCKED on-chain, 0 funds moved |
| 6 | revoke_agent | owner | `53c48a215b2cfcc16024619221633216ba6c684d08d483aa8afbf9bc516b3491` | ✅ Success | agent set inactive |
| 7 | check_and_execute 5 CSPR after revoke | agent | `fe6fb4b00e1fd86d682da857c8b6e383acea4b5c583705f3849326b859834c61` | ❌ Failure "User error: 4" (Revoked) | revocation enforced |

Error code map (from `#[odra::odra_error]`, surfaced as "User error: N"):
1=AlreadyRegistered, 2=NotOwner, 3=AgentNotFound, 4=Revoked, 5=ExceedsCap, 6=ActionNotAllowed.

The centerpiece: rows 4 & 5 are the SAME entry point, SAME agent, SAME contract — 5 CSPR
succeeds and moves funds; 50 CSPR reverts on-chain. Enforcement is in the contract, verifiable.

## How to call an Odra contract entry point from raw casper-client (no SDK)

- Non-payable entry points: `put-deploy --session-package-hash <hex> --session-entry-point <name>`
  with `--session-arg`. Unit enums encode as `u8` (discriminant); `Address` args as `key`.
- Payable entry points (e.g. `deposit`, whose only arg is `__cargo_purse: URef`): call Odra's
  `proxy_caller_with_return.wasm` (in odra-casper-rpc-client resources/) as session, with args
  `package_hash:byte_array_32`, `entry_point:string`, `args:byte_list` (inner RuntimeArgs bytes;
  empty = `00000000`), `attached_value:u512`, `amount:u512`. The proxy creates+funds a purse and
  passes it as `__cargo_purse`.
- Success test (Casper 2.0): `"error_message": null` in the Version2 execution result.

## Dashboard demo agent (agent2)

The rows above (agent = `f6bb…`) are the original CLI-driven proof; that agent is now revoked.
The live dashboard/backend uses a fresh **agent2** so the allowed→blocked→revoked flow can be
re-run interactively:

- agent2 pubkey `018e930ec42b19a0c2679daaef3ff565a1ff5d4b6d118c1a64a03322d7170cf382`
- agent2 account-hash `account-hash-6bd38f839796576f2a9f3ce3721697519f3f24d21f455755c084ed71d69c2d68`
- Same contract/purse. Backend runs the identical `register → check_and_execute → revoke` calls;
  verified allowed (5 CSPR) and Gemini-driven blocked (50 CSPR → ExceedsCap) on-chain.

## Dashboard demo agent (agent3) — current live Render deployment

agent2 was already registered on-chain (AlreadyRegistered on re-register), so a fresh
**agent3** drives the hosted demo, allowing a clean register → allowed → blocked → revoke run:

- agent3 pubkey `018cbbcc847c36d1769eabc3a70ee0d746f7d9620c02840d9a34e4b2e581cb2d8c`
- agent3 account-hash `account-hash-7c6ca4889d689c521b175255f7c6a678c44d7aac9b9abbe5ea9f656aba05f66a`
- Gas funded: owner → agent3 50 CSPR, deploy `7592fe6063039fdf4ee359177b0bb88ecf4deffe8d7b2a84b5dc02c81f7f5ed8`
- Keys in WSL `~/casper-keys/agent3/`; Render env uses `AGENT_KEY_B64` + `AGENT_ACCOUNT_HASH`.

## Prior on-chain activity

- Owner funded with 3000 CSPR (user transfer from wallet)
- Owner → Agent 500 CSPR, deploy `e829ca4bd653ca045ef0d83bd01eea7d8b15f23e045ec2c1153e4fae07595108`
- Owner → agent2 50 CSPR (gas), deploy `c832226476e22557e16910f3b87196b32b001867aa5f849d0869341656e09528`

## How it was deployed (working commands)

Odra-cli livenet deploy is broken in 2.8.2 (reads `CSPR_CLOUD_AUTH_TOKEN` but never
sends it → CSPR.cloud rejects). Working path is legacy `put-deploy` to the public node:

```bash
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

Notes:
- `put-transaction session` (V1 format) was rejected with "invalid pricing mode" for
  both classic and fixed despite chainspec `payment_limited` — casper-client 5.0.1 quirk;
  legacy Deploy format works.
- Execution result (Casper 2.0): success ⇔ `"error_message": null` in the Version2
  execution result from `get-deploy` (there is NO `"Success"` key like 1.x).
