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

GitHub Actions runs the standard checks on `ubuntu-latest` and `windows-latest` with Node.js 24. Checkout and Node setup also use Node 24-based actions. Both matrix jobs run to completion independently when either job fails.

`npm test` enumerates the top-level `tests/*.test.ts` files and uses Node's programmatic runner to start measured slow files first. Each file runs in its own process, with four files at a time by default. Set `PORTUS_TEST_CONCURRENCY` to a positive integer to override that limit. Node filtering options still pass through, for example `npm test -- --test-name-pattern="owned child exit"`.

Process-ownership regressions exercise Windows descendant-tree cleanup and POSIX owned-process-group cleanup. The exit-order regression uses a real child with delayed application callbacks so native process reaping can proceed on either platform.

The full outage-deadline recovery case runs in its own file so its real wait overlaps other tests. Native process cleanup and production recovery deadlines/backoffs are unchanged.

Stream timing tests advance only the application's one-second event poll while HTTP/socket timers and bounded I/O readiness stay native. A real-timer background stream failure case and native recovery/deadline cases remain in the suite.

After compilation, CI also runs an execution-session smoke outside the test runner. It checks that successful and failed commands expose their complete stdout/stderr when terminal status is returned, then removes the disposable state.

CI caches installed dependencies only for an exact match of OS, architecture, Node version/ABI, runner image, and package/lockfile hashes. Cache misses run `npm ci`, including lifecycle scripts and auditing. Exact hits reuse that completed installation and run a fresh `npm audit --audit-level=none`, retaining non-blocking vulnerability-severity reporting. Installed snapshots are saved only after the job succeeds; no partial-key or cross-OS reuse is enabled.

## Manual ChatGPT Verification

Use ChatGPT to verify project discovery, file read/write/move/delete behavior, delete confirmation, package script execution, search, symbol search, path boundary enforcement, spawned-agent lifecycle, session events, cleanup, config inspection, permission inspection, and agent limit inspection.

Also verify the expected failure messages for disabled spawned agents, zero agent limits, and missing provider credentials.

## Manual Codex Multi Machine Verification

Enable different MCPs, for example a Windows MCP and a Linux MCP in the same Codex session.

Confirm each entry lists its own registered projects and tools.

Read and write one file through each MCP, then verify the files landed on the intended machine.

Disable one MCP entry and confirm the session no longer has access to that machine.
