# Validation

Run validation from the project root.

## Standard Checks

Run:

```text
npm run check
npm test
npm run build
npm run flue:check
npm run smoke:health
npm run smoke:flue-lifecycle
npm run validate:public
```

## Provider-Backed Smoke

This check requires real configured credentials for the selected provider:

```text
npm run smoke:flue-write
```

If credentials are unavailable, mark it blocked instead of failed.

## Staged Public Folder

After staging the public folder, run:

```text
npm run validate:public -- portus-mcp
npm --prefix portus-mcp run check
```

## Manual ChatGPT Verification

Use ChatGPT to verify project registration, file read/write/move/delete behavior, delete confirmation, package script execution, search, symbol search, path boundary enforcement, spawned-agent lifecycle, session events, cleanup, config inspection, permission inspection, and agent limit inspection.

Also verify the expected failure messages for disabled spawned agents, zero agent limits, and missing provider credentials.

## Manual Codex Multi Machine Verification

Enable different MCPs, for example a Windows MCP and a Linux MCP in the same Codex session.

Confirm each entry lists its own registered projects and tools.

Read and write one file through each MCP, then verify the files landed on the intended machine.

Disable one MCP entry and confirm the session no longer has access to that machine.
