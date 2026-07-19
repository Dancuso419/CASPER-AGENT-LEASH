//! Casper Agent Leash — on-chain identity + enforced spending permissions for AI agents.
//!
//! An owner registers an agent (identified by its account `Address`) with a per-transaction
//! spending cap and an allowed action type. The agent then calls `check_and_execute` to spend;
//! the contract enforces the cap and active-flag on-chain, transferring CSPR from the contract's
//! own purse only when the request is compliant. A blocked request reverts the deploy with a
//! specific error code (surfaced to the dashboard via the deploy execution result — note that a
//! revert rolls back state, so blocked actions deliberately emit NO event; only allowed actions do).
//!
//! API verified against Odra 2.8.2 source (see CONSTRAINTS.md / CLAUDE.md changelog):
//!   caller() -> Address, transfer_tokens(&self, &Address, &U512), emit_event, get_block_time() -> u64.

use odra::casper_types::U512;
use odra::prelude::*;

/// One agent's identity + permission rule.
#[odra::odra_type]
pub struct AgentRecord {
    /// The human/org account that owns and controls this agent.
    pub owner: Address,
    /// Maximum CSPR (motes) the agent may move in a single `check_and_execute` call.
    pub spending_cap: U512,
    /// What kind of action the agent is permitted to perform.
    pub allowed_action: ActionType,
    /// False once the owner has revoked the agent.
    pub is_active: bool,
    /// Block time (ms) at registration.
    pub created_at: u64,
}

/// Allowed action kinds. MVP supports transfers only; enum leaves room to widen later.
#[odra::odra_type]
pub enum ActionType {
    TransferOnly,
}

/// Emitted only for a permitted, executed action (blocked actions revert and emit nothing).
#[odra::event]
pub struct ActionAllowed {
    pub agent: Address,
    pub amount: U512,
    pub recipient: Address,
}

#[odra::event]
pub struct AgentRegistered {
    pub agent: Address,
    pub owner: Address,
    pub spending_cap: U512,
}

#[odra::event]
pub struct AgentRevoked {
    pub agent: Address,
}

#[odra::event]
pub struct AgentReactivated {
    pub agent: Address,
}

#[odra::event]
pub struct CapUpdated {
    pub agent: Address,
    pub spending_cap: U512,
}

/// Contract error codes. Numbers are stable — the backend maps them to human messages.
#[odra::odra_error]
pub enum Error {
    AlreadyRegistered = 1,
    NotOwner = 2,
    AgentNotFound = 3,
    Revoked = 4,
    ExceedsCap = 5,
    ActionNotAllowed = 6,
}

#[odra::module]
pub struct AgentLeash {
    agents: Mapping<Address, AgentRecord>,
}

#[odra::module]
impl AgentLeash {
    /// No global state to initialize; the agents mapping starts empty.
    pub fn init(&mut self) {}

    /// Owner registers a new agent. Caller becomes the owner. Reverts if already registered.
    pub fn register_agent(
        &mut self,
        agent: Address,
        spending_cap: U512,
        allowed_action: ActionType,
    ) {
        if self.agents.get(&agent).is_some() {
            self.env().revert(Error::AlreadyRegistered);
        }
        let owner = self.env().caller();
        self.agents.set(
            &agent,
            AgentRecord {
                owner,
                spending_cap,
                allowed_action,
                is_active: true,
                created_at: self.env().get_block_time(),
            },
        );
        self.env().emit_event(AgentRegistered {
            agent,
            owner,
            spending_cap,
        });
    }

    /// The agent (identified by `caller()`) attempts to transfer `amount` motes to `recipient`.
    /// Funds move from the contract's own purse. Reverts (no event) if the agent is unknown,
    /// revoked, not permitted for transfers, or the amount exceeds its cap.
    pub fn check_and_execute(&mut self, amount: U512, recipient: Address) {
        let agent = self.env().caller();
        let record = self
            .agents
            .get(&agent)
            .unwrap_or_revert_with(self, Error::AgentNotFound);

        if !record.is_active {
            self.env().revert(Error::Revoked);
        }
        // MVP: only TransferOnly exists; guard anyway so widening the enum stays safe.
        match record.allowed_action {
            ActionType::TransferOnly => {}
        }
        if amount > record.spending_cap {
            self.env().revert(Error::ExceedsCap);
        }

        self.env().transfer_tokens(&recipient, &amount);
        self.env().emit_event(ActionAllowed {
            agent,
            amount,
            recipient,
        });
    }

