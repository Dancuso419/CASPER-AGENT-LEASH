// Gemini reasoning layer. The agent is given two tools; Gemini decides which to call
// from a natural-language instruction. The backend then executes the chosen tool
// on-chain (see server.js), where the contract enforces the leash.
import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

const ai = config.geminiApiKey ? new GoogleGenAI({ apiKey: config.geminiApiKey }) : null;

const tools = [
  {
    functionDeclarations: [
      {
        name: 'attempt_transfer',
        description:
          "Attempt to send CSPR from the agent's scope to a recipient. Subject to the " +
          "agent's on-chain spending cap and active status — the contract may block it.",
        parametersJsonSchema: {
          type: 'object',
          properties: {
            recipient: {
              type: 'string',
              description:
                'Recipient account. Use "owner" for the owner account, or a full account-hash-... string.',
            },
            amount_cspr: { type: 'number', description: 'Amount to send, in CSPR.' },
          },
          required: ['recipient', 'amount_cspr'],
        },
      },
      {
        name: 'check_status',
        description: "Check the agent's current identity, spending cap and active status.",
        parametersJsonSchema: { type: 'object', properties: {} },
      },
    ],
  },
];

const SYSTEM = `You are an autonomous payment agent operating under a "leash" — an on-chain
contract that enforces a spending cap and can revoke you. When the user asks you to move
funds, call attempt_transfer. When they ask about your permissions or status, call
check_status. Do not refuse based on the cap yourself; the contract enforces it on-chain.`;

// Returns { text, call: { name, args } | null }.
export async function reason(userMessage) {
  if (!ai) throw new Error('GEMINI_API_KEY is not set');
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: userMessage,
    config: { systemInstruction: SYSTEM, tools },
  });
  const calls = response.functionCalls || [];
  return {
    text: response.text || '',
    call: calls[0] ? { name: calls[0].name, args: calls[0].args || {} } : null,
  };
}

export const geminiEnabled = () => Boolean(ai);
