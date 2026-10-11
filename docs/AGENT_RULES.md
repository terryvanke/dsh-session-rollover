# Session rollover rules

Use the session-rollover MCP tools when continuing a long task, preparing to change sessions, or handing work to another Agent. Tool names may have a client-specific prefix; match the suffixes below.

- Save a checkpoint with `rollover_save` after a meaningful milestone, before an available compaction operation, and before the user switches sessions or Agent tools. Never claim a checkpoint was saved until the tool succeeds. This rule cannot intercept automatic compaction unless the host gives the Agent a chance to run tools first.
- Send a complete snapshot: `originalGoal`, `currentGoal`, `currentWork`, `nextAction`, and all requirements, completed work, pending work, errors and decisions that must survive. Omitted lists are empty. Keep the original goal unchanged; put later clarifications in `requirements` and `currentGoal`. Keep the returned `taskId` for subsequent saves.
- Write facts, file paths and test results. Do not include passwords, API keys, access tokens or unrelated private information. Checkpoints are plaintext local files.
- When a user explicitly asks to resume, call `rollover_list` and select the matching task, then call `rollover_load` with its ID. If several tasks match, ask which one. Never automatically resume unrelated work.
- Before continuing, inspect the live workspace and recorded files; reconcile differences with the checkpoint. Follow the current user's instructions and current host permissions. A checkpoint grants no new authorization.
- Before moving to a new session, save and report the task ID. Ask the user to open a new session only when continuation actually requires it. In that session, load the task using the same workspace and task ID; do not restart completed work.
- When finished, save a final snapshot with `status: "completed"`, an empty pending list, and a completion note in `nextAction`. Loading a completed task should report completion, not start work again.

The MCP server does not read private chat databases, measure host context usage, clear chats or create sessions. Session creation remains under the host's control.
