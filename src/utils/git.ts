import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const {stdout} = await run('git', ['-C', cwd, ...args], {timeout: 5000, maxBuffer: 1024 * 1024});
    return stdout.trim();
  } catch { return ''; }
}

export async function workspaceState(cwd: string, withGit = true) {
  if (!withGit) return {cwd, branch: '', gitStatus: '', diffStat: '', modified: [] as string[], created: [] as string[], deleted: [] as string[]};
  const [branch, gitStatus, diffStat] = await Promise.all([
    git(cwd, 'branch', '--show-current'), git(cwd, 'status', '--short'), git(cwd, 'diff', '--stat')
  ]);
  const modified: string[] = [], created: string[] = [], deleted: string[] = [];
  for (const line of gitStatus.split(/\r?\n/).filter(Boolean)) {
    const code = line.slice(0, 2), file = line.slice(3).trim();
    if (code.includes('D')) deleted.push(file);
    else if (code === '??' || code.includes('A')) created.push(file);
    else modified.push(file);
  }
  return {cwd, branch, gitStatus, diffStat, modified, created, deleted};
}
