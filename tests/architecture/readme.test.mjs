import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readmeUrl = new URL("../../README.md", import.meta.url);

test("README documents project scope and executable contributor paths", async () => {
  assert.equal(existsSync(readmeUrl), true, "README.md must exist");
  const readme = await readFile(readmeUrl, "utf8");

  for (const marker of [
    "# Tego Next",
    "Node.js 26.5.0",
    "npm ci",
    "npm run build",
    "npm run typecheck",
    "npm test",
    "docker compose up -d postgres",
    "TEGO_POSTGRES_URL",
    "npm run test:integration",
    "@tegojs/runtime",
    "@tegojs/plugin-sdk",
    "@tegojs/drivers-local",
    "@tegojs/drivers-postgres",
    "@tegojs/executor-node",
    "@tegojs/transport-websocket",
    "examples/echo-plugin",
    "Conventional Commits",
  ]) {
    assert.match(readme, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
});
