# Validation

Run validation from the project root.

## Standard Checks

Run:

```text
npm run check
npm test
npm run build
npm run flue:check
```

## Continuous integration

GitHub Actions runs the standard checks on `ubuntu-latest` and `windows-latest` with Node.js 20. Both matrix jobs run to completion independently when either job fails.

Process-ownership regressions exercise Windows descendant-tree cleanup and POSIX owned-process-group cleanup. The exit-order regression uses a real child with delayed application callbacks so native process reaping can proceed on either platform.

## Manual ChatGPT Verification

Use ChatGPT to verify project discovery, file read/write/move/delete behavior, delete confirmation, package script execution, search, symbol search, path boundary enforcement, spawned-agent lifecycle, session events, cleanup, config inspection, permission inspection, and agent limit inspection.

Also verify the expected failure messages for disabled spawned agents, zero agent limits, and missing provider credentials.

## Manual Codex Multi Machine Verification

Enable different MCPs, for example a Windows MCP and a Linux MCP in the same Codex session.

Confirm each entry lists its own registered projects and tools.

Read and write one file through each MCP, then verify the files landed on the intended machine.

Disable one MCP entry and confirm the session no longer has access to that machine.