    /// Owner-only. Change an agent's per-transaction spending cap. The agent itself can never
    /// call this (only the registering owner), so an agent cannot loosen its own leash.
    pub fn update_cap(&mut self, agent: Address, new_cap: U512) {
        let mut record = self
            .agents
            .get(&agent)
            .unwrap_or_revert_with(self, Error::AgentNotFound);
        if self.env().caller() != record.owner {
            self.env().revert(Error::NotOwner);
        }
        record.spending_cap = new_cap;
        self.agents.set(&agent, record);
        self.env().emit_event(CapUpdated {
            agent,
            spending_cap: new_cap,
        });
    }

    /// Owner-only. Marks the agent revoked; subsequent actions are rejected.
    pub fn revoke_agent(&mut self, agent: Address) {
        let mut record = self
            .agents
            .get(&agent)
            .unwrap_or_revert_with(self, Error::AgentNotFound);
        if self.env().caller() != record.owner {
            self.env().revert(Error::NotOwner);
        }
        record.is_active = false;
        self.agents.set(&agent, record);
        self.env().emit_event(AgentRevoked { agent });
    }

    /// Owner-only. Reverses a revocation, marking the agent active again so it can act.
    pub fn reactivate_agent(&mut self, agent: Address) {
        let mut record = self
            .agents
            .get(&agent)
            .unwrap_or_revert_with(self, Error::AgentNotFound);
        if self.env().caller() != record.owner {
            self.env().revert(Error::NotOwner);
        }
        record.is_active = true;
        self.agents.set(&agent, record);
        self.env().emit_event(AgentReactivated { agent });
    }

    /// Read-only identity + rule lookup for the dashboard.
    pub fn get_agent_status(&self, agent: Address) -> AgentRecord {
        self.agents
            .get(&agent)
            .unwrap_or_revert_with(self, Error::AgentNotFound)
    }

    /// Payable: fund the contract purse so agents have CSPR to spend. Attached value is
    /// captured automatically for payable entrypoints.
    #[odra(payable)]
    pub fn deposit(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostRef, NoArgs};

    fn setup() -> (odra::host::HostEnv, AgentLeashHostRef, Address, Address) {
        let env = odra_test::env();
        let contract = AgentLeash::deploy(&env, NoArgs);
        let owner = env.get_account(0);
        let agent = env.get_account(1);
        (env, contract, owner, agent)
    }

    #[test]
    fn register_and_status() {
        let (env, mut contract, owner, agent) = setup();
        env.set_caller(owner);
        contract.register_agent(agent, U512::from(10), ActionType::TransferOnly);

        let rec = contract.get_agent_status(agent);
        assert_eq!(rec.owner, owner);
        assert_eq!(rec.spending_cap, U512::from(10));
        assert!(rec.is_active);
    }

    #[test]
    fn duplicate_registration_reverts() {
        let (env, mut contract, owner, agent) = setup();
        env.set_caller(owner);
        contract.register_agent(agent, U512::from(10), ActionType::TransferOnly);
        let res = contract.try_register_agent(agent, U512::from(5), ActionType::TransferOnly);
        assert_eq!(res, Err(Error::AlreadyRegistered.into()));
    }

    #[test]
    fn status_of_unknown_agent_reverts() {
        let (_env, contract, _owner, agent) = setup();
        assert_eq!(
            contract.try_get_agent_status(agent),
            Err(Error::AgentNotFound.into())
        );
    }

    #[test]
    fn compliant_transfer_moves_funds() {
        let (env, mut contract, owner, agent) = setup();
        let recipient = env.get_account(2);

        env.set_caller(owner);
        contract.register_agent(agent, U512::from(1_000), ActionType::TransferOnly);
        // Fund the contract purse.
        env.set_caller(owner);
        contract.with_tokens(U512::from(1_000)).deposit();

        let before = env.balance_of(&recipient);
        env.set_caller(agent);
        contract.check_and_execute(U512::from(400), recipient);
        let after = env.balance_of(&recipient);

        assert_eq!(after - before, U512::from(400));
    }

    #[test]
    fn over_cap_transfer_reverts_and_moves_nothing() {
        let (env, mut contract, owner, agent) = setup();
        let recipient = env.get_account(2);

        env.set_caller(owner);
        contract.register_agent(agent, U512::from(10), ActionType::TransferOnly);
        env.set_caller(owner);
        contract.with_tokens(U512::from(1_000)).deposit();

        let before = env.balance_of(&recipient);
        env.set_caller(agent);
        let res = contract.try_check_and_execute(U512::from(50), recipient);
        assert_eq!(res, Err(Error::ExceedsCap.into()));
        assert_eq!(env.balance_of(&recipient), before, "no funds should move");
    }

    #[test]
    fn revoked_agent_cannot_act() {
        let (env, mut contract, owner, agent) = setup();
        let recipient = env.get_account(2);

        env.set_caller(owner);
        contract.register_agent(agent, U512::from(1_000), ActionType::TransferOnly);
        env.set_caller(owner);
        contract.with_tokens(U512::from(1_000)).deposit();

        env.set_caller(owner);
        contract.revoke_agent(agent);

        env.set_caller(agent);
        let res = contract.try_check_and_execute(U512::from(100), recipient);
        assert_eq!(res, Err(Error::Revoked.into()));
    }

