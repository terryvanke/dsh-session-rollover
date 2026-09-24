import {afterEach, describe, expect, it} from 'vitest';
import {fixture, config} from './helpers.js';
import {RolloverManager} from '../src/rollover-manager.js';
import {apply} from '../src/index.js';
import type {Context} from '@deepseek-ai/cordis';
import {CheckpointStore} from '../src/storage/store.js';
import path from 'node:path';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));});

describe('rollover transaction', () => {
  it('creates one fresh session, rejects duplicate triggers and transfers claimed input', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const {agent} = f.makeAgent('A');
    const manager = new RolloverManager(f.ctx, config());
    const claimed = f.message('Fix the test');
    const [a, b] = await Promise.all([manager.rollover(agent, [claimed]), manager.rollover(agent, [claimed])]);
    expect([a, b]).toEqual([true, true]);
    expect(f.calls.create).toBe(1);
    const next = f.agents.get(manager.successor('A')!);
    expect(next).toBeDefined();
    expect(f.calls.clear).toBe(1);
    const store = new CheckpointStore(path.join(f.cwd, '.dsh', 'rollover'));
    const [chain] = await store.listChains();
    expect(chain.sessions).toHaveLength(2);
    expect(chain.transaction?.status).toBe('COMPLETED');
  });
  it('keeps the old session usable if creation fails', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const {agent} = f.makeAgent('A');
    f.setFailCreate(true);
    const manager = new RolloverManager(f.ctx, config());
    expect(await manager.rollover(agent)).toBe(false);
    expect(f.calls.clear).toBe(0);
    expect(manager.successor('A')).toBeUndefined();
  });
  it('rejects an old-session model step at the hard limit', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const {agent} = f.makeAgent('A');
    const listeners = new Map<string, (...args: any[]) => any>();
    const ctx = {...f.ctx,
      on: (name: string, listener: (...args: any[]) => any) => {listeners.set(name, listener);},
      tokenMeter: {measure: () => ({totalTokens: 7200}), estimateMessage: () => 0},
      llm: {resolveModelInfo: async () => ({context: {contextWindow: 10000}, defaultMaxTokens: 1000})}
    } as unknown as Context;
    apply(ctx, config());
    const result = await listeners.get('agent/pre-step')!({agent, messages: [], signal: new AbortController().signal},
      async () => ({kind: 'enter', messages: []}));
    expect(result).toEqual({kind: 'reject'});
    expect(f.calls.create).toBe(1);
  });
  it('uses the Web session controller to compose the preset and restore model and permissions', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const {agent} = f.makeAgent('A');
    (agent.session.header as {agentPreset?: string}).agentPreset = 'code';
    const calls = {controller: 0, selection: 0, permission: 0};
    const controller = {
      create: async ({sessionId}: {sessionId: string}) => {calls.controller++; f.makeAgent(sessionId); return {sessionId};},
      selectModel: async () => {calls.selection++;}
    };
    const permissionPresets = {
      current: () => 'workspace-write',
      set: () => {calls.permission++;}
    };
    const ctx = {...f.ctx, get: (name: string) => name === 'sessionController' ? controller :
      name === 'permissionPresets' ? permissionPresets : undefined} as unknown as Context;
    const manager = new RolloverManager(ctx, config());
    expect(await manager.rollover(agent)).toBe(true);
    expect(calls).toEqual({controller: 1, selection: 1, permission: 1});
    expect(f.calls.create).toBe(0);
    expect(manager.optionsFor(manager.successor('A')!)?.model).toBe('tiny');
  });
  it('fails closed for a one-shot subagent whose parent tool result cannot be migrated', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const {agent} = f.makeAgent('A');
    (agent.session.header as {origin?: string}).origin = 'subagent';
    const manager = new RolloverManager(f.ctx, config());
    expect(await manager.rollover(agent)).toBe(false);
    expect(manager.state('A')).toBe('FAILED');
    expect(f.calls.create).toBe(0);
  });
  it('leaves ordinary compaction in control of one-shot subagents', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const {agent} = f.makeAgent('A');
    (agent.session.header as {origin?: string}).origin = 'subagent';
    const listeners = new Map<string, (...args: any[]) => any>();
    const ctx = {...f.ctx,
      on: (name: string, listener: (...args: any[]) => any) => {listeners.set(name, listener);},
      tokenMeter: {measure: () => ({totalTokens: 9000}), estimateMessage: () => 0},
      llm: {resolveModelInfo: async () => ({context: {contextWindow: 10000}, defaultMaxTokens: 1000})}
    } as unknown as Context;
    apply(ctx, config());
    const result = await listeners.get('agent/pre-step')!({agent, messages: [], signal: new AbortController().signal},
      async () => ({kind: 'enter', messages: []}));
    expect(result.kind).toBe('enter');
    expect(f.calls.create).toBe(0);
  });
  it('does not silently replace custom permissions with a default preset', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const {agent} = f.makeAgent('A');
    const ctx = {...f.ctx, get: (name: string) => name === 'permissionPresets' ?
      {current: () => 'custom', set: () => undefined} : undefined} as unknown as Context;
    const manager = new RolloverManager(ctx, config());
    expect(await manager.rollover(agent)).toBe(false);
    expect(f.calls.create).toBe(0);
    expect(f.calls.clear).toBe(0);
  });
});
