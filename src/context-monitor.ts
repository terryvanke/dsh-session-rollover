import type { RolloverConfig } from './config.js';

export interface ContextPressure {
  contextWindowTokens: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  safetyReserveTokens: number;
  softLimit: number;
  hardLimit: number;
  level: 'NORMAL' | 'ARMED' | 'HARD';
}

export function contextPressure(inputTokens: number, contextWindow: number, maxOutput: number, config: RolloverConfig): ContextPressure {
  const ratioLimit = Math.floor(contextWindow * config.context.hardThresholdRatio);
  const budgetLimit = contextWindow - maxOutput - config.context.safetyTokens;
  if (budgetLimit <= 0) throw new RangeError(`context budget exhausted by output (${maxOutput}) and safety (${config.context.safetyTokens}) reservations`);
  const hardLimit = Math.max(1, Math.min(ratioLimit, budgetLimit));
  const softLimit = Math.max(1, Math.min(Math.floor(contextWindow * config.context.softThresholdRatio), hardLimit));
  return {
    contextWindowTokens: contextWindow, estimatedInputTokens: inputTokens,
    maxOutputTokens: maxOutput, safetyReserveTokens: config.context.safetyTokens,
    softLimit, hardLimit,
    level: inputTokens >= hardLimit ? 'HARD' : inputTokens >= softLimit ? 'ARMED' : 'NORMAL'
  };
}
