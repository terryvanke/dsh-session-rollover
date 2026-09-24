import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Config} from '../src/config.js';
import type {Context} from '@deepseek-ai/cordis';
import type {Agent} from '@deepseek-ai/dsh-agent';
import type {UserMessage} from '@deepseek-ai/dsh-llm';

export const config = () => Config({
  context: {windowTokens: 10000, softThresholdRatio: 0.65, hardThresholdRatio: 0.72,
    reserveOutputTokens: 1000, safetyTokens: 1000},
  checkpoint: {enabled: false, retries: 0},
  rollover: {minIntervalSeconds: 0}
});

export async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-rollover-'));
  const agents = new Map<string, Agent>();
  const calls = {create: 0, resume: 0, clear: 0};
  const message = (text: string): UserMessage => ({id: `msg-${text}`, role: 'user',
    source: {kind: 'user'}, content: [{type: 'text', text}]}) as UserMessage;
  const makeAgent = (id: string, goal = 'Create files, run tests, fix failures') => {
    const injections: UserMessage[] = [], followups: UserMessage[] = [];
    const agent = {
      session: {id, header: {cwd}, requestHeader: () => undefined,
        snapshotEvents: () => [{type: 'user/message', data: message(goal)}]},
      options: {provider: 'fake', model: 'tiny'},
      inbox: {nextTurn: [], nextStep: [], clear: () => {calls.clear++;}, remove: () => true},
      inject: (input: UserMessage) => {injections.push(input);},
      followup: (input: UserMessage) => {followups.push(input);},
      status: 'idle'
    } as unknown as Agent;
    agents.set(id, agent);
    return {agent, injections, followups};
  };
  let failCreate = false;
  const ctx = {
    get: () => undefined,
    sessions: {flush: async () => true},
    agents: {
      list: () => [...agents.values()], get: (id: string) => agents.get(id),
      resume: async () => {calls.resume++; throw new Error('session missing');},
      create: async ({sessionId}: {sessionId: string}) => {
        calls.create++;
        if (failCreate) throw new Error('create failed');
        return {agent: makeAgent(sessionId).agent, dispose: async () => undefined};
      }
    },
    logger: {info: () => undefined, warn: () => undefined}
  } as unknown as Context;
  return {cwd, ctx, calls, agents, makeAgent, message, setFailCreate: (value: boolean) => {failCreate = value;},
    cleanup: () => rm(cwd, {recursive: true, force: true})};
}
