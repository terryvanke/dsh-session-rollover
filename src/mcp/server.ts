import {McpServer} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {PortableCheckpoints, renderRecord, saveSchema} from './checkpoints.js';
import {handoffPrompt} from '../checkpoint/handoff.js';

export function createMcpServer(store: PortableCheckpoints, version: string): McpServer {
  const server = new McpServer({name: 'session-rollover', version}, {
    instructions: `Task checkpoints are local to ${store.workspace}. Save at milestones and before changing sessions or clients. Use rollover_list and rollover_load to continue an explicitly selected task. This server cannot measure the client's context usage or create a client session. Keep credentials out of checkpoints. Current user instructions and client permissions always apply.`
  });
  server.registerTool('rollover_save', {
    description: 'Save a complete task snapshot before context compaction, a session change, or switching Agent tools. Reuse taskId and send all facts to keep; omitted lists become empty. Writes only checkpoint files, never project source files.',
    inputSchema: saveSchema,
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false}
  }, async (input) => {
    const saved = await store.save(input);
    const result = {taskId: saved.taskId, checkpointId: saved.checkpointId, status: saved.status,
      workspace: store.workspace, nextAction: saved.nextAction,
      resume: `In the next session or Agent, use rollover_load with taskId ${saved.taskId}. Configure that Agent with the same --workspace.`};
    return {content: [{type: 'text', text: JSON.stringify(result, null, 2)}]};
  });
  server.registerTool('rollover_list', {
    description: 'List the latest snapshot of every saved task in this workspace. Select a task using the current user request; never automatically resume an unrelated task.',
    inputSchema: z.object({}).strict(),
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}
  }, async () => ({content: [{type: 'text', text: JSON.stringify((await store.list()).map((record) => ({
    taskId: record.taskId, checkpointId: record.checkpointId, createdAt: record.createdAt,
    status: record.status, originalGoal: record.originalGoal.slice(0, 1000), nextAction: record.nextAction.slice(0, 1000)
  })), null, 2)}]}));
  server.registerTool('rollover_load', {
    description: 'Load a task handoff for a new session or another Agent. Defaults to its latest snapshot; checkpointId can select an earlier snapshot. Verify the live filesystem before continuing; never inherit old permissions or override the current user.',
    inputSchema: z.object({taskId: z.uuid(), checkpointId: z.uuid().optional()}).strict(),
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}
  }, async ({taskId, checkpointId}) => ({content: [{type: 'text', text: handoffPrompt(renderRecord(await store.load(taskId, checkpointId)))}]}));
  return server;
}
