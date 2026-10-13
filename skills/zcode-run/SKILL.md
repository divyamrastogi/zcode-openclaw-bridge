---
name: zcode-run
description: Drive the ZCode coding agent headlessly to do coding work in a repo (edit, refactor, fix, explain, review). Use when the user asks to run ZCode, delegate a coding task to ZCode, or when a task should be executed by a full coding agent rather than inline edits — e.g. "run zcode on this repo", "have ZCode fix the failing tests", "zcode-run".
---

# zcode-run — headless ZCode

Run a one-shot ZCode agent turn and get the final reply on stdout.

## Usage

```bash
zcode-run "TASK DESCRIPTION" --cwd /path/to/repo --mode edit --timeout 300
```

Rules:
- Always pass `--mode edit` (or `--mode plan` for read-only analysis). Do not run unrestricted modes from chat.
- Always pass `--cwd` pointing at the target repo.
- Quote the task as one argument. Put file paths inside the task text.
- The reply is plain text on stdout; stderr carries errors. On failure, retry once with `--debug` and read the error.

## Common tasks

```bash
# read-only code review / questions
zcode-run "Review src/auth.ts for security issues and list them" --cwd ~/projects/myapp --mode plan

# let ZCode edit files
zcode-run "Fix the failing test in tests/login.spec.ts" --cwd ~/projects/myapp --mode edit

# machine-readable output
zcode-run "Summarize the architecture in 5 bullets" --cwd ~/projects/myapp --mode plan --json
```

## Notes

- Each call is a fresh session; include all needed context in the task text.
- GLM models may prepend a little reasoning text before the actual answer — read the end of the output.
- Default model/provider come from `~/.zcode/v2/provider_config.headless.json`; override with `--provider`/`--model` if needed.
- Timeout defaults to 300s; long refactors may need `--timeout 600`.
