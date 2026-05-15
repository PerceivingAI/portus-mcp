import { rmSync } from "node:fs";
import path from "node:path";

const target = path.resolve(".portus-mcp");
rmSync(target, { recursive: true, force: true });
console.log(`Removed ${target}`);
