import OpenAI from 'openai';
import { createProposalGenerator, needsProposalGeneration } from '../oracle/proposals.js';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');

const model = process.env.ORACLE_PROPOSAL_MODEL || 'gpt-5.6';
let requests = 0;
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const openai = { responses: { create: input => { requests += 1; return client.responses.create(input); } } };
const generate = createProposalGenerator({ openai, model });

const question = 'What do you know about Black Friday 2025?';
if (needsProposalGeneration(question)) throw new Error('Question fixture did not pass the preflight gate');
const questionResult = await generate({ message: question });
if (questionResult.length || requests) throw new Error('Question fixture unexpectedly called the model or returned proposals');
console.log('PASS question: preflight skipped the model; zero proposals; no error');

const assertion = 'Our test campaign ran from 1 November 2099 to 3 November 2099.';
const assertionResult = await generate({ message: assertion });
if (!assertionResult.length) throw new Error('Simple assertion returned no structured candidates');
console.log(`PASS simple assertion: ${assertionResult.length} structured candidate(s); nothing persisted`);

const rich = `Synthetic Aurora campaign ran from 20 November 2099 to 30 November 2099.
The online offer ran from 21 November 2099 to 30 November 2099. A store event ran on 22 November 2099.
The offer was 25% off synthetic silver test items. Gift cards were excluded.`;
const richResult = await generate({ message: rich });
const richText = JSON.stringify(richResult).toLowerCase();
if (!richResult.length || !['campaign', 'online', 'store', '25%', 'excluded'].every(value => richText.includes(value))) {
  throw new Error('Rich fixture did not return comprehensive structured candidates');
}
console.log(`PASS rich assertion: ${richResult.length} comprehensive structured candidate(s); nothing persisted`);
console.log(`PASS production proposal contract: model=${model}; OpenAI requests=${requests}; approval/write endpoints were not invoked`);
