import {afterEach, describe, expect, it} from 'vitest';
import {Client, type CallToolResult} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const clients: Client[] = [], directories: string[] = [];
const entry = path.resolve('dist/mcp/cli.js');
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(directories.splice(0).map((cwd) => rm(cwd, {recursive: true, force: true})));
});
function resultText(result: CallToolResult) {
  expect(result.isError).not.toBe(true);
  return result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}
async function connect(cwd: string, name: string, modern = false) {
  const client = new Client({name, version: 'test'}, modern ? {versionNegotiation: {mode: 'auto'}} : {});
  clients.push(client);
  await client.connect(new StdioClientTransport({command: process.execPath, args: [entry, '--workspace', cwd], stderr: 'pipe'}));
  return client;
}

describe('MCP stdio entrypoint', () => {
  it.each([false, true])('hands a task between two client processes and validates calls (modern=%s)', async (modern) => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'rollover-mcp-wire-'));
    directories.push(cwd);
    const first = await connect(cwd, 'test-trae', modern);
    expect((await first.listTools()).tools.map((tool) => tool.name).sort()).toEqual(['rollover_list', 'rollover_load', 'rollover_save']);
    const saved = JSON.parse(resultText(await first.callTool({name: 'rollover_save', arguments: {
      originalGoal: '修复登录', currentGoal: '验证修复', currentWork: '代码已更新',
      nextAction: '运行登录测试', requirements: ['保留接口'], completed: ['修复代码']
    }})));
    await first.close();
    const second = await connect(cwd, 'test-workbuddy', modern);
    expect(JSON.parse(resultText(await second.callTool({name: 'rollover_list', arguments: {}})))[0].taskId).toBe(saved.taskId);
    const handoff = resultText(await second.callTool({name: 'rollover_load', arguments: {taskId: saved.taskId}}));
    expect(handoff).toContain('运行登录测试');
    expect(handoff).toContain('保留接口');
    const invalid = await second.callTool({name: 'rollover_load', arguments: {taskId: '../../outside'}});
    expect(invalid.isError).toBe(true);
    const missing = await second.callTool({name: 'rollover_save', arguments: {originalGoal: 'incomplete'}});
    expect(missing.isError).toBe(true);
  }, 15000);
  it('does not silently bind a server to an unintended client working directory', () => {
    expect(() => execFileSync(process.execPath, [entry], {stdio: 'pipe'})).toThrow();
    expect(execFileSync(process.execPath, [entry, '--help'], {encoding: 'utf8'})).toContain('--workspace');
  });
});
