# **Technical Requirements Document (TRD)**

## **Project Name**

Casper Agent Leash — Identity & Permissions for Autonomous Agents

## **Related Document**

See PRD for product scope, goals, and timeline.

---

## **1\. Verified Tooling (confirmed from official sources)**

| Tool | Role | Source |
| :---- | :---- | :---- |
| **Odra Framework v2.8.0** | Rust smart contract framework | odra.dev/docs, repo: github.com/odradev/odra |
| **Casper MCP Server** (community, msanlisavas/casper-mcp) | 92 read-only tools for blockchain queries (accounts, balances, deploys, transfers, contracts) — via CSPR.Cloud | github.com/msanlisavas/casper-mcp |
| **CSPR.cloud** | REST/Streaming/Node API middleware; also the data source underlying the MCP server | docs.cspr.cloud, cspr.cloud/skill.md |
| **CSPR.click AI Agent Skill** | Wallet creation, signing, CSPR.cloud proxy | docs.cspr.click/documentation/ai-agent-skills |
| **x402 Facilitator/Examples** | Not core to this project, but available if stretch goals need payments | github.com/make-software/casper-x402 |

**Important correction to earlier assumption:** The Casper MCP Server is **read/query-only** (92 tools: accounts, blocks, deploys, tokens, NFTs, transfers, network status) plus two **multi-sig collection** tools (CreateAwaitingDeploy, AddAwaitingDeployApproval). It does **not** expose a generic "call any custom contract function" tool. This means:

* Use the MCP server (or CSPR.cloud REST directly) for **reading** state — balances, deploy status, transaction history, agent record lookups.  
* Our **custom contract calls** (register\_agent, check\_and\_execute, revoke\_agent) must be invoked directly via casper-client (CLI) or the Casper JS/Rust SDK — not through the MCP server, since it has no generic write/execute tool.  
* The CreateAwaitingDeploy / AddAwaitingDeployApproval tools are actually useful for our **native associated-keys** layer if we want multi-signature-style approval flows later (stretch goal, not MVP).

## **2\. System Architecture**

\[Dashboard (web)\] ⇄ \[Backend service\]  
                          │  
        ┌─────────────────┼─────────────────────┐  
        │                 │                     │  
\[casper-client/SDK   \[Casper MCP Server /   \[Gemini API\]  
 direct contract      CSPR.cloud REST\]      (demo agent  
 calls: register,     — read-only queries    reasoning)  
 check\_and\_execute,    for balances, history,  
 revoke\]               deploy status  
        │                 │  
        └────────┬────────┘  
                  ▼  
         \[Casper Testnet\]  
                  │  
       \[AgentLeash Contract (Odra)\]  
       \[Owner Account — associated keys\]

## **3\. On-Chain Contract Specification (Odra, Rust)**

### **3.1 Project Setup**

cargo install cargo-odra  
cargo odra new \--name agent\_leash  
cd agent\_leash

Confirmed test command: cargo odra test \-b casper (runs against CasperVM, not just mock backend — required for realistic testing before testnet deploy).

### **3.2 Module Structure (based on confirmed Odra syntax)**

use odra::prelude::\*;  
use odra::casper\_types::{PublicKey, U512};

\#\[odra::module\]  
pub struct AgentLeash {  
    agents: Mapping\<PublicKey, AgentRecord\>,  
}

\#\[odra::odra\_type\]  
pub struct AgentRecord {  
    pub owner: PublicKey,  
    pub spending\_cap: U512,  
    pub allowed\_action: ActionType,  
    pub is\_active: bool,  
    pub created\_at: u64,  
}

\#\[odra::odra\_type\]  
pub enum ActionType {  
    TransferOnly,  
}

\#\[odra::module\]  
impl AgentLeash {  
    pub fn init(\&mut self) {  
        // no global init state needed; Mapping starts empty  
    }

    pub fn register\_agent(  
        \&mut self,  
        agent\_pubkey: PublicKey,  
        spending\_cap: U512,  
        allowed\_action: ActionType,  
    ) {  
        if self.agents.get(\&agent\_pubkey).is\_some() {  
            self.env().revert(Error::AlreadyRegistered);  
        }  
        let owner \= self.env().caller(); // caller's public key/address  
        self.agents.set(\&agent\_pubkey, AgentRecord {  
            owner,  
            spending\_cap,  
            allowed\_action,  
            is\_active: true,  
            created\_at: self.env().get\_block\_time(),  
        });  
    }

