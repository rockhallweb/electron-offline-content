import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const storageRoot = process.argv[2];
if (!storageRoot) {
  console.error("Expected storageRoot argument.");
  process.exit(1);
}

const lockFilePath = join(storageRoot, ".media-cache.lock");
const metadata = {
  lockId: randomUUID(),
  pid: process.pid,
  hostname: hostname(),
  storageRoot,
  acquiredAt: new Date().toISOString(),
};

writeFileSync(lockFilePath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });

const cleanup = () => {
  rmSync(lockFilePath, { force: true });
};

process.once("exit", cleanup);
process.once("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.once("SIGINT", () => {
  cleanup();
  process.exit(0);
});

process.stdout.write("READY\n");
setInterval(() => {}, 1000);
