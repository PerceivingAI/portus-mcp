# MCP Tools

Portus MCP exposes project, agent, session, skill, config, permission, and audit tools.

The exact tool names shown in your client may include the MCP server name as a prefix.

## Project Tools

Project tools operate inside registered project roots.

They cover file reads, writes, copies, moves, deletes, directory creation/deletion, file info, existence checks, tree/list/search operations, text edits, patch application, git status/diff tools, package script discovery, and approved script execution.

Main controls:

```text
project-root path enforcement
blocked path patterns
gitignored-file policy
direct permission gates
delete confirmation
output caps
input caps
audit writes
```

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

Agent tools are gated by `chatgpt.spawnAgents` and the `agents` policy settings.

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

`skill_list` returns skill names and descriptions from `SKILL.md` frontmatter.

`skill_read` reads every regular file in the selected skill folder.

`skill_run` starts a spawned-agent task with the full selected skill contents.

`skill_describe` is not part of the tool surface.

## Config And Permission Tools

These tools expose safe config, effective config, permission state, policy path checks, permission explanations, and audit events.

They do not return provider credential values.

## Destructive Behavior

Delete tools require explicit confirmation.

Move and write tools are permission-gated, but they do not ask for delete-style confirmation.

Users can disable move/delete capability in `portus-mcp.policy.json`.
