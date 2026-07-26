import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";
import type echoComponent from "../src/component.js";

const marker = Symbol.for("tego.example.echo.loaded");

test("echo is executor-neutral and loading only records the fixture marker", async () => {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const beforeKeys = new Set(Reflect.ownKeys(globalThis));
  const beforeMarker = typeof globals[marker] === "number" ? globals[marker] : 0;
  const componentUrl = process.env.TEGO_ECHO_COMPONENT_URL;
  assert.ok(componentUrl, "test runner must provide the temporary compiled component URL");
  const component = (await import(`${componentUrl}?test=${Date.now()}`))
    .default as typeof echoComponent;

  const addedKeys = Reflect.ownKeys(globalThis).filter((key) => !beforeKeys.has(key));
  assert.deepEqual(addedKeys, beforeKeys.has(marker) ? [] : [marker]);
  assert.equal(globals[marker], beforeMarker + 1);

  assert.equal(component.protocol, "tego.component/1.0");
  assert.equal(component.kind, "task");
  const input = { nested: ["unchanged", 1, true] };
  const run = component.run;
  assert.notEqual(run, undefined);
  if (run === undefined) {
    throw new Error("echo component does not define run");
  }
  assert.strictEqual(await run(undefined as never, input), input);

  const source = await readFile(new URL("../src/component.ts", import.meta.url), "utf8");
  assert.match(source, /import\s*\{\s*defineComponent\s*\}\s*from\s*["']@tegojs\/plugin-sdk["']/u);
  assert.doesNotMatch(source, /@tegojs\/(?:executor|transport)/u);

  const manifest = JSON.parse(
    await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
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
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}), ["@tegojs/plugin-sdk"]);
  await assert.rejects(access(new URL("../build", import.meta.url)), { code: "ENOENT" });
});
