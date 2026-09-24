import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import type {Agent, AgentHandle, AgentOptions} from '@deepseek-ai/dsh-agent';
import type {SessionId} from '@deepseek-ai/dsh-session';
import type {UserMessage} from '@deepseek-ai/dsh-llm';
import type {RolloverConfig} from './config.js';
import type {Chain, Checkpoint, RolloverState} from './checkpoint/schema.js';
import {CheckpointStore} from './storage/store.js';
import {generateCheckpoint} from './checkpoint/generator.js';
import {fallbackCheckpoint} from './checkpoint/fallback.js';
import {resumeFromCheckpoint} from './session/resume.js';
import {redactSecrets} from './utils/errors.js';

interface WebSessionController {
  create(request: {cwd?: string; sessionId: SessionId; agentPreset?: string}): Promise<{sessionId: SessionId}>;
  selectModel(request: {sessionId: SessionId; provider: string; model: string; reasoningEffort?: string}): Promise<unknown>;
}
interface PermissionPresets {
  current(session: Agent['session']): string;
  set(session: Agent['session'], preset: string): void;
}

export class RolloverManager {
  readonly store: CheckpointStore;
  private readonly chainStores = new Map<string, CheckpointStore>();
  private readonly recoveredRoots = new Set<string>();
  private readonly locks = new Map<string, Promise<boolean>>();
  private readonly chains = new Map<string, Chain>();
  private readonly handles = new Map<string, AgentHandle>();
  private readonly retired = new Map<string, string>();
  private readonly lastRollover = new Map<string, number>();
  private readonly states = new Map<string, RolloverState>();
  private readonly requestOptions = new Map<string, AgentOptions>();

