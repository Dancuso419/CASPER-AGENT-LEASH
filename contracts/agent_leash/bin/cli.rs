//! Livenet CLI for the AgentLeash contract: deploys it to the configured network
//! (testnet via .env) and exposes its entry points as subcommands.

use agent_leash::agent_leash::AgentLeash;
use odra::host::{HostEnv, NoArgs};
use odra_cli::{
    deploy::DeployScript, ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};

pub struct AgentLeashDeployScript;

impl DeployScript for AgentLeashDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        let _leash = AgentLeash::load_or_deploy(
            env,
            NoArgs,
            container,
            350_000_000_000, // 350 CSPR gas budget for the wasm install
        )?;
        Ok(())
    }
}

pub fn main() {
    OdraCli::new()
        .about("CLI tool for the AgentLeash contract (Casper Agent Leash)")
        .deploy(AgentLeashDeployScript)
        .contract::<AgentLeash>()
        .build()
        .run();
}
