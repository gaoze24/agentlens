# AgentLens - three-minute demonstration

This is the team's single rehearsal script. Start with the [reviewer runbook](../RUNBOOK.md)
or [Windows guide](../RUNBOOK.zh-CN.md) for setup, exact commands and shutdown.
Use real frontend-to-Agent execution; fixture screenshots do not replace it.

## Before recording

- Rehearse on the submitted revision with a working Responses-compatible model.
- Use a dedicated demo key and empty workspace; close unrelated private windows.
- Keep credentials, `.env`, expanded Compose configuration and raw state out of frame.
- Show the runtime profile accurately: the Windows Compose profile shares an app
  container, while the local POC launches a disposable runtime container per turn.
- Keep narration/captions in English. Upload the final three-minute video publicly
  to YouTube and place its real link in the submission; no video is provided here.
- Timing below is a rehearsal budget, not a guarantee of model response time.
  If editing out waiting time, disclose that; do not pass fixtures off as live work.

## Story and timing

| Time | On screen | Suggested narration |
| --- | --- | --- |
| 0:00-0:20 | Project and one-page architecture | "An agent's final answer does not explain its actions. AgentLens records execution evidence at the control-plane boundary." |
| 0:20-1:15 | Create/select Agent, submit the normal task, Watch trace live | "This is a real task. We can inspect observed model and tool events while the Run is executing." |
| 1:15-1:45 | Expand a command, inspect usage/duration, export completed Run | "These are the stored backend records. The export applies redaction again; cost stays Not priced unless rates are configured." |
| 1:45-2:30 | Start the waiting task, observe its command begin, press Stop | "The operator interrupts this Run. Its recorded steps remain inspectable and its open spans receive an end boundary." |
| 2:30-3:00 | Start Agent again; run the generated file | "The Agent remains usable after cancellation. This is a single-user POC, not a multi-tenant security guarantee." |

## Normal task

```text
Create hello.js that prints "AgentLens demo". Create hello.test.js using Node's built-in node:test module, run node --test, then run node hello.js. Use no external dependencies or network downloads. Summarize the files and results.
```

Confirm that files and command execution actually exist, not just a prose claim
from the model. Inspect the completed Run's Trace and Export JSON. The downloaded
bundle can be independently checked using the runbook's `verify-audit.mjs` command.

## Controlled interruption and recovery

```text
Run node -e "setTimeout(() => console.log('wait finished'), 60000)" in the workspace, wait for it to finish, and then report the result. Do not start it in the background.
```

Wait until the command actually starts in the trace, then press the Agent's
**Stop** action. Expect a cancelled Run and a stopped Agent, with evidence retained
and unfinished span bounds closed. Press **Start**, then send:

```text
Run node hello.js again and report its output.
```

The model may not follow the waiting instruction exactly; observe the actual
behavior during rehearsal. In Compose, cancellation targets the Codex process
and is not proof that every descendant process has been cleaned up. Stop the
application container if the waiting task appears to remain active.

Do not use a failing assertion as a guaranteed red Run: a tool may exit non-zero
while the model successfully reports that result, and tool-error classification
is incomplete. Cancellation/recovery is the chosen abnormal scenario. A genuine
failed Run can be shown additionally if one occurs, without inventing failure.

## Optional additional evidence

- Compare the completed and cancelled Runs in the history view.
- Verify the exported bundle outside the UI.
- Rehearse restart reconciliation separately if time permits, using the same
  data directories; describe the actual result rather than guaranteeing a
  specific process shutdown sequence.

These extras must not crowd out the required functional path. Keep test fixtures
explicitly labelled, and stop the app after recording as described in the runbook.
