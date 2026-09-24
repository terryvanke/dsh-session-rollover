import {afterEach, expect, it} from 'vitest';
import {fixture, config} from './helpers.js';
import {fallbackCheckpoint} from '../src/checkpoint/fallback.js';
import {CheckpointStore} from '../src/storage/store.js';
import {RolloverManager} from '../src/rollover-manager.js';
import path from 'node:path';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));});

it('resumes a checkpoint transaction exactly once after a crash', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const {agent} = f.makeAgent('A');
  const store = new CheckpointStore(path.join(f.cwd, '.dsh', 'rollover'));
  const checkpoint = await fallbackCheckpoint(agent, [], config(),
    {chainId: 'chain', transactionId: 'tx', targetId: 'B', index: 1});
  await store.saveCheckpoint(checkpoint);
  await store.saveChain({chainId: 'chain', rootSessionId: 'A', activeSessionId: 'A', sessions: ['A'],
    rolloverCount: 0, taskStatus: 'in-progress', createdAt: checkpoint.createdAt, updatedAt: checkpoint.createdAt,
    workspaceCwd: f.cwd, transaction: {id: 'tx', sourceSessionId: 'A', targetSessionId: 'B', status: 'ROLLOVER_PENDING', checkpointIndex: 1}});
  const manager = new RolloverManager(f.ctx, config());
  await manager.recoverWorkspace(f.cwd);
  await manager.recoverWorkspace(f.cwd);
  expect(f.calls.create).toBe(1);
  expect((await store.loadChain('chain'))?.sessions).toEqual(['A', 'B']);
});
