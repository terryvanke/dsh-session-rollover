import type {Context} from '@deepseek-ai/cordis';
import type {Agent} from '@deepseek-ai/dsh-agent';

export function workingDirectory(ctx: Context | undefined, agent: Agent) {
  return (agent.ctx?.get('workingDirectory') ?? ctx?.get('workingDirectory')) as {
    get(session: Agent['session']): string;
    set(agent: Agent, cwd: string): Promise<string>;
  } | undefined;
}
