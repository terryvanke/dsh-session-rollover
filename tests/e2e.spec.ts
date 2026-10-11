import {afterEach, expect, it, vi} from 'vitest';
import {Context} from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, {LlmAdapter, LlmError, createUserMessage, type GenerateOptions, type StreamChunk} from '@deepseek-ai/dsh-llm';
import SessionStore, {SessionId} from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as rollover from '../src/index.js';
import {fixture, config} from './helpers.js';
import {RolloverManager} from '../src/rollover-manager.js';
import {CheckpointStore} from '../src/storage/store.js';
import {writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));});

it.each([[false, false], [true, false], [false, true], [true, true]])(
  'hands off through the real Harness loop and token meter (overflow=%s, checkpoint=%s)', async (overflow, refine) => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const ctx = new Context(); cleanups.push(async () => {await ctx.fiber.dispose();});
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, ToolRuntime, AgentRegistry])
    await ctx.plugin(plugin);
  await ctx.plugin(AgentLoop, {agents: []});
  await ctx.plugin(TokenMeter);
  const requests: GenerateOptions[] = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider: string, model: string) {
      return {provider, id: model, name: model, context: {contextWindow: 10000}, defaultMaxTokens: 1000};
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options);
      if (overflow && options.sessionId === 'source' && options.purpose !== 'compaction')
        throw new LlmError('prompt too long', 'CONTEXT_WINDOW_EXCEEDED');
      const text = options.purpose === 'compaction' ? options.messages.flatMap(message => message.content)
        .filter(block => block.type === 'text').map(block => block.text).join('\n') : 'continued';
      yield {type: 'block-start', index: 0, blockType: 'text'};
      yield {type: 'text-delta', index: 0, text};
      yield {type: 'block-end', index: 0, block: {type: 'text', text}};
      yield {type: 'finish', reason: {kind: 'stop'}};
    }
  }
  ctx.llm.registerAdapter(['test'], new Adapter());
  const {agent} = await ctx.agents.create({sessionId: SessionId('source'), meta: {cwd: f.cwd},
    agentOptions: {provider: 'test', model: 'tiny', maxTokens: 1000}});
  agent.session.append('user/message', createUserMessage({source: {kind: 'user'},
    content: [{type: 'text', text: 'Continue the task. '.repeat(overflow ? 1 : 5000)}]}), {surfaceOp: 'append'});
  const settings = config(); settings.checkpoint.enabled = refine;
  await ctx.plugin(rollover, settings);
  const steering = createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'Run the tests next.'}]});
  agent.followup(steering);
  await vi.waitFor(() => {
    expect(requests).toHaveLength((overflow ? 2 : 1) + (refine ? 1 : 0));
    expect(ctx.agents.list().every((item) => item.status === 'idle')).toBe(true);
  }, {timeout: 4000});
  const store = new CheckpointStore(path.join(f.cwd, '.dsh', 'rollover'));
  const [chain] = await store.listChains();
  if (refine) expect((await store.loadCheckpoint(chain.chainId, 1))?.errors)
    .toEqual(overflow ? ['CONTEXT_WINDOW_EXCEEDED: prompt too long'] : []);
  expect(chain.transaction?.status).toBe('COMPLETED');
  expect(chain.sessions).toHaveLength(2);
  const continued = requests.at(-1)!;
  expect(continued.sessionId).toBe(chain.activeSessionId);
  if (!overflow) expect(continued.messages.some((message) => message.id === steering.id)).toBe(true);
  expect(JSON.stringify(continued.messages)).toContain('<checkpoint>');
  expect(JSON.stringify(continued.messages)).toContain('Run the tests next.');
  expect(ctx.agents.get(SessionId(chain.activeSessionId))?.session.header.cwd).toBe(f.cwd);
  expect(agent.session.snapshotEvents().some((event) => event.type === 'assistant/message')).toBe(false);
});

it('continues a simulated coding task across A → B → C → D with workspace edits intact', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const log = vi.spyOn(f.ctx.logger, 'info');
  const settings = config();
  const manager = new RolloverManager(f.ctx, settings);
  const {agent: a} = f.makeAgent('A', 'Create task.txt, update it, test contents, and fix errors');
  await writeFile(path.join(f.cwd, 'task.txt'), 'created\n');
  expect(await manager.rollover(a)).toBe(true);
  const b = f.agents.get(manager.successor('A')!)!;
  await writeFile(path.join(f.cwd, 'task.txt'), 'created\nmodified\n');
  expect(await manager.rollover(b)).toBe(true);
  const c = f.agents.get(manager.successor(String(b.session.id))!)!;
  expect(c).toBeDefined();
  await writeFile(path.join(f.cwd, 'task.txt'), 'created\nmodified\ntests passed\n');
  expect(await manager.rollover(c), JSON.stringify(log.mock.calls)).toBe(true);
  expect(f.agents.get(manager.successor(String(c.session.id))!)).toBeDefined();
  expect(await readFile(path.join(f.cwd, 'task.txt'), 'utf8')).toBe('created\nmodified\ntests passed\n');
  const store = new CheckpointStore(path.join(f.cwd, '.dsh', 'rollover'));
  const [chain] = await store.listChains();
  expect(chain.sessions).toHaveLength(4);
  expect(chain.rolloverCount).toBe(3);
  expect(await store.loadCheckpoint(chain.chainId, 3)).toBeDefined();
});
