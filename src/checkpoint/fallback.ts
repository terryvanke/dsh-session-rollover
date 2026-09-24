import type {Agent} from '@deepseek-ai/dsh-agent';
import type {UserMessage} from '@deepseek-ai/dsh-llm';
import type {RolloverConfig} from '../config.js';
import type {Checkpoint} from './schema.js';
import {workspaceState} from '../utils/git.js';
import path from 'node:path';

function textOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const item = value as {content?: readonly {type?: string; text?: string}[]};
  return item.content?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n') ?? '';
}

export async function fallbackCheckpoint(
  agent: Agent, claimed: readonly UserMessage[], config: RolloverConfig,
  ids: {chainId: string; transactionId: string; targetId: string; index: number}, error?: string
): Promise<Checkpoint> {
  const cwd = agent.session.header.cwd ?? process.cwd();
  const work = await workspaceState(cwd, config.checkpoint.includeGitStatus || config.checkpoint.includeFileState);
  const events = agent.session.snapshotEvents();
  const messages = events.filter((event) => event.type === 'user/message').map((event) => textOf(event.data)).filter(Boolean);
  const toolResults = events.filter((event) => event.type === 'tool/result').map((event) => JSON.stringify(event.data).slice(0, 4000));
  const recentMessages = messages.slice(-config.checkpoint.includeRecentMessages);
  const recentToolResults = toolResults.slice(-config.checkpoint.includeToolResults);
  const direct = events.filter((event) => event.type === 'user/message' &&
    (event.data as UserMessage).source.kind === 'user').map((event) => textOf(event.data)).filter(Boolean);
  const originalGoal = direct[0] ?? claimed.map(textOf).filter(Boolean)[0] ?? messages[0] ?? 'Original goal unavailable; inspect the previous session and workspace.';
  const currentGoal = claimed.map(textOf).filter(Boolean).join('\n') || messages.at(-1) || originalGoal;
  const assistant = events.filter((event) => event.type === 'assistant/message').at(-1);
  const current = assistant ? JSON.stringify(assistant.data).slice(0, 6000) : currentGoal;
  const route = agent.session.requestHeader()?.config;
  const nextFile = work.modified[0] ?? work.created[0];
  const nextAction = nextFile ? `Open ${path.join(cwd, nextFile)} and inspect its current contents against the recorded task requirements.` :
    `List the files in ${cwd} to identify the next edit required by the recorded task.`;
  const checkpoint: Checkpoint = {
    version: 1, chainId: ids.chainId, transactionId: ids.transactionId, rolloverIndex: ids.index,
    parentSessionId: String(agent.session.id), newSessionId: ids.targetId, createdAt: new Date().toISOString(),
    task: {originalGoal, currentGoal, status: 'in-progress'},
    workspace: {cwd: work.cwd, branch: work.branch,
      gitStatus: config.checkpoint.includeGitStatus ? work.gitStatus : '',
      diffStat: config.checkpoint.includeGitStatus ? work.diffStat : ''},
    files: {modified: config.checkpoint.includeFileState ? work.modified : [],
      created: config.checkpoint.includeFileState ? work.created : [],
      deleted: config.checkpoint.includeFileState ? work.deleted : []},
    progress: {completed: [], pending: [currentGoal], current}, errors: error ? [error] : [], decisions: [],
    nextAction, recentMessages, recentToolResults,
    runtime: {agentOptions: {...agent.options,
      ...(route?.provider ? {provider: route.provider} : {}),
      ...(route?.model ? {model: route.model} : {}),
      ...(route?.maxTokens ? {maxTokens: route.maxTokens} : {}),
      ...(route?.reasoningEffort ? {reasoningEffort: route.reasoningEffort} : {})},
      agentPreset: agent.session.header.agentPreset}, markdown: ''
  };
  checkpoint.markdown = renderFallback(checkpoint, Math.max(160, Math.floor(config.context.windowTokens * 0.02)));
  return checkpoint;
}

export function renderFallback(c: Checkpoint, maxItemChars = 4000): string {
  const clip = (value: string, limit = maxItemChars) => value.length <= limit ? value :
    `${value.slice(0, limit)}\n[truncated in Markdown; complete value remains in checkpoint.json]`;
  const list = (items: readonly string[]) => items.length ? items.map((item) => `- ${clip(item)}`).join('\n') : '- None recorded';
  return [
    '# Mission', clip(c.task.originalGoal, maxItemChars * 3), '# User Requirements', list(c.recentMessages),
    '# Current Objective', clip(c.task.currentGoal, maxItemChars * 2), '# Completed Work', list(c.progress.completed),
    '# Current Work', clip(c.progress.current, maxItemChars * 2), '# Files and Code',
    `Modified:\n${list(c.files.modified)}\nCreated:\n${list(c.files.created)}\nDeleted:\n${list(c.files.deleted)}`,
    '# Errors and Fixes', list(c.errors), '# Decisions', list(c.decisions),
    '# Pending Jobs', list(c.progress.pending), '# Current TODO', list(c.progress.pending),
    '# Next Action', clip(c.nextAction), '# Critical Context', `Recent tool results:\n${list(c.recentToolResults)}`,
    '# Workspace State', `cwd: ${c.workspace.cwd}\nbranch: ${c.workspace.branch}\ngit status:\n${clip(c.workspace.gitStatus || '(none)')}\ngit diff --stat:\n${clip(c.workspace.diffStat || '(none)')}`
  ].join('\n\n');
}