    pub fn check\_and\_execute(  
        \&mut self,  
        agent\_pubkey: PublicKey,  
        amount: U512,  
        recipient: PublicKey,  
    ) {  
        let mut record \= self.agents.get(\&agent\_pubkey)  
            .unwrap\_or\_revert\_with(self, Error::AgentNotFound);

        if \!record.is\_active {  
            self.emit\_event(ActionAttempted::blocked(\&agent\_pubkey, amount, "revoked"));  
            self.env().revert(Error::Revoked);  
        }  
        if amount \> record.spending\_cap {  
            self.emit\_event(ActionAttempted::blocked(\&agent\_pubkey, amount, "exceeds\_cap"));  
            self.env().revert(Error::ExceedsCap);  
        }

        // Execute native transfer (via Odra's transfer helper / system contract call)  
        self.env().transfer\_tokens(\&recipient, \&amount);

        self.emit\_event(ActionAttempted::allowed(\&agent\_pubkey, amount));  
    }

    pub fn revoke\_agent(\&mut self, agent\_pubkey: PublicKey) {  
        let mut record \= self.agents.get(\&agent\_pubkey)  
            .unwrap\_or\_revert\_with(self, Error::AgentNotFound);  
        if self.env().caller() \!= record.owner {  
            self.env().revert(Error::NotOwner);  
        }  
        record.is\_active \= false;  
        self.agents.set(\&agent\_pubkey, record);  
    }

    pub fn get\_agent\_status(\&self, agent\_pubkey: PublicKey) \-\> AgentRecord {  
        self.agents.get(\&agent\_pubkey)  
            .unwrap\_or\_revert\_with(self, Error::AgentNotFound)  
    }  
}

