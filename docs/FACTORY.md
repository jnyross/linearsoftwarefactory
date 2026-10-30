# Linear Software Factory

The factory turns ideas in Linear team **LOO** (Loop Code Factory) into code on `main` of this repository, without pull requests or routine human approval.

## Moving parts

| Part | Where | What it does |
| --- | --- | --- |
| Controller thread | One persistent Amp orb thread in this project (ID in `factory/config.json`) | Hosts the plugin and the schedule. Never archive it. |
| Controller plugin | `.amp/plugins/lsf.ts` | Registers `lsf_tick` only when the orb's thread is the controller. |
| Tick | `factory/controller.ts` | Reads Linear, calls `decide`, performs each step, persists the ledger. |
| Decision logic | `factory/core.ts` | Pure state machine: dispatch, monitoring, failure routing, escalation, waits. |
| Worker prompts | `factory/prompts.ts` | Role instructions plus standing authority and the failure protocol. |
| Ledger | `~/.local/state/lsf/ledger.json` in the controller orb | Jobs, attempts, resolution records, waits. Linear markers make it recoverable. |

### Triggers

- A native Amp schedule on the controller thread wakes it about once a minute; the run calls `lsf_tick`.
- Every worker ends by sending `lsf-callback ...` to the controller thread with `send_thread_message`, which wakes it immediately, so handoffs do not wait for the next minute. The controller never polls a worker for completion; it checks worker thread state only to detect stalls.
- Messages queue on the controller thread, and the plugin shares one in-flight tick, so runs never overlap.

Linear webhooks are not used: polling once a minute was accepted, and an Amp plugin webhook would still need a Linear admin to register the endpoint. `factory/controller.ts` is event-source agnostic if a webhook is added later.

## Linear mapping

| Linear | Meaning |
| --- | --- |
| **Backlog**, no parent, not `lsf:build`/`lsf:test` | Idea intake. The controller labels it `lsf:idea`, moves it to **In Progress**, and dispatches a planner. |
| `lsf:idea` + `lsf:planned`, **In Progress** | Planned idea; moves to **Done** with `lsf:delivered` when all its `lsf:build` sub-issues are closed. |
| `lsf:build` sub-issue of an idea, **Todo** (or **Backlog**) | Ready to build once its parent is planned and all `blockedBy` issues are closed. |
| `lsf:build`, **In Progress** | One builder agent owns it on branch `lsf/<issue>`. |
| `lsf:build`, **In Progress** + `lsf:built` | Built; its `lsf:test` sub-issues run, one tester agent per test issue. |
| `lsf:build`, **In Progress** + `lsf:built` + `lsf:integrating` | The single integrator is merging it into `main`. |
| `lsf:build` + `lsf:integrated` (normally **Done**) | Integrated into `main`. |
| `lsf:test` sub-issue of a build, **Todo** / **In Progress** / **Done** + `lsf:passed` | Waiting / tester running / passed. Failures go back to the build. |
| `lsf:repair` | A build was sent back to its builder after a failure. |
| `lsf:resolution-needed` | Resolution Needed: the latest `lsf-failure` comment holds evidence; the controller routes it. |
| `lsf:waiting-dependency` | Waiting on dependency or cooling down; retried automatically after backoff. |
| `lsf:hold` | Opt-out: the factory ignores the issue. |
| **Triage**, **Canceled**, **Duplicate** | Not touched by the factory (Canceled and Duplicate count as closed for dependencies). |
| Completion labels | `lsf:integrated`, `lsf:passed`, and `lsf:delivered` are the factory's record of finished work. The pre-existing Linear Loops in LOO move issues out of **Done** back to **Backlog**; the factory does not redo labelled work. |
| **In Review** | Not used. A pre-existing Linear Loop (Linear Agent automation) in LOO runs a QA check whenever an issue enters In Review and returns it to Backlog, so the factory tracks "built, awaiting tests" with the `lsf:built` label instead. Sub-issues bounced to Backlog are picked up again. |

