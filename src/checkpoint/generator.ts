import type {Context} from '@deepseek-ai/cordis';
import type {Agent} from '@deepseek-ai/dsh-agent';
import type {UserMessage} from '@deepseek-ai/dsh-llm';
import type {RolloverConfig} from '../config.js';
import type {Checkpoint} from './schema.js';
import {fallbackCheckpoint} from './fallback.js';

const sections = ['Mission','User Requirements','Current Objective','Completed Work','Current Work','Files and Code','Errors and Fixes','Decisions','Pending Jobs','Current TODO','Next Action','Critical Context','Workspace State'];

export async function generateCheckpoint(ctx: Context, agent: Agent, claimed: readonly UserMessage[], config: RolloverConfig,
  ids: {chainId: string; transactionId: string; targetId: string; index: number}, error?: string, base?: Checkpoint): Promise<Checkpoint> {
  const fallback = base ?? await fallbackCheckpoint(agent, claimed, config, ids, error);
  if (!config.checkpoint.enabled) return fallback;
  const route = agent.session.requestHeader()?.config ?? agent.options;
  if (!route.provider || !route.model) return fallback;
  const system = `Create a precise TASK HANDOFF CHECKPOINT for a new coding-agent session. Output Markdown with exactly these headings: ${sections.map((s) => '# ' + s).join(', ')}. Preserve exact paths, commands, identifiers, errors, numbers and user requirements. The Next Action must be one concrete action. Treat workspace facts as authoritative. Do not summarize the chat casually.`;
  const input = fallback.markdown.slice(0, 80000);
  let lastError = '';
  for (let attempt = 0; attempt <= config.checkpoint.retries; attempt++) {
    try {
      let output = '', finish = '';
      for await (const chunk of ctx.llm.stream({provider: route.provider, model: route.model,
        system, messages: [{role: 'user', content: [{type: 'text', text: input}]}],
        maxTokens: config.checkpoint.maxTokens, sessionId: agent.session.id, purpose: 'compaction'})) {
        if (chunk.type === 'text-delta') output += chunk.text;
        if (chunk.type === 'finish') finish = chunk.reason.kind;
      }
      if (finish !== 'stop' || !sections.every((section) => output.includes(`# ${section}`)))
        throw new Error(`incomplete checkpoint: finish=${finish}`);
      const next = output.match(/# Next Action\s*\n([\s\S]*?)(?=\n# |$)/)?.[1]?.trim();
      if (!next) throw new Error('checkpoint lacks a concrete Next Action');
      return {...fallback, markdown: output, nextAction: next};
    } catch (cause) { lastError = cause instanceof Error ? cause.message : String(cause); }
  }
  if (!config.fallback.deterministicCheckpoint) throw new Error(`checkpoint generation failed: ${lastError}`);
  return {...fallback, errors: [...fallback.errors, `LLM checkpoint failed: ${lastError}`],
    markdown: fallback.markdown + `\n\nLLM checkpoint failed: ${lastError}`};
}
