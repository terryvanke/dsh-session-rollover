import {mkdir, open, readFile, readdir, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Chain, Checkpoint} from '../checkpoint/schema.js';

export async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), {recursive: true});
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(data, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); }
  catch (error) { await rm(temporary, {force: true}); throw error; }
  try { const directory = await open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  catch { /* Windows cannot fsync a directory; file sync and rename remain atomic. */ }
}

export class CheckpointStore {
  constructor(readonly root: string) {}
  directory(chainId: string): string { return path.join(this.root, chainId); }
  chainPath(chainId: string): string { return path.join(this.directory(chainId), 'chain.json'); }
  async saveChain(chain: Chain): Promise<void> {
    await atomicWrite(this.chainPath(chain.chainId), JSON.stringify(chain, null, 2) + '\n');
  }
  async loadChain(chainId: string): Promise<Chain | undefined> {
    try { return JSON.parse(await readFile(this.chainPath(chainId), 'utf8')) as Chain; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async listChains(): Promise<Chain[]> {
    let names: string[];
    try { names = await readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const chains = await Promise.all(names.map((name) => this.loadChain(name).catch(() => undefined)));
    return chains.filter((chain): chain is Chain => chain !== undefined);
  }
  checkpointPath(chainId: string, index: number, extension: 'md' | 'json'): string {
    return path.join(this.directory(chainId), `session-${String(index).padStart(3, '0')}.${extension}`);
  }
  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const {markdown, ...json} = checkpoint;
    await atomicWrite(this.checkpointPath(checkpoint.chainId, checkpoint.rolloverIndex, 'md'), markdown + '\n');
    await atomicWrite(this.checkpointPath(checkpoint.chainId, checkpoint.rolloverIndex, 'json'), JSON.stringify(json, null, 2) + '\n');
  }
  async loadCheckpoint(chainId: string, index: number): Promise<Checkpoint | undefined> {
    try {
      const json = JSON.parse(await readFile(this.checkpointPath(chainId, index, 'json'), 'utf8')) as Omit<Checkpoint, 'markdown'>;
      const markdown = await readFile(this.checkpointPath(chainId, index, 'md'), 'utf8');
      return {...json, markdown};
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
}
