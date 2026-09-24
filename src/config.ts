import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  enabled: z.boolean().default(true),
  context: z.object({
    windowTokens: z.number().step(1).min(1).default(200000),
    softThresholdRatio: z.number().min(0).max(1).default(0.65),
    hardThresholdRatio: z.number().min(0).max(1).default(0.72),
    reserveOutputTokens: z.number().step(1).min(0).default(32000),
    safetyTokens: z.number().step(1).min(0).default(24000)
  }).default({}),
  checkpoint: z.object({
    enabled: z.boolean().default(true),
    maxTokens: z.number().step(1).min(1).default(8192),
    includeRecentMessages: z.number().step(1).min(0).default(12),
    includeToolResults: z.number().step(1).min(0).default(8),
    includeFileState: z.boolean().default(true),
    includeGitStatus: z.boolean().default(true),
    retries: z.number().step(1).min(0).default(3)
  }).default({}),
  rollover: z.object({
    autoResume: z.boolean().default(true),
    maxRollovers: z.number().step(1).min(1).default(100),
    minIntervalSeconds: z.number().step(1).min(0).default(60),
    preserveWorkspace: z.boolean().default(true),
    preserveModel: z.boolean().default(true),
    preservePermissions: z.boolean().default(true)
  }).default({}),
  rolloverAfterCompactions: z.number().step(1).min(0).default(0),
  fallback: z.object({
    deterministicCheckpoint: z.boolean().default(true),
    rolloverOnContextOverflow: z.boolean().default(true)
  }).default({}),
  storage: z.object({directory: z.string().default('.dsh/rollover')}).default({}),
  ui: z.object({notify: z.boolean().default(true)}).default({})
});

export type RolloverConfig = ReturnType<typeof Config>;
export const defaults: RolloverConfig = Config({});

export function validateConfig(config: RolloverConfig): void {
  if (config.context.softThresholdRatio >= config.context.hardThresholdRatio)
    throw new Error('softThresholdRatio must be below hardThresholdRatio');
}
