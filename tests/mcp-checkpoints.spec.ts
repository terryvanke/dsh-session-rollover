import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortableCheckpoints, renderRecord} from '../src/mcp/checkpoints.js';
import {handoffPrompt} from '../src/checkpoint/handoff.js';
import * as git from '../src/utils/git.js';

const directories: string[] = [];
async function workspace() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'rollover-mcp-'));
  directories.push(cwd);
  return {cwd, store: await PortableCheckpoints.open(cwd)};
}
afterEach(async () => {await Promise.all(directories.splice(0).map((cwd) => rm(cwd, {recursive: true, force: true})));});
const task = {originalGoal: '修复登录问题，保留原来的接口', currentGoal: 'Verify the login fix',
  currentWork: 'Implementation done; tests pending', nextAction: 'Run the existing login tests',
  requirements: ['Do not change the API'], completed: ['Fixed login'], pending: ['Run tests']};

describe('portable checkpoints', () => {
  it('preserves complete facts across restarts, bounded handoffs, and completed tasks', async () => {
    const {cwd, store} = await workspace();
    const largeGoal = '用户要求 '.repeat(1500);
    const first = await store.save({...task, originalGoal: largeGoal});
    const restarted = await PortableCheckpoints.open(cwd);
    expect(await restarted.load(first.taskId)).toEqual(first);
    const handoff = handoffPrompt(renderRecord(first));
    expect(handoff).toContain('current user');
    expect(handoff).toContain('filesystem is the source of truth');
    expect(handoff).toContain('# Next Action');
    expect(handoff).toContain(`${first.taskId}.${first.checkpointId}.json`);
    expect(handoff).not.toContain(largeGoal);
    const completed = await restarted.save({...task, taskId: first.taskId, originalGoal: largeGoal,
      status: 'completed', currentWork: 'Tests passed', nextAction: 'Task completed', pending: []});
    expect((await restarted.list())[0]).toEqual(completed);
    expect(await restarted.load(first.taskId, first.checkpointId)).toEqual(first);
    expect(renderRecord(completed)).toContain('Status: completed');
  });
  it('keeps simultaneous saves by different clients without overwriting snapshots or project files', async () => {
    const {cwd, store} = await workspace();
    await writeFile(path.join(cwd, 'source.txt'), 'must remain unchanged');
    const first = await store.save(task);
    const other = await PortableCheckpoints.open(cwd);
    const [a, b] = await Promise.all([
      store.save({...task, taskId: first.taskId, nextAction: 'Client A next step'}),
      other.save({...task, taskId: first.taskId, nextAction: 'Client B next step'})
    ]);
    expect(a.checkpointId).not.toBe(b.checkpointId);
    expect((await store.snapshots(first.taskId))).toHaveLength(3);
    expect((await store.load(first.taskId, a.checkpointId)).nextAction).toBe('Client A next step');
    expect((await store.load(first.taskId, b.checkpointId)).nextAction).toBe('Client B next step');
    expect(await readFile(path.join(cwd, 'source.txt'), 'utf8')).toBe('must remain unchanged');
    expect((await readdir(store.root)).filter((file) => file.endsWith('.md'))).toHaveLength(3);
  });
  it('rejects traversal, unknown tasks, oversized facts, and accidental changes to the original goal', async () => {
    const {store} = await workspace();
    expect(await store.list()).toEqual([]);
    await expect(store.load('../outside')).rejects.toThrow();
    await expect(store.save({...task, taskId: randomUUID()})).rejects.toThrow('not found');
    await expect(store.save({...task, originalGoal: 'x'.repeat(12001)})).rejects.toThrow();
    const first = await store.save(task);
    await expect(store.save({...task, taskId: first.taskId, originalGoal: 'A different task'})).rejects.toThrow('originalGoal');
    expect(await store.load(first.taskId)).toEqual(first);
  });
  it('rejects a storage directory redirected outside the workspace', async () => {
    const {store} = await workspace();
    const outside = await workspace();
    await symlink(outside.cwd, store.root, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await expect(store.save(task)).rejects.toThrow('real directory');
      await expect(store.list()).rejects.toThrow('real directory');
      expect(await readdir(outside.cwd)).toEqual([]);
    } finally { await unlink(store.root); }
  });
  it('ignores an uncommitted Markdown file and reports a corrupted committed snapshot', async () => {
    const {store} = await workspace();
    const first = await store.save(task);
    await writeFile(path.join(store.root, `${first.taskId}.${randomUUID()}.md`), 'uncommitted');
    expect(await store.list()).toEqual([first]);
    await writeFile(path.join(store.root, `${first.taskId}.${first.checkpointId}.json`), '{}');
    await expect(store.list()).rejects.toThrow();
    await expect(store.save({...task, taskId: first.taskId})).rejects.toThrow();
  });
  it('rejects an oversized snapshot before writing an unreadable checkpoint', async () => {
    const {cwd, store} = await workspace();
    const capture = vi.spyOn(git, 'workspaceState').mockResolvedValue({cwd, branch: '', diffStat: '',
      gitStatus: 'x'.repeat(4 * 1024 * 1024), modified: [], created: [], deleted: []});
    try {
      await expect(store.save(task)).rejects.toThrow('storage limit');
      expect(await store.list()).toEqual([]);
    } finally { capture.mockRestore(); }
  });
});
