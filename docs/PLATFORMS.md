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
npm run smoke:health
npm run smoke:flue-lifecycle
```

Start the server with:

```text
npm start
```

Expose it when needed:

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
npm run smoke:health
npm run smoke:flue-lifecycle
```

Verified environment:

```text
Linux x86_64
Node.js v25.6.1
npm 11.10.0
git 2.53.0
```

Node.js 20 or newer is required.

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
