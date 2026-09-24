import {afterEach, expect, it} from 'vitest';
import {fixture, config} from './helpers.js';
import {RolloverManager} from '../src/rollover-manager.js';
import {CheckpointStore} from '../src/storage/store.js';
import {writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));});

it('continues a simulated coding task across A → B → C → D with workspace edits intact', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
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
  expect(await manager.rollover(c)).toBe(true);
  expect(f.agents.get(manager.successor(String(c.session.id))!)).toBeDefined();
  expect(await readFile(path.join(f.cwd, 'task.txt'), 'utf8')).toBe('created\nmodified\ntests passed\n');
  const store = new CheckpointStore(path.join(f.cwd, '.dsh', 'rollover'));
  const [chain] = await store.listChains();
  expect(chain.sessions).toHaveLength(4);
  expect(chain.rolloverCount).toBe(3);
  expect(await store.loadCheckpoint(chain.chainId, 3)).toBeDefined();
});
