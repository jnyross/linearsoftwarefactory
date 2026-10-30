# linearsoftwarefactory

This repository is built by the Linear Software Factory (see docs/FACTORY.md). Agents working here are usually factory workers dispatched from Linear team LOO.

## Layout

- `src/`: product code (TypeScript, run with Bun).
- `test/`: product tests (`*.test.ts`, `bun:test`).
- `factory/`: the factory controller (pure decision logic, controller tick, worker prompts, tests).
- `.amp/plugins/lsf.ts`: Amp plugin that exposes the controller as the `lsf_tick` tool in the controller thread.

## Rules

- The full suite is `bun test` at the repository root. It must pass before any push.
- Product workers do not modify `factory/` or `.amp/` unless their Linear issue explicitly targets the factory.
- Delivery goes directly to `main` through the factory integrator. No pull requests. Never force-push `main`.
- Builders push only their `lsf/<issue>` branch. Testers push nothing.
- Never weaken, skip, or delete tests to get a pass, and never mark unverified work Done.
- Use only the existing subscription model routes. Do not change Amp, billing, or model-provider settings.
- Never archive the factory controller thread.
