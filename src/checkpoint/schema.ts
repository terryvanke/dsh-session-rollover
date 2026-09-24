export type RolloverState = 'NORMAL' | 'ARMED' | 'CHECKPOINTING' | 'ROLLOVER_PENDING' | 'CREATING_SESSION' | 'RESUMING' | 'COMPLETED' | 'FAILED' | 'EMERGENCY_ROLLOVER';

export interface Checkpoint {
  version: 1;
  chainId: string;
  transactionId: string;
  rolloverIndex: number;
  parentSessionId: string;
  newSessionId: string;
  createdAt: string;
  task: {originalGoal: string; currentGoal: string; status: string};
  workspace: {cwd: string; branch: string; gitStatus: string; diffStat: string};
  files: {modified: string[]; created: string[]; deleted: string[]};
  progress: {completed: string[]; pending: string[]; current: string};
  errors: string[];
  decisions: string[];
  nextAction: string;
  runtime: {agentOptions: AgentOptions; agentPreset?: string; permissionPreset?: string};
  recentMessages: string[];
  recentToolResults: string[];
  markdown: string;
}

export interface Chain {
  chainId: string;
  rootSessionId: string;
  activeSessionId: string;
  sessions: string[];
  rolloverCount: number;
  taskStatus: string;
  createdAt: string;
  updatedAt: string;
  workspaceCwd?: string;
  transaction?: {id: string; sourceSessionId: string; targetSessionId: string; status: RolloverState; checkpointIndex: number};
}
import type {AgentOptions} from '@deepseek-ai/dsh-agent';
