import {describe, expect, it} from 'vitest';
import {config} from './helpers.js';
import {contextPressure} from '../src/context-monitor.js';
import {shouldRollover, isContextOverflow} from '../src/rollover-policy.js';
import {redactSecrets} from '../src/utils/errors.js';

describe('pressure policy', () => {
  const settings = config();
  it('uses soft and hard limits at 65% and 72%', () => {
    expect(contextPressure(1000, 10000, 1000, settings).level).toBe('NORMAL');
    expect(contextPressure(6500, 10000, 1000, settings).level).toBe('ARMED');
    expect(contextPressure(7200, 10000, 1000, settings).level).toBe('HARD');
  });
  it('caps the hard threshold by output and safety reserves', () => {
    expect(contextPressure(6000, 10000, 2500, settings).hardLimit).toBe(6500);
    expect(contextPressure(6500, 10000, 2500, settings).level).toBe('HARD');
  });
  it('rejects an impossible output reservation instead of chaining fresh sessions forever', () => {
    expect(() => contextPressure(100, 10000, 9500, settings)).toThrow(/budget exhausted/);
  });
  it('honors compaction count at soft pressure and always blocks hard pressure', () => {
    const waiting = {...settings, rolloverAfterCompactions: 2};
    expect(shouldRollover(contextPressure(6500, 10000, 1000, waiting), 1, waiting)).toBe(false);
    expect(shouldRollover(contextPressure(6500, 10000, 1000, waiting), 2, waiting)).toBe(true);
    expect(shouldRollover(contextPressure(7200, 10000, 1000, waiting), 0, waiting)).toBe(true);
  });
  it('recognizes canonical and provider overflow forms', () => {
    expect(isContextOverflow('CONTEXT_WINDOW_EXCEEDED', '')).toBe(true);
    expect(isContextOverflow('bad_request', 'maximum context length exceeded')).toBe(true);
    expect(isContextOverflow('RATE_LIMIT', 'slow down')).toBe(false);
  });
  it('redacts credentials from structured log text', () => {
    expect(redactSecrets('Bearer abc123 api_key=secret sk-1234567890123456')).toBe('Bearer [redacted] api_key=[redacted] [redacted]');
  });
});
