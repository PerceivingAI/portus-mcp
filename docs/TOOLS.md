# MCP Tools

Portus MCP exposes project, agent, session, skill, config, permission, and audit tools.

The exact tool names shown in your client may include the MCP server name as a prefix.

## Project Tools

Project tools operate inside registered project roots.

They cover file reads, writes, copies, moves, deletes, directory creation/deletion, file info, existence checks, tree/list/search operations, text edits, patch application, allowlisted project commands, package script discovery, and approved script execution.

Main controls:

```text
project-root path enforcement
blocked path patterns
gitignored-file policy
direct permission gates
delete confirmation
policy limits
audit writes
```

Project file reads use `limits.fileRead.maxChars` from `portus-mcp.policy.json`.

Callers cannot override char output limits per request.

Returned text is hard cut at the configured char limit. Char counts use Unicode code points. Limited responses return `chars`, `totalChars`, `omittedChars`, `truncated`, and `limit` metadata when applicable.

`project_read_file_range` reads a 1-based, inclusive line interval from a project text file. It requires only `readFiles`, is read-only and unaudited, and applies the same project-root, blocked-path, and Git-ignore policy as `project_read_text_file`. A request may span at most 2,000 lines.

The server's `limits.fileRead.maxChars` setting is authoritative; callers cannot supply a per-request character limit. `truncated` means the requested interval's content was cut by that character limit, with the returned character counters and `limit` describing the cut. `hasMore` means a line exists after the requested `endLine`, determined with one-line lookahead.

`project_read_files` reads 1–20 file requests in one call and returns one result per request in the same order, including duplicate requests. Each request contains `relativePath` and optional `startLine` and `endLine`: ranges are 1-based and inclusive, `startLine` defaults to 1, and `endLine` defaults to `startLine + 199` (a 200-line window). A range may span at most 2,000 lines.

The tool requires only `readFiles` and is read-only and unaudited. Each successful result is independently subject to the server's `limits.fileRead.maxChars`; callers have no output-size controls. Project-root, blocked-path, Git-ignore, directory, and binary-file protections match the single-file read tools. Invalid or unreadable requests produce per-item errors without preventing other requests from succeeding.

Project text search and symbol search scan at most `limits.search.maxScanEntries` files.

Skill folder reads are capped by `limits.skills.maxReadChars`.

`project_run_command` runs one command from `chatgpt.permissions.allowedCommands` inside the registered project root.

`project_prepare_patch` inspects a unified diff before application. It accepts `projectAlias`, `patch`, and optional `includeHash` (default `true`), requires the `readFiles` permission, and is read-only: it neither applies the patch nor writes an audit event.

The tool parses at most 100 unique patch paths. Every path must pass project-root and blocked-path policy; existing files must also pass the Git-ignore read policy, while new or otherwise missing files are reported with `exists: false`.

It returns `projectAlias`, deduplicated `changedFiles` and `deletedFiles`, `expectedFiles`, and `readyForApply`. Each existing-file entry in `expectedFiles` includes `relativePath`, `exists: true`, `sizeBytes`, `modifiedAt`, `isTextLikely`, and, unless `includeHash` is `false`, `sha256`; missing-file entries include `relativePath` and `exists: false`. Pass `expectedFiles` to `project_apply_patch` to check that the inspected files have not changed before application.

## Agent Tools

Agent tools start or inspect spawned Flue agent sessions.

Tools:

```text
agent_spawn
agent_run_task
agent_run_skill
agent_status
agent_collect_result
agent_stop
agent_limits
agent_templates
agent_template_describe
```

Agent tools are gated by `chatgpt.permissions.spawnAgents` and the `agents` policy settings.

## Session Tools

Session tools inspect and manage spawned-agent sessions.

Use them for active/completed session listing, status, logs, events, artifacts, stop-all, cleanup, and completed-session cleanup.

Use `session_read_events` when you need progress without rereading the full log.

## Skill Tools

Skills are folders under `skills/`.

Example:

```text
skills/security-pass/SKILL.md
skills/security-pass/agents/openai.yaml
```

Tools:

```text
skill_list
skill_read
skill_run
```

- `skill_list` returns skill names and descriptions from `SKILL.md` frontmatter.
- `skill_read` reads every regular file in the selected skill folder.
- `skill_run` starts a spawned-agent task with the full selected skill contents.
- `skill_describe` is not part of the tool surface.

## Config And Permission Tools

These tools expose safe config, effective config, permission state, policy path checks, permission explanations, and audit events.

They do not return provider credential values.

## Destructive Tools

- `project_delete_file`: Deletes one file inside a registered project and requires `confirm=true`.
- `project_delete_directory`: Deletes one directory inside a registered project and requires `confirm=true`.
- `project_apply_patch`: Applies a unified diff patch; `confirm=true` is required when the patch deletes files.
- `project_run_command`: Runs one allowlisted project command; non-read-only Git commands and non-Git commands require `confirm=true`.

Move and write tools are permission-gated, but they do not ask for delete-style confirmation.

Users can disable move/delete capability and remove command access in `portus-mcp.policy.json`.

## Agent Session Cleanup

- `session_cleanup`: Deletes stored artifacts for one completed, failed, or stopped agent session, without deleting project files.
- `session_cleanup_completed`: Deletes stored artifacts for old completed, failed, or stopped agent sessions, without deleting project files.
