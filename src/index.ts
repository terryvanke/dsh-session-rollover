import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-token-meter';
import {Config, defaults, validateConfig, type RolloverConfig} from './config.js';
import {contextPressure} from './context-monitor.js';
import {shouldRollover, isContextOverflow} from './rollover-policy.js';
import {RolloverManager} from './rollover-manager.js';
import {redactSecrets} from './utils/errors.js';

export const name = 'session-rollover';
export const inject = ['agents', 'sessions', 'tokenMeter', 'llm'];
export {Config};

export function apply(ctx: Context, supplied: Partial<RolloverConfig> = {}): void {
  const config = Config({...defaults, ...supplied});
  validateConfig(config);
  if (!config.enabled) return;
  ctx.logger.info('[rollover] plugin active');
  const manager = new RolloverManager(ctx, config);
  const compactions = new Map<string, number>();
  void manager.recover().catch((error) => ctx.logger.warn(`[rollover] recovery failed: ${redactSecrets(String(error))}`));
  ctx.on('agent/created', ({agent}) => {
    const cwd = agent.session.header.cwd ?? process.cwd();
    queueMicrotask(() => { void manager.recoverWorkspace(cwd).catch((error) => ctx.logger.warn(`[rollover] recovery failed: ${redactSecrets(String(error))}`)); });
    return undefined;
  });
  ctx.on('session/event', (session, event) => {
    if ((event as {type: string}).type === 'compaction/end') {
      const id = String(session.id);
      compactions.set(id, (compactions.get(id) ?? 0) + 1);
    }
  });
  ctx.on('agent/pre-step', async ({agent, messages, signal}, next) => {
    if (signal.aborted) return next();
    if (agent.session.header.origin === 'subagent') return next();
    const successor = manager.successor(String(agent.session.id));
    if (successor) {
      const target = ctx.agents.get(successor as typeof agent.session.id);
      if (target) for (const message of messages) target.followup(message);
      return {kind: 'reject'};
    }
    const route = agent.session.requestHeader()?.config ?? manager.optionsFor(String(agent.session.id)) ?? agent.options;
    let window = config.context.windowTokens;
    let output = config.context.reserveOutputTokens;
    if (route.provider && route.model) {
      try {
        const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
        window = info.context?.contextWindow ?? window;
        output = route.maxTokens ?? info.defaultMaxTokens ?? output;
      } catch (error) { ctx.logger.warn(`[rollover] model capacity lookup failed: ${redactSecrets(String(error))}`); }
    }
    const measurement = ctx.tokenMeter.measure(agent.session);
    const input = measurement.totalTokens + messages.reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0);
    const pressure = contextPressure(input, window, output, config);
    ctx.logger.info(`[rollover] context pressure ${JSON.stringify({sessionId: String(agent.session.id), inputTokens: input, contextWindow: window, threshold: pressure.hardLimit})}`);
    if (pressure.level === 'ARMED') manager.setState(String(agent.session.id), 'ARMED');
    if (pressure.level !== 'NORMAL') ctx.logger.info(`[rollover] ${pressure.level === 'HARD' ? 'hard' : 'soft'} threshold reached ${String(agent.session.id)}`);
    if (!shouldRollover(pressure, compactions.get(String(agent.session.id)) ?? 0, config)) return next();
    const completed = await manager.rollover(agent, messages, undefined, pressure.level === 'HARD',
      {inputTokens: input, contextWindow: window, threshold: pressure.hardLimit});
    return completed || pressure.level === 'HARD' ? {kind: 'reject'} : next();
  });
  ctx.on('agent/request-error', async ({agent, failure, signal}, next) => {
    if (signal.aborted || agent.session.header.origin === 'subagent' || !config.fallback.rolloverOnContextOverflow || !isContextOverflow(failure.code, failure.message)) return next();
    await manager.rollover(agent, [], `${failure.code}: ${failure.message}`, true);
    return next();
  });
  ctx.on('agent/request', async ({agent}, next) => {
    const result = await next();
    const saved = manager.optionsFor(String(agent.session.id));
    if (saved?.maxTokens !== undefined && result.provider === saved.provider && result.model === saved.model)
      return {...result, maxTokens: saved.maxTokens};
    return result;
  });
  ctx.on('agent/inbox/inserted', ({agent, message}) => {
    const successor = manager.successor(String(agent.session.id));
    if (!successor) return;
    const target = ctx.agents.get(successor as typeof agent.session.id);
    if (target && agent.inbox.remove(message.id)) target.followup(message);
  });
}

export {contextPressure, shouldRollover, isContextOverflow, RolloverManager};