Every dispatch writes an `<!-- lsf-dispatch {...} -->` comment with the worker thread link. Every failure writes an `<!-- lsf-failure {"stage","kind","signature"} -->` comment with evidence.

## Pipeline

1. **Plan**: the planner creates build sub-issues (acceptance criteria, dependencies as `blockedBy`) and one to three test sub-issues per build, then adds `lsf:planned`.
2. **Build**: independent builds run in parallel (limit 4), one builder per issue. The builder pushes `lsf/<issue>` and adds `lsf:built`.
3. **Test**: one tester per test sub-issue (limit 6) tests the branch merged with the latest `origin/main`. Pass: test Done. Fail: Resolution Needed on the build.
4. **Integrate**: one integrator at a time merges the branch into the latest `origin/main`, resolves conflicts, runs `bun test` on the combined result, and pushes `main`; non-fast-forward pushes are refetched, retested, and retried.
5. **Close**: the idea moves to Done when its builds are closed.

## Resolution Needed and recovery

Workers carry standing authority to investigate, assume, fix, retest, and continue. When local recovery is exhausted, a worker posts an `lsf-failure` comment with a stable signature and adds `lsf:resolution-needed`. The controller also raises it for stalled, errored, timed-out, or orphaned work.

The controller keeps one resolution record per issue, stage, and normalised signature, and escalates by how often that exact failure has repeated:

| Stage / kind | 1st | 2nd | 3rd | 4th+ |
| --- | --- | --- | --- | --- |
| build or test failure | builder repair (resumes the previous builder thread when idle) | repair with a different approach | resolver | resolver with re-plan authority |
| integrate (conflict, combined failure, push rejected) | integration retry | builder repair against latest main | resolver | resolver with re-plan authority |
| plan | planner retry | resolver | resolver with re-plan authority | |
| stale or worker error | retry the stage | resolver | resolver | resolver with re-plan authority |
| unclear requirements or setup | resolver | resolver | resolver with re-plan authority | |
| resolver failed | resolver | resolver with re-plan authority | cooldown, then a fresh resolver | |
| dependency (external) | wait with backoff (5 min, doubling, max 6 h), then retry the stage | | | |

After 12 routes on one issue, the issue cools down for 6 hours and then gets a fresh resolver diagnosis. Nothing waits for a human. Each work unit (a build and its tests) has at most one mutating agent at a time: a repair or resolver cancels the unit's testers, and test sub-issues reset to Todo after any repair. Limits cap resolvers at 2 and all workers at 10. A failed or waiting issue blocks only its dependants.

Stall detection: a worker that is idle while Linear still shows its stage in progress is nudged once after 3 minutes; if it is still idle 15 minutes after the nudge, the stage gets a `stale` failure. Threads in the error state for 10 minutes get `worker-error`. Workers running for more than 4 hours are cancelled.

## Safeguards

- Workers run in the plugin's `lsf-worker` mode: the `medium` prompt and tools with the model pinned to `openai/gpt-6.1-sol` (high effort), served by John's ChatGPT subscription, and no extra features (no `fast` or `plaid`). Amp requires a registered custom mode for orb threads spawned from a plugin tool, and custom modes do not follow the Tune Modes preset, so the pin lives in `factory/config.json`. Nothing changes billing or model settings.
- No pull requests; only the integrator pushes `main`, and never with force. Builders push only their branch; testers push nothing.
- Tests are never weakened to get a pass, and unverified work is never marked Done.

## Operating

- Pause: pause the controller thread's schedule, or add `lsf:hold` to an issue.
- Retry now: remove `lsf:waiting-dependency` from an issue, or remove the label and post a new comment explaining why.
- Inspect: the controller thread transcript shows each tick summary; Linear comments show every dispatch, failure, route, and result.
- Tests: `bun test` runs the controller simulation tests (`factory/controller.test.ts`) along with the product tests.
