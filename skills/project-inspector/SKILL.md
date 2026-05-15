---
name: project-inspector
description: Inspect a registered project and produce a concise technical orientation. Use when ChatGPT, Codex, or a spawned agent needs to understand project structure, important files, scripts, risks, and next verification steps before making changes.
---

# Project Inspector

Inspect the project before recommending or changing anything.

## Workflow

1. Identify the project root, package files, config files, source directories, tests, scripts, generated folders, and ignored folders.
2. Read only the files needed to understand the current request.
3. Prefer existing project commands and documented workflows over invented ones.
4. Report concrete findings with file paths.
5. Separate confirmed facts from assumptions.

## Output

Return:

1. project type and main runtime;
2. key directories and files;
3. available scripts or validation commands;
4. likely edit locations for the requested task;
5. risks, blockers, or missing context;
6. recommended next action.
