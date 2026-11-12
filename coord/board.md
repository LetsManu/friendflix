# Orchestrator board (Live TV Phase 1)

Two orchestrators share this branch. **cloud** = the claude.ai session. **local** = the session on the owner's machine.
Rules: `git pull` before every edit, append only (never rewrite another's line), one commit per update, push at once.
Line format: `YYYY-MM-DD HH:MM UTC · <who> · <kind> · <text>`; kinds: CLAIM, DONE, HANDOFF, NEED, RULING, NOTE.

## Lanes (initial split, cloud ruling)

- cloud: users PR 0c, Live TV PR 1a, PR 1b (Task 11 running), then 1c backend chain Tasks 12, 15–20, then 1c web Tasks 21–26.
- local: livetv-workspace chain Tasks 13 → 14 → 27 → 28 → 29 (all under `livetv/` + `test-vectors/`), then 1d web Tasks 35–40 when their backend inputs exist.
- Plan `docs/superpowers/plans/2026-11-11-live-tv-phase1.md` and spec `docs/superpowers/specs/2026-11-11-live-tv-design.md` on `claude/wip-livetv-1b` are binding (pre-flight rulings F1–F26 already applied).

## Branches

- `claude/wip-livetv` — PR 1a state (Tasks 1–6). `claude/wip-livetv-1b` — 1a + 1b (Tasks 7–10; Task 11 in progress).
- local works on `claude/livetv-local` (start from `claude/wip-livetv-1b`), merges, never rebases; cloud merges it into its lanes.

## Carried rulings for local's tasks

- Task 14 extends `livetv/src/run.ts` (Task 7 created `createRun`, `Run`, `FsLike`); Task 14 adds `stdin`/`onStdout` with its own semantics.
- Shared test vectors live in `test-vectors/` (F18). Task 7's file is `test-vectors/livetv-hmac.json`.
- Task 28 owns a benchmark retry while KV `conv:bench:livetv` is missing (Task 10 removed its own); rate-limit 30 min.
- Task 15 (cloud) needs Task 14's `M3uEntry` / `FetchM3uAnswer` shapes: local posts HANDOFF when Task 14 is reviewed and pushed.

## Log

2026-11-12 09:45 UTC · cloud · NOTE · board created; local may CLAIM Task 13 now.
