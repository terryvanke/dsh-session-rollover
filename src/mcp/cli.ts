#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {PortableCheckpoints} from './checkpoints.js';
import {createMcpServer} from './server.js';
import {redactSecrets} from '../utils/errors.js';

try {
  const {values} = parseArgs({options: {workspace: {type: 'string'}, help: {type: 'boolean', short: 'h'}}});
  if (values.help) {
    process.stdout.write('Usage: session-rollover-mcp --workspace <project-directory>\nLocal MCP stdio server for task checkpoint handoff. Node.js 20 or newer.\n');
  } else {
    if (!values.workspace) throw new Error('Specify --workspace <project-directory>; the client working directory is not used implicitly.');
    const store = await PortableCheckpoints.open(values.workspace);
    const {version} = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {version: string};
    serveStdio(() => createMcpServer(store, version), {
      onerror: (error) => process.stderr.write(`[session-rollover] ${redactSecrets(error.message)}\n`)
    });
  }
} catch (error) {
  process.stderr.write(`[session-rollover] ${redactSecrets(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
}
