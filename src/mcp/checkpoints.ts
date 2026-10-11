import {randomUUID} from 'node:crypto';
import {lstat, mkdir, readFile, readdir, realpath} from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import type {Checkpoint} from '../checkpoint/schema.js';
import {renderFallback} from '../checkpoint/fallback.js';
import {atomicWrite} from '../storage/store.js';
import {workspaceState} from '../utils/git.js';

const text = z.string().trim().min(1).max(12000);
const items = z.array(z.string().max(2000)).max(12).default([]);
export const saveSchema = z.object({
  taskId: z.uuid().optional().describe('Omit for a new task; reuse the returned ID for later snapshots.'),
  originalGoal: text.describe('The original user request, preserved unchanged across snapshots.'),
  currentGoal: text,
  currentWork: text,
  nextAction: text.describe('One concrete next step, or a completion note when status is completed.'),
  status: z.enum(['in-progress', 'completed']).default('in-progress'),
  requirements: items.describe('User requirements and constraints; never include credentials.'),
  completed: items, pending: items, errors: items, decisions: items
}).strict();

const recordSchema = saveSchema.extend({
  version: z.literal(1), taskId: z.uuid(), checkpointId: z.uuid(), createdAt: z.iso.datetime(),
  workspace: z.object({cwd: z.string(), branch: z.string(), gitStatus: z.string(), diffStat: z.string(),
    modified: z.array(z.string()), created: z.array(z.string()), deleted: z.array(z.string())})
});
type Record = z.infer<typeof recordSchema>;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const snapshotName = new RegExp(`^${uuid}\\.${uuid}\\.json$`, 'i');

function checkpoint(record: Record): Checkpoint {
  return {
    version: 1, chainId: record.taskId, transactionId: record.checkpointId, rolloverIndex: 0,
    parentSessionId: '', newSessionId: '', createdAt: record.createdAt,
    task: {originalGoal: record.originalGoal, currentGoal: record.currentGoal, status: record.status},
    workspace: record.workspace,
    files: {modified: record.workspace.modified, created: record.workspace.created, deleted: record.workspace.deleted},
    progress: {completed: record.completed, pending: record.pending, current: record.currentWork},
    errors: record.errors, decisions: record.decisions, nextAction: record.nextAction,
    runtime: {agentOptions: {}}, recentMessages: record.requirements, recentToolResults: [], markdown: ''
  };
}

export function renderRecord(record: Record): string {
  return `Task ID: ${record.taskId}\nCheckpoint ID: ${record.checkpointId}\nStatus: ${record.status}\nSaved: ${record.createdAt}\n\n` +
    renderFallback(checkpoint(record), 600).replaceAll('checkpoint.json', `${record.taskId}.${record.checkpointId}.json`);
}

export class PortableCheckpoints {
  readonly root: string;
  private constructor(readonly workspace: string) {
    this.root = path.join(workspace, '.session-rollover');
  }
  static async open(workspace: string): Promise<PortableCheckpoints> {
    const resolved = await realpath(workspace);
    if (!(await lstat(resolved)).isDirectory()) throw new Error('Workspace must be an existing directory.');
    return new PortableCheckpoints(resolved);
  }
  private async checkRoot(create = false): Promise<boolean> {
    if (create) await mkdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    try {
      const info = await lstat(this.root);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.root) !== this.root)
        throw new Error('Checkpoint storage must be a real directory inside the configured workspace.');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  private async read(name: string): Promise<Record> {
    const file = path.join(this.root, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
      throw new Error(`Invalid checkpoint file: ${name}`);
    const record = recordSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    if (`${record.taskId}.${record.checkpointId}.json` !== name || record.workspace.cwd !== this.workspace)
      throw new Error(`Checkpoint identity or workspace does not match: ${name}`);
    return record;
  }
  async snapshots(taskId?: string): Promise<Record[]> {
    if (taskId) z.uuid().parse(taskId);
    if (!await this.checkRoot()) return [];
    // shortcut: scans immutable snapshots; add an index if a workspace accumulates thousands of them.
    const names = (await readdir(this.root)).filter((name) => snapshotName.test(name) && (!taskId || name.startsWith(`${taskId}.`)));
    const records = await Promise.all(names.map((name) => this.read(name)));
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.checkpointId.localeCompare(a.checkpointId));
  }
  async load(taskId: string, checkpointId?: string): Promise<Record> {
    z.uuid().parse(taskId);
    if (checkpointId) z.uuid().parse(checkpointId);
    const records = await this.snapshots(taskId);
    const record = checkpointId ? records.find((item) => item.checkpointId === checkpointId) : records[0];
    if (!record) throw new Error('Checkpoint not found in the configured workspace. Use rollover_list to find task IDs.');
    return record;
  }
  async list(): Promise<Record[]> {
    const latest = new Map<string, Record>();
    for (const record of await this.snapshots()) if (!latest.has(record.taskId)) latest.set(record.taskId, record);
    return [...latest.values()];
  }
  async save(input: z.input<typeof saveSchema>): Promise<Record> {
    const state = saveSchema.parse(input);
    if (state.taskId && (await this.load(state.taskId)).originalGoal !== state.originalGoal)
      throw new Error('originalGoal must match the existing task. Start a new task for a different user request.');
    const work = await workspaceState(this.workspace);
    const record = recordSchema.parse({...state, version: 1, taskId: state.taskId ?? randomUUID(),
      checkpointId: randomUUID(), createdAt: new Date().toISOString(), workspace: work});
    const json = JSON.stringify(record, null, 2) + '\n';
    if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new Error('Checkpoint exceeds the 4 MiB storage limit.');
    await this.checkRoot(true);
    const base = path.join(this.root, `${record.taskId}.${record.checkpointId}`);
    await atomicWrite(`${base}.md`, renderRecord(record) + '\n');
    // The JSON rename commits the snapshot; orphaned Markdown after a crash is ignored.
    await atomicWrite(`${base}.json`, json);
    return record;
  }
}