**Note:** exact API for self.env().transfer\_tokens, self.env().caller(), unwrap\_or\_revert\_with, and event emission macros should be confirmed against the live Odra 2.8.0 API docs (Basics and Advanced doc categories) during Day 1 setup — the flipper example confirms module/storage/testing patterns, but transfer and event APIs need a direct doc check before writing real code (don't guess-and-ship these two calls).

### **3.3 Errors**

\#\[odra::odra\_error\]  
pub enum Error {  
    AlreadyRegistered \= 1,  
    NotOwner \= 2,  
    AgentNotFound \= 3,  
    Revoked \= 4,  
    ExceedsCap \= 5,  
    ActionNotAllowed \= 6,  
}

### **3.4 Testing Requirements**

* Unit tests using odra\_test::env() mock backend (fast iteration) — pattern confirmed from flipper example  
* Before testnet deploy: run cargo odra test \-b casper to validate against actual CasperVM semantics  
* Test cases required: register → success; register duplicate → revert; compliant transfer → success \+ event; over-cap transfer → revert \+ event; revoked agent transfer attempt → revert; non-owner revoke attempt → revert

## **4\. Native Casper Account Scoping**

### **4.1 Setup (via casper-client, confirmed from Casper docs)**

\# 1\. Generate agent keypair  
casper-client keygen agent\_keys/

\# 2\. Add agent's key as a low-weight associated key on owner's account  
\#    (session code, per Casper's multi-sig tutorial pattern)  
casper-client put-deploy \\  
  \--node-address https://node.testnet.casper.network \\  
  \--chain-name casper-test \\  
  \--secret-key owner\_secret\_key.pem \\  
  \--session-path update\_associated\_keys.wasm \\  
  \--session-arg "associated\_key:key='account-hash-\<AGENT\_ACCOUNT\_HASH\>'" \\  
  \--session-arg "new\_weight:u8='1'"

* Owner's own key weight and key\_management threshold must be set so agent's weight-1 key can meet deployment threshold but not key\_management threshold (e.g. deployment: 1, key\_management: 3, owner primary key weight: 3).  
* Reference: casper-ecosystem/tutorials-example-wasm repo's multi-sig folder contains the exact session code (add\_account.wasm, update\_associated\_keys.wasm) to adapt.

### **4.2 Verification (required before demo, do not skip)**

casper-client get-account-info \\  
  \--node-address https://node.testnet.casper.network \\  
  \--public-key \<owner\_public\_key\_hex\>

Confirm associated\_keys includes agent's account hash with weight 1, and action\_thresholds.key\_management \> agent's weight.

### **4.3 Safety Protocol**

* Perform ALL key-weight experiments on a disposable/funded throwaway testnet account first  
* Document the exact casper-client commands used in README, with real (test-only) account hashes redacted appropriately  
* Keep an independent recovery key at sufficient weight before touching thresholds on any account you intend to keep

## **5\. Backend Service**

### **5.1 Responsibilities**

* Serve dashboard API  
* Execute contract calls (register\_agent, check\_and\_execute, revoke\_agent) via casper-client subprocess calls or the Casper Rust/JS SDK — **not** via the MCP server (confirmed no write tool available)  
* Query state (balances, deploy status, agent record) via **Casper MCP Server** (GetAccountInfo, GetDeploy, or a direct get\_agent\_status call for our own contract's state) or CSPR.cloud REST directly  
* Route Gemini function calls to the above

### **5.2 Endpoints**

| Endpoint | Method | Implementation |
| :---- | :---- | :---- |
| /agents/register | POST | Shells out to casper-client put-deploy calling register\_agent, returns deploy hash |
| /agents/:pubkey/status | GET | Calls get\_agent\_status (read, via casper-client query-state or a lightweight RPC call) |
| /agents/:pubkey/action | POST | Calls check\_and\_execute; catches revert reason from deploy execution result |
| /agents/:pubkey/revoke | POST | Calls revoke\_agent |
| /agents/:pubkey/log | GET | Queries GetAccountDeploys / GetDeploy via Casper MCP Server or CSPR.cloud REST, cross-referenced with our emitted events (WatchContractEvents MCP tool if using streaming) |

### **5.3 Gemini Function Declarations**

\[  
  {  
    "name": "attempt\_transfer",  
    "description": "Attempt to send CSPR from the agent's scope to a recipient, subject to the agent's spending cap and active status.",  
    "parameters": {  
      "type": "object",  
      "properties": {  
        "recipient": { "type": "string" },  
        "amount": { "type": "number" }  
      },  
      "required": \["recipient", "amount"\]  
    }  
  },  
  {  
    "name": "check\_status",  
    "description": "Check the agent's current identity, permission rule, and active status.",  
    "parameters": { "type": "object", "properties": {} }  
  }  
\]

### **5.4 Reading Deploy/Event Results**

Since a blocked action **reverts the deploy** (not just returns an error payload), the backend must:

1. Submit the deploy  
2. Poll GetDeploy (via casper-client or MCP GetDeploy tool) until execution result is available  
3. Parse execution\_results — check for Success vs Failure with our specific error code, and surface the human-readable reason (e.g. "Blocked: exceeds spending cap") to the dashboard/Gemini response

## **6\. Frontend Dashboard**

### **6.1 Views**

1. **Agent Identity Card** — agent pubkey (truncated), owner pubkey, created date, active/revoked badge  
2. **Permission Rule Panel** — spending cap, allowed action type  
3. **Action Log** — chronological list, green (Allowed) / red (Blocked) entries with reason, each linking to the real deploy hash on cspr.live (testnet block explorer) for judge verification

### **6.2 Data Source**

Dashboard polls backend, which in turn uses:

* Casper MCP Server / CSPR.cloud REST for read data (balances, deploy history)  
* Direct contract state queries for agent record

## **7\. Environment & Dependencies Checklist**

* Rust stable \+ wasm32-unknown-unknown target  
* cargo-odra CLI, Odra 2.8.0 pinned in Cargo.toml  
* casper-client CLI installed and configured for casper-test chain  
* CSPR.cloud API key (testnet) — required for both MCP server and direct REST calls  
* Casper MCP Server: dotnet tool install \-g CasperMcp (requires .NET 10 SDK) **or** Docker image ghcr.io/msanlisavas/casper-mcp:latest — pick Docker route if avoiding .NET install friction  
* Gemini API key with function-calling enabled model  
* Node.js or Python backend runtime (pick one; confirm Gemini SDK compatibility either way)

## **8\. Open Technical Items to Resolve on Day 1 (do not defer)**

1. Confirm exact Odra API for: native token transfer within a module (self.env().transfer\_tokens or equivalent), event emission macro, and caller() semantics — check odra.dev/docs/basics and advanced sections directly.  
2. Confirm whether casper-client deploy submission \+ result polling is scriptable cleanly from Node/Python (likely yes via subprocess \+ JSON parsing) or whether the Casper JS SDK offers a cleaner native path — pick one before Day 2\.  
3. Decide Docker vs .NET-native install for the Casper MCP Server based on your local environment.

## **9\. Risks Carried from PRD (technical detail added)**

| Risk | Technical Mitigation |
| :---- | :---- |
| MCP server can't execute our custom contract calls | Confirmed — use casper-client/SDK directly for writes; MCP only for reads |
| Deploy revert doesn't neatly return a "reason string" to caller | Must poll GetDeploy execution result and map numeric error codes to messages ourselves |
| Odra transfer/event API details unconfirmed | Resolve on Day 1 against live docs before writing dependent code |
| Associated-key misconfiguration lockout | Test only on throwaway accounts; document exact commands; keep recovery key |