    #[test]
    fn owner_can_update_cap() {
        let (env, mut contract, owner, agent) = setup();
        env.set_caller(owner);
        contract.register_agent(agent, U512::from(10), ActionType::TransferOnly);

        env.set_caller(owner);
        contract.update_cap(agent, U512::from(500));

        assert_eq!(contract.get_agent_status(agent).spending_cap, U512::from(500));
    }

    #[test]
    fn updated_cap_is_enforced() {
        let (env, mut contract, owner, agent) = setup();
        let recipient = env.get_account(2);

        env.set_caller(owner);
        contract.register_agent(agent, U512::from(10), ActionType::TransferOnly);
        env.set_caller(owner);
        contract.with_tokens(U512::from(1_000)).deposit();

        // 50 exceeds the initial cap of 10.
        env.set_caller(agent);
        assert_eq!(
            contract.try_check_and_execute(U512::from(50), recipient),
            Err(Error::ExceedsCap.into())
        );

        // Owner raises the cap to 100; the same 50 now goes through.
        env.set_caller(owner);
        contract.update_cap(agent, U512::from(100));
        let before = env.balance_of(&recipient);
        env.set_caller(agent);
        contract.check_and_execute(U512::from(50), recipient);
        assert_eq!(env.balance_of(&recipient) - before, U512::from(50));
    }

    #[test]
    fn reactivate_restores_ability_to_act() {
        let (env, mut contract, owner, agent) = setup();
        let recipient = env.get_account(2);

        env.set_caller(owner);
        contract.register_agent(agent, U512::from(1_000), ActionType::TransferOnly);
        env.set_caller(owner);
        contract.with_tokens(U512::from(1_000)).deposit();

        // Revoke → blocked.
        env.set_caller(owner);
        contract.revoke_agent(agent);
        env.set_caller(agent);
        assert_eq!(
            contract.try_check_and_execute(U512::from(100), recipient),
            Err(Error::Revoked.into())
        );

        // Reactivate → the same transfer now goes through.
        env.set_caller(owner);
        contract.reactivate_agent(agent);
        assert!(contract.get_agent_status(agent).is_active);
        let before = env.balance_of(&recipient);
        env.set_caller(agent);
        contract.check_and_execute(U512::from(100), recipient);
        assert_eq!(env.balance_of(&recipient) - before, U512::from(100));
    }

    #[test]
    fn non_owner_cannot_reactivate() {
        let (env, mut contract, owner, agent) = setup();
        let stranger = env.get_account(3);

        env.set_caller(owner);
        contract.register_agent(agent, U512::from(10), ActionType::TransferOnly);
        env.set_caller(owner);
        contract.revoke_agent(agent);

        env.set_caller(stranger);
        assert_eq!(
            contract.try_reactivate_agent(agent),
            Err(Error::NotOwner.into())
        );
    }

    #[test]
    fn reactivate_unknown_agent_reverts() {
        let (_env, mut contract, _owner, agent) = setup();
        assert_eq!(
            contract.try_reactivate_agent(agent),
            Err(Error::AgentNotFound.into())
        );
    }

    #[test]
    fn non_owner_cannot_update_cap() {
        let (env, mut contract, owner, agent) = setup();
        let stranger = env.get_account(3);

        env.set_caller(owner);
        contract.register_agent(agent, U512::from(10), ActionType::TransferOnly);

        env.set_caller(stranger);
        assert_eq!(
            contract.try_update_cap(agent, U512::from(999)),
            Err(Error::NotOwner.into())
        );
    }

    #[test]
    fn update_cap_unknown_agent_reverts() {
        let (_env, mut contract, _owner, agent) = setup();
        assert_eq!(
            contract.try_update_cap(agent, U512::from(5)),
            Err(Error::AgentNotFound.into())
        );
    }

    #[test]
    fn non_owner_cannot_revoke() {
        let (env, mut contract, owner, agent) = setup();
        let stranger = env.get_account(3);

        env.set_caller(owner);
        contract.register_agent(agent, U512::from(10), ActionType::TransferOnly);

        env.set_caller(stranger);
        assert_eq!(
            contract.try_revoke_agent(agent),
            Err(Error::NotOwner.into())
        );
    }

    #[test]
    fn unknown_agent_cannot_act() {
        let (env, mut contract, _owner, agent) = setup();
        let recipient = env.get_account(2);
        env.set_caller(agent);
        assert_eq!(
            contract.try_check_and_execute(U512::from(1), recipient),
            Err(Error::AgentNotFound.into())
        );
    }
}
