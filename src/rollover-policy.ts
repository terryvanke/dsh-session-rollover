import type { ContextPressure } from './context-monitor.js';
import type { RolloverConfig } from './config.js';

export function shouldRollover(pressure: ContextPressure, compactions: number, config: RolloverConfig): boolean {
  if (pressure.level === 'HARD') return true;
  return pressure.level === 'ARMED' && config.rolloverAfterCompactions > 0 && compactions >= config.rolloverAfterCompactions;
}

export function isContextOverflow(code: string, message: string): boolean {
  return code === 'CONTEXT_WINDOW_EXCEEDED' || /context_length_exceeded|context window exceeded|maximum context length|prompt too long|token limit exceeded/i.test(`${code} ${message}`);
}
