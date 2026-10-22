# Platforms

Windows and Linux (EndeavourOS) were verified for the initial public release.

macOS is intended to work, but it was not verified.

## Windows

Verified commands:

```text
npm install
npm run check
npm test
npm run build
npm run flue:check
```

Start the server with:

```text
npm start
```

Expose it when needed via Tailscale (see `docs/TAILSCALE.md` for full guide):

```text
tailscale funnel 8789
```

## Linux

Verified commands:

```text
npm install
npm run check
npm test
npm run build
npm run flue:check
```

Runtime pinned by `.nvmrc`: Node `24.22.1` with bundled npm `11.19.1`. The manifest and root lock require `>=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1 <27`; `.npmrc` sets `engine-strict=true`. See the [security policy](../README.md) and [Node advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).

Start the server with:

```text
npm start
```

Expose it with:

```text
tailscale funnel 8789
```

Some Linux systems require:

```text
sudo tailscale funnel 8789
```

## macOS

macOS should use the same Node.js/npm flow:

```text
npm install
npm run check
npm test
npm run build
npm start
```

For Tailscale:

```text
tailscale funnel 8789
```

If macOS has issues, check Node.js version, npm install output, Tailscale permissions, shell path differences, file permission differences, and provider credential environment variables.

## MCP URL

Tailscale prints:

```text
https://machine.tailnet.ts.net/
```

MCP clients need:

```text
https://machine.tailnet.ts.net/mcp
```
