// Dead-simple JSON-file store. All state changes flow through the backend, so this
// stays in sync with chain for the demo. ponytail: a file, not a database — swap for
// on-chain reads (get_agent_status) if multi-writer truth is ever needed.
import fs from 'node:fs';

const DB = process.env.STORE_PATH || '/tmp/leash-data.json';

const empty = { agents: {}, log: [] };

function read() {
  try {
    return JSON.parse(fs.readFileSync(DB, 'utf8'));
  } catch {
    return structuredClone(empty);
  }
}

function write(db) {
  fs.writeFileSync(DB, JSON.stringify(db, null, 2));
}

export function upsertAgent(agentHash, fields) {
  const db = read();
  db.agents[agentHash] = { ...(db.agents[agentHash] || {}), ...fields };
  write(db);
  return db.agents[agentHash];
}

export function getAgent(agentHash) {
  return read().agents[agentHash] || null;
}

export function listAgents() {
  return read().agents;
}

export function addLog(entry) {
  const db = read();
  const row = { ts: Date.now(), ...entry };
  db.log.unshift(row); // newest first
  write(db);
  return row;
}

export function getLog() {
  return read().log;
}
