# Casper Agent Leash — Backend

Node service that gives an AI agent (Gemini) a natural-language interface whose actions are
enforced on-chain by the AgentLeash contract. Reasoning is off-chain; **enforcement is on-chain**
— the backend never decides whether a transfer is allowed, it submits `check_and_execute` and the
contract accepts or reverts.

## Layout
- `src/config.js` — network, contract, key paths, error-code map (defaults = live testnet deploy)
- `src/casper.js` — wraps `casper-client` (put-deploy / get-deploy) via `execFile` (no shell)
- `src/store.js` — JSON-file store for agent state + action log
- `src/gemini.js` — Gemini function-calling (`attempt_transfer`, `check_status`)
- `src/server.js` — Express API

## Run (must be in WSL / Linux)
`casper-client` and Node's deps only work on the Linux filesystem, not `/mnt/c`. Run from WSL:

```bash
cp .env.example .env      # then set GEMINI_API_KEY
npm install
npm start                 # http://localhost:3001
```

Requires `casper-client` on PATH, the owner/agent keys under `~/casper-keys/`, and
`~/proxy_caller.wasm` (Odra's payable proxy, copied from odra-casper-rpc-client resources).

## API
| Method | Path | Body | Does |
|--------|------|------|------|
| GET | `/api/config` | — | network + contract + account info |
| GET | `/api/status` | — | agent identity/rule/active (from store) |
| GET | `/api/log` | — | action log (newest first) |
| GET | `/api/deploy/:hash` | — | parsed execution result |
| POST | `/api/register` | `{spendingCapCspr}` | owner registers the agent |
| POST | `/api/deposit` | `{amountCspr}` | fund contract purse (via proxy caller) |
| POST | `/api/action` | `{amountCspr, recipient}` | agent `check_and_execute` |
| POST | `/api/revoke` | — | owner revokes the agent |
| POST | `/api/prompt` | `{message}` | Gemini decides a tool, backend executes it on-chain |

Write endpoints submit a deploy, wait for execution, and return
`{allowed, deployHash, explorer, exec, row}`. A blocked action returns `allowed:false` with the
contract error code mapped to a human message (e.g. code 5 → "exceeds the agent spending cap").
