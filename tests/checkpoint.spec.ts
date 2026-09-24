import {afterEach, describe, expect, it} from 'vitest';
import {fixture, config} from './helpers.js';
import {fallbackCheckpoint} from '../src/checkpoint/fallback.js';
import {generateCheckpoint} from '../src/checkpoint/generator.js';
import {CheckpointStore} from '../src/storage/store.js';
import path from 'node:path';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));});

describe('checkpoint', () => {
  it('writes both files and preserves task, path and next action', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const agent = f.makeAgent('A').agent;
    const checkpoint = await fallbackCheckpoint(agent, [], config(),
      {chainId: 'chain', transactionId: 'tx', targetId: 'B', index: 1});
    expect(checkpoint.markdown).toContain('# Next Action');
    expect(checkpoint.markdown).toContain(f.cwd);
    expect(checkpoint.task.originalGoal).toContain('Create files');
    const store = new CheckpointStore(path.join(f.cwd, '.dsh', 'rollover'));
    await store.saveCheckpoint(checkpoint);
    expect(await store.loadCheckpoint('chain', 1)).toMatchObject({transactionId: 'tx', nextAction: checkpoint.nextAction});
  });
  it('uses a deterministic checkpoint when the LLM request fails', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const agent = f.makeAgent('A').agent;
    const settings = config(); settings.checkpoint.enabled = true;
    const ctx = {...f.ctx, llm: {stream: async function* () {throw new Error('prompt too long');}}} as typeof f.ctx;
    const checkpoint = await generateCheckpoint(ctx, agent, [], settings,
      {chainId: 'chain', transactionId: 'tx', targetId: 'B', index: 1});
    expect(checkpoint.errors.join(' ')).toContain('prompt too long');
    expect(checkpoint.nextAction).toContain(f.cwd);
  });
  it('keeps full JSON facts while bounding model-facing Markdown for a small window', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const goal = 'task '.repeat(10000);
    const agent = f.makeAgent('A', goal).agent;
    const checkpoint = await fallbackCheckpoint(agent, [], config(),
      {chainId: 'chain', transactionId: 'tx', targetId: 'B', index: 1});
    expect(checkpoint.task.originalGoal).toBe(goal);
    expect(checkpoint.markdown.length).toBeLessThan(goal.length);
    expect(checkpoint.markdown).toContain('complete value remains in checkpoint.json');
  });
});
