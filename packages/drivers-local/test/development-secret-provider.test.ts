import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diagnosticCode, type Clock, type SecretProvider } from "@tegojs/contracts";
import {
  createLocalDrivers,
  DevelopmentSecretProvider,
  DEVELOPMENT_SECRET_PROVIDER_NOTICE,
} from "../src/index.js";

const clock: Clock = {
  now: () => new Date("2026-07-23T12:00:00.000Z"),
  sleep: async () => {},
};

test("development secret provider snapshots plain JSON configuration and closes idempotently", async () => {
  const values = { API_TOKEN: "secret-value" };
  const provider: SecretProvider = new DevelopmentSecretProvider({ clock, values });

  values.API_TOKEN = "mutated";
  assert.equal(DEVELOPMENT_SECRET_PROVIDER_NOTICE.includes("not for production"), true);
  assert.equal(provider.developmentOnly, true);

  await provider.open();
  assert.equal(await provider.get("API_TOKEN"), "secret-value");
  assert.equal(await provider.get("MISSING"), undefined);
  assert.deepEqual(await provider.health(), {
    status: "healthy",
    checkedAt: "2026-07-23T12:00:00.000Z",
    message: DEVELOPMENT_SECRET_PROVIDER_NOTICE,
  });

  await Promise.all([provider.close(), provider.close(), provider.close()]);
  await provider.close();
  await assert.rejects(
    provider.get("API_TOKEN"),
    (error: unknown) => diagnosticCode(error) === "BOOTSTRAP_SECRET_PROVIDER_CLOSED",
  );
});

test("development secret provider rejects accessors, exotic objects, and non-string values", () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "API_TOKEN", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "do-not-read";
    },
  });

  assert.throws(
    () => new DevelopmentSecretProvider({ values: accessor as never }),
    /data propert/u,
  );
  assert.equal(getterCalls, 0);
  assert.throws(
    () => new DevelopmentSecretProvider({ values: new (class Values {})() as never }),
    /plain object/u,
  );
  assert.throws(
    () => new DevelopmentSecretProvider({ values: { API_TOKEN: 7 } as never }),
    /string/u,
  );
  assert.throws(
    () => new DevelopmentSecretProvider({ values: { API_TOKEN: "\ud800" } }),
    /Unicode/u,
  );
});

test("local driver composition includes the explicit development secret bootstrap driver", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tego-secrets-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const drivers = await createLocalDrivers({
    clock,
    dataDirectory: root,
    developmentSecrets: { API_TOKEN: "secret-value" },
  });

  assert.ok(drivers.secrets instanceof DevelopmentSecretProvider);
  await drivers.secrets.open();
  assert.equal(await drivers.secrets.get("API_TOKEN"), "secret-value");
  await drivers.secrets.close();
});
