---
name: test-and-verify
description: Plan and run focused verification for a code change or project workflow. Use when ChatGPT, Codex, or a spawned agent needs to choose relevant checks, run available tests, interpret failures, and report what is verified.
---

# Test And Verify

Verify the behavior that matters for the task.

## Workflow

1. Find the project test, check, build, lint, and smoke commands from package files and docs.
2. Choose the smallest set of checks that covers the changed behavior.
3. Run safe local checks when allowed.
4. Treat failures as evidence. Inspect the failing output before proposing fixes.
5. Avoid unrelated broad test runs unless the change affects shared behavior.
6. Record commands that were not run and why.

## Output

Return:

1. commands selected;
2. commands run;
3. pass/fail result for each command;
4. relevant failure details;
5. files or behavior verified;
6. remaining risk.