  constructor(private readonly ctx: Context, private readonly config: RolloverConfig) {
    const cwd = process.cwd();
    this.store = new CheckpointStore(path.resolve(cwd, config.storage.directory));
  }
  private storeForCwd(cwd: string): CheckpointStore {
    return new CheckpointStore(path.resolve(cwd, this.config.storage.directory));
  }
  private storeForChain(chain: Chain): CheckpointStore {
    return this.chainStores.get(chain.chainId) ?? this.storeForCwd(chain.workspaceCwd ?? process.cwd());
  }
  state(id: string): RolloverState { return this.states.get(id) ?? 'NORMAL'; }
  setState(id: string, state: RolloverState): void { this.states.set(id, state); }
  successor(id: string): string | undefined { return this.retired.get(id); }
  optionsFor(id: string): AgentOptions | undefined { return this.requestOptions.get(id); }
  private log(event: string, fields: Record<string, unknown>): void {
    this.ctx.logger.info(`[rollover] ${event} ${redactSecrets(JSON.stringify(fields))}`);
  }
  private chainFor(id: string): Chain | undefined {
    return [...this.chains.values()].find((chain) => chain.sessions.includes(id));
  }
  private newChain(source: string, cwd: string): Chain {
    const now = new Date().toISOString();
    return {chainId: randomUUID(), rootSessionId: source, activeSessionId: source,
      sessions: [source], rolloverCount: 0, taskStatus: 'in-progress', createdAt: now, updatedAt: now, workspaceCwd: cwd};
  }
  async rollover(agent: Agent, claimed: readonly UserMessage[] = [], emergencyError?: string, force = false,
    metrics: {inputTokens: number; contextWindow: number; threshold: number} | undefined = undefined): Promise<boolean> {
    const source = String(agent.session.id);
    if (this.retired.has(source)) return true;
    const pending = this.locks.get(source);
    if (pending) return pending;
    const operation = this.perform(agent, claimed, emergencyError, force, metrics).finally(() => this.locks.delete(source));
    this.locks.set(source, operation);
    return operation;
  }
  private async perform(agent: Agent, claimed: readonly UserMessage[], emergencyError?: string, force = false,
    metrics: {inputTokens: number; contextWindow: number; threshold: number} | undefined = undefined): Promise<boolean> {
    const source = String(agent.session.id);
    if (agent.session.header.origin === 'subagent') {
      this.setState(source, 'FAILED');
      this.log('failed', {sourceSessionId: source,
        error: 'One-shot subagent handoff cannot reattach a fresh child to the parent tool result through the public API'});
      return false;
    }
    const chain = this.chainFor(source) ?? this.newChain(source, agent.session.header.cwd ?? process.cwd());
    this.chains.set(chain.chainId, chain);
    const store = this.storeForChain(chain);
    this.chainStores.set(chain.chainId, store);
    const elapsed = Date.now() - (this.lastRollover.get(chain.chainId) ?? 0);
    if (chain.rolloverCount >= this.config.rollover.maxRollovers ||
        (!force && chain.rolloverCount > 0 && elapsed < this.config.rollover.minIntervalSeconds * 1000)) return false;
    const start = Date.now();
    const index = chain.rolloverCount + 1;
    const transactionId = randomUUID(), targetId = `rollover-${randomUUID()}`;
    const transaction = {id: transactionId, sourceSessionId: source, targetSessionId: targetId,
      status: 'CHECKPOINTING' as RolloverState, checkpointIndex: index};
    chain.transaction = transaction;
    chain.updatedAt = new Date().toISOString();
    this.setState(source, emergencyError ? 'EMERGENCY_ROLLOVER' : 'CHECKPOINTING');
    try {
      await store.saveChain(chain);
      await this.ctx.sessions.flush(agent.session);
      this.log('generating checkpoint', {chainId: chain.chainId, sourceSessionId: source, rolloverIndex: index});
      const ids = {chainId: chain.chainId, transactionId, targetId, index};
      const fallback = await fallbackCheckpoint(agent, claimed, this.config, ids, emergencyError);
      const projections = this.ctx.get('sessionProjections') as {stateOf(session: Agent['session'], key: string): unknown} | undefined;
      const currentPreset = projections?.stateOf(agent.session, 'agentPreset');
      if (typeof currentPreset === 'string') fallback.runtime.agentPreset = currentPreset;
      const permissionPresets = this.ctx.get('permissionPresets') as PermissionPresets | undefined;
      if (permissionPresets && this.config.rollover.preservePermissions)
        fallback.runtime.permissionPreset = permissionPresets.current(agent.session);
      await store.saveCheckpoint(fallback);
      const checkpoint = await generateCheckpoint(this.ctx, agent, claimed, this.config,
        ids, emergencyError, fallback);
      await store.saveCheckpoint(checkpoint);
      transaction.status = 'ROLLOVER_PENDING';
      await store.saveChain(chain);
      this.log('checkpoint saved', {chainId: chain.chainId, sourceSessionId: source, rolloverIndex: index});
      if (this.config.rollover.preservePermissions && checkpoint.runtime.permissionPreset === 'custom')
        throw new Error('custom permission state cannot be cloned through the public preset API');
      const target = await this.createAndResume(chain, checkpoint, claimed, agent);
      if (!target) return false;
      this.lastRollover.set(chain.chainId, Date.now());
      this.retired.set(source, targetId);
      for (const message of agent.inbox.nextStep) target.inject(message);
      for (const message of agent.inbox.nextTurn) target.followup(message);
      agent.inbox.clear();
      this.setState(source, 'COMPLETED');
      this.log('completed', {chainId: chain.chainId, sourceSessionId: source, targetSessionId: targetId,
        rolloverIndex: index, duration: Date.now() - start, ...metrics});
      if (this.config.ui.notify) this.ctx.logger.info(`Session automatically continued: ${source} → ${targetId}`);
      return true;
    } catch (error) {
      transaction.status = 'FAILED';
      chain.updatedAt = new Date().toISOString();
      await store.saveChain(chain).catch(() => undefined);
      this.setState(source, 'FAILED');
      this.log('failed', {chainId: chain.chainId, sourceSessionId: source,
        error: error instanceof Error ? error.message : String(error)});
      return false;
    }
  }
  private async createAndResume(chain: Chain, checkpoint: Checkpoint, claimed: readonly UserMessage[], old?: Agent): Promise<Agent | undefined> {
    const store = this.storeForChain(chain);
    const targetId = checkpoint.newSessionId;
    if (!chain.transaction) throw new Error('missing rollover transaction');
    chain.transaction.status = 'CREATING_SESSION';
    await store.saveChain(chain);
    this.setState(checkpoint.parentSessionId, 'CREATING_SESSION');
    this.log('creating session', {chainId: chain.chainId, sourceSessionId: checkpoint.parentSessionId, targetSessionId: targetId});
    let target = this.ctx.agents.get(targetId as SessionId);
    if (!target) {
      const controller = this.ctx.get('sessionController') as WebSessionController | undefined;
      if (controller) {
        await controller.create({sessionId: targetId as SessionId,
          cwd: this.config.rollover.preserveWorkspace ? checkpoint.workspace.cwd : undefined,
          agentPreset: this.config.rollover.preservePermissions ? checkpoint.runtime.agentPreset : undefined});
        target = this.ctx.agents.get(targetId as SessionId);
        if (!target) throw new Error('Web session controller created no live Agent');
      } else {
        try {
          const handle = await this.ctx.agents.resume({resumeSessionId: targetId as SessionId,
            agentOptions: this.config.rollover.preserveModel ? old?.options ?? checkpoint.runtime.agentOptions : undefined});
          target = handle.agent; this.handles.set(targetId, handle);
        } catch {
          const handle = await this.ctx.agents.create({sessionId: targetId as SessionId,
            meta: {cwd: this.config.rollover.preserveWorkspace ? checkpoint.workspace.cwd : undefined,
              agentPreset: this.config.rollover.preservePermissions ? old?.session.header.agentPreset ?? checkpoint.runtime.agentPreset : undefined},
            agentOptions: this.config.rollover.preserveModel ? old?.options ?? checkpoint.runtime.agentOptions : undefined});
          target = handle.agent; this.handles.set(targetId, handle);
        }
      }
    }
    const controller = this.ctx.get('sessionController') as WebSessionController | undefined;
    const route = checkpoint.runtime.agentOptions;
    if (controller && this.config.rollover.preserveModel && route.provider && route.model)
      await controller.selectModel({sessionId: targetId as SessionId, provider: route.provider, model: route.model,
        reasoningEffort: route.reasoningEffort});
    const permissions = this.ctx.get('permissionPresets') as PermissionPresets | undefined;
    if (permissions && this.config.rollover.preservePermissions && checkpoint.runtime.permissionPreset && checkpoint.runtime.permissionPreset !== 'custom')
      permissions.set(target.session, checkpoint.runtime.permissionPreset);
    if (this.config.rollover.preserveModel) this.requestOptions.set(targetId, checkpoint.runtime.agentOptions);
    this.log('session created', {chainId: chain.chainId, targetSessionId: targetId});
    chain.transaction.status = 'RESUMING';
    await store.saveChain(chain);
    this.setState(checkpoint.parentSessionId, 'RESUMING');
    chain.activeSessionId = targetId;
    if (!chain.sessions.includes(targetId)) chain.sessions.push(targetId);
    chain.rolloverCount = Math.max(chain.rolloverCount, checkpoint.rolloverIndex);
    this.lastRollover.set(chain.chainId, Date.now());
    this.retired.set(checkpoint.parentSessionId, targetId);
    resumeFromCheckpoint(target, checkpoint, claimed, this.config.rollover.autoResume);
    chain.transaction.status = 'COMPLETED';
    chain.updatedAt = new Date().toISOString();
    await store.saveChain(chain);
    this.log('resuming task', {chainId: chain.chainId, targetSessionId: targetId});
    return target;
  }
  async recover(): Promise<void> {
    const roots = new Set([process.cwd(), ...this.ctx.agents.list().map((agent) => agent.session.header.cwd ?? process.cwd())]);
    for (const cwd of roots) await this.recoverWorkspace(cwd);
  }
  async recoverWorkspace(cwd: string): Promise<void> {
    const store = this.storeForCwd(cwd);
    if (this.recoveredRoots.has(store.root)) return;
    this.recoveredRoots.add(store.root);
    for (const chain of await store.listChains()) {
      this.chains.set(chain.chainId, chain);
      this.chainStores.set(chain.chainId, store);
      if (chain.rolloverCount > 0) {
        const latest = await store.loadCheckpoint(chain.chainId, chain.rolloverCount);
        if (latest) this.requestOptions.set(latest.newSessionId, latest.runtime.agentOptions);
      }
      for (let index = 0; index < chain.sessions.length - 1; index++)
        this.retired.set(chain.sessions[index], chain.sessions[index + 1]);
      const transaction = chain.transaction;
      if (!transaction || transaction.status === 'COMPLETED' || transaction.status === 'FAILED') continue;
      if (this.locks.has(transaction.sourceSessionId)) continue;
      const checkpoint = await store.loadCheckpoint(chain.chainId, transaction.checkpointIndex);
      if (!checkpoint || checkpoint.transactionId !== transaction.id) continue;
      const old = this.ctx.agents.get(transaction.sourceSessionId as SessionId);
      try { await this.createAndResume(chain, checkpoint, [], old); }
      catch (error) { this.log('recovery failed', {chainId: chain.chainId, error: String(error)}); }
    }
  }
}
