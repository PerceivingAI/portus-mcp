---
name: security-pass
description: Review a project or change for practical security risks. Use when ChatGPT, Codex, or a spawned agent needs to inspect trust boundaries, secret handling, filesystem access, command execution, network exposure, auth, permissions, or audit behavior.
---

# Security Pass

Look for exploitable behavior, not cosmetic concerns.

## Workflow

1. Identify trust boundaries: user input, MCP tool input, filesystem access, command execution, network exposure, provider credentials, and local state.
2. Trace risky inputs to sensitive sinks.
3. Check whether policy gates are enforced before the sink.
4. Check whether errors and outputs expose secrets, absolute paths, raw logs, or unnecessary internal state.
5. Prefer direct evidence from code and tests.
6. Recommend fixes that remove the cause of the risk.

## Output

Return findings first, ordered by severity.

For each finding include:

1. severity;
2. affected file or tool;
3. risk;
4. evidence;
5. recommended fix;
6. test coverage needed.

If no issue is found, say that clearly and list residual risks.
