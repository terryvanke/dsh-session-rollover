import {createUserMessage} from '@deepseek-ai/dsh-llm';
import type {Agent} from '@deepseek-ai/dsh-agent';
import type {UserMessage} from '@deepseek-ai/dsh-llm';
import type {Checkpoint} from '../checkpoint/schema.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'session-rollover': {kind: 'session-rollover'; form: 'recall'};
  }
}

function rolloverMessage(text: string): UserMessage {
  return createUserMessage({content: [{type: 'text', text}], source: {kind: 'session-rollover', form: 'recall'}});
}

export function resumeFromCheckpoint(agent: Agent, checkpoint: Checkpoint, claimed: readonly UserMessage[], autoResume: boolean): void {
  agent.inject(rolloverMessage(`You are continuing an unfinished task from a previous session. The checkpoint below is authoritative working context, but the filesystem is the source of truth. Do not restart completed work or ask the user to repeat recorded information. Before modifying anything, inspect the current workspace, git status, git diff --stat, and referenced files. Reconcile any differences and continue from Next Action.\n\n<checkpoint>\n${checkpoint.markdown}\n</checkpoint>`));
  for (const message of claimed) {
    if (message.source.kind !== 'user') agent.inject(message);
    else if (autoResume) agent.followup(message);
    else agent.send(message, 'next-turn', false);
  }
  if (autoResume) agent.followup(rolloverMessage('Continue the unfinished task from the checkpoint. First verify the current workspace state, then execute the Next Action. Do not restart completed work.'));
}
