import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const marker = Symbol.for("tego.example.echo.loaded");

test("echo is executor-neutral and loading only records the fixture marker", async () => {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const beforeKeys = new Set(Reflect.ownKeys(globalThis));
  const beforeMarker = typeof globals[marker] === "number" ? globals[marker] : 0;
  const component = (await import(`../src/component.js?test=${Date.now()}`)).default;

  const addedKeys = Reflect.ownKeys(globalThis).filter((key) => !beforeKeys.has(key));
  assert.deepEqual(addedKeys, beforeKeys.has(marker) ? [] : [marker]);
  assert.equal(globals[marker], beforeMarker + 1);

  const input = { nested: ["unchanged", 1, true] };
  assert.strictEqual(await component.run(undefined as never, input), input);

  const source = await readFile(new URL("../../src/component.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /@tegojs\/(?:executor|transport)/u);

  const manifest = JSON.parse(
    await readFile(new URL("../../manifest.json", import.meta.url), "utf8"),
  ) as {
    components: readonly {
      executors: readonly string[];
      process?: unknown;
      remote?: unknown;
      thread?: unknown;
    }[];
    permissions: readonly {
      kind: string;
      executors?: readonly string[];
    }[];
  };
  assert.deepEqual(manifest.components[0]?.executors, ["process", "thread", "remote"]);
  assert.deepEqual(manifest.permissions, [
    {
      kind: "executor",
      executors: ["process", "thread", "remote"],
    },
  ]);
  assert.equal("process" in (manifest.components[0] ?? {}), false);
  assert.equal("thread" in (manifest.components[0] ?? {}), false);
  assert.equal("remote" in (manifest.components[0] ?? {}), false);

  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}), ["@tegojs/plugin-sdk"]);
});
