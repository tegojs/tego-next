import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseApplicationId,
  parseCapabilityName,
  parsePluginId,
  type PluginDeploymentIdentity,
} from "@tegojs/contracts";
import {
  isValidVersion,
  isValidVersionRange,
  resolveCapabilities,
  satisfiesVersionRange,
  type CapabilityResolutionDeployment,
} from "../src/index.js";

const applicationId = parseApplicationId("application-01");

function identity(pluginId: string): PluginDeploymentIdentity {
  return { applicationId, pluginId: parsePluginId(pluginId) };
}

function deployment(
  pluginId: string,
  overrides: Partial<CapabilityResolutionDeployment> = {},
): CapabilityResolutionDeployment {
  return {
    identity: identity(pluginId),
    ready: true,
    provides: [],
    requires: [],
    bindings: {},
    ...overrides,
  };
}

const echoName = parseCapabilityName("org.example.echo");
const auditName = parseCapabilityName("org.example.audit");

test("@spec:capability-resolution/deterministic-provider-selection/one-compatible-provider", () => {
  const result = resolveCapabilities({
    deployments: [
      deployment("consumer", {
        requires: [{ name: echoName, protocolRange: "^1.0.0" }],
      }),
      deployment("provider", {
        provides: [{ name: echoName, protocolVersion: "1.2.0" }],
      }),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.order, [identity("provider"), identity("consumer")]);
  assert.deepEqual(result.bindings, [
    {
      consumer: identity("consumer"),
      requirement: {
        name: echoName,
        protocolRange: "^1.0.0",
        lossPolicy: "fail",
        optional: false,
      },
      provider: {
        deployment: identity("provider"),
        capability: { name: echoName, protocolVersion: "1.2.0" },
      },
    },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("explicit bindings take precedence and never fall back", async (context) => {
  const compatible = deployment("provider-a", {
    provides: [{ name: echoName, protocolVersion: "1.1.0" }],
  });
  const other = deployment("provider-b", {
    provides: [{ name: echoName, protocolVersion: "1.2.0" }],
  });

  await context.test("compatible binding", () => {
    const result = resolveCapabilities({
      deployments: [
        deployment("consumer", {
          requires: [{ name: echoName, protocolRange: "^1.0.0" }],
          bindings: { [echoName]: identity("provider-b") },
        }),
        compatible,
        other,
      ],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.bindings?.[0]?.provider?.deployment, identity("provider-b"));
  });

  for (const [label, provider, code] of [
    ["missing", identity("missing"), "CAPABILITY_EXPLICIT_PROVIDER_MISSING"],
    [
      "incompatible",
      identity("provider-incompatible"),
      "CAPABILITY_EXPLICIT_PROVIDER_INCOMPATIBLE",
    ],
    ["unready", identity("provider-unready"), "CAPABILITY_EXPLICIT_PROVIDER_UNREADY"],
  ] as const) {
    await context.test(label, () => {
      const result = resolveCapabilities({
        deployments: [
          deployment("consumer", {
            requires: [{ name: echoName, protocolRange: "^1.0.0" }],
            bindings: { [echoName]: provider },
          }),
          compatible,
          deployment("provider-incompatible", {
            provides: [{ name: echoName, protocolVersion: "2.0.0" }],
          }),
          deployment("provider-unready", {
            ready: false,
            provides: [{ name: echoName, protocolVersion: "1.0.0" }],
          }),
        ],
      });
      assert.equal(result.ok, false);
      assert.equal(result.bindings, undefined);
      assert.equal(result.order, undefined);
      assert.equal(result.diagnostics[0]?.code, code);
    });
  }
});

test("binding lookup ignores prototypes and rejects unsafe own properties without invoking getters", () => {
  for (const name of ["constructor", "toString"]) {
    const capability = parseCapabilityName(name);
    const result = resolveCapabilities({
      deployments: [
        deployment("consumer", {
          requires: [{ name: capability, protocolRange: "^1.0.0" }],
        }),
        deployment("provider", {
          provides: [{ name: capability, protocolVersion: "1.0.0" }],
        }),
      ],
    });
    assert.equal(result.ok, true, name);
    assert.deepEqual(result.bindings?.[0]?.provider?.deployment, identity("provider"));
  }

  let invoked = false;
  const accessorBindings = {};
  Object.defineProperty(accessorBindings, echoName, {
    enumerable: true,
    get() {
      invoked = true;
      return identity("provider");
    },
  });
  const symbolBindings = { [Symbol("binding")]: identity("provider") };
  const invalidBindings = [
    accessorBindings,
    symbolBindings,
    new Map([[echoName, identity("provider")]]),
    { [echoName]: () => identity("provider") },
  ];
  for (const bindings of invalidBindings) {
    const result = resolveCapabilities({
      deployments: [
        deployment("consumer", {
          requires: [{ name: echoName, protocolRange: "^1.0.0" }],
          bindings: bindings as never,
        }),
        deployment("provider", {
          provides: [{ name: echoName, protocolVersion: "1.0.0" }],
        }),
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, "CAPABILITY_BINDING_MAP_INVALID");
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
  assert.equal(invoked, false);
});

test("@spec:capability-resolution/required-and-optional-dependencies/optional-provider-absent", () => {
  const result = resolveCapabilities({
    deployments: [
      deployment("consumer", {
        requires: [{ name: echoName, protocolRange: "^1.0.0", optional: true }],
      }),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.bindings, [
    {
      consumer: identity("consumer"),
      requirement: {
        name: echoName,
        protocolRange: "^1.0.0",
        lossPolicy: "fail",
        optional: true,
      },
      provider: null,
    },
  ]);
});

test("missing, incompatible, and ambiguous providers produce stable sorted diagnostics", () => {
  const input = {
    deployments: [
      deployment("provider-z", {
        provides: [{ name: echoName, protocolVersion: "1.2.0" }],
      }),
      deployment("consumer", {
        requires: [
          { name: auditName, protocolRange: "^1.0.0" },
          { name: echoName, protocolRange: "^1.0.0" },
        ],
      }),
      deployment("provider-a", {
        provides: [{ name: echoName, protocolVersion: "1.1.0" }],
      }),
    ],
  } as const;

  const first = resolveCapabilities(input);
  const second = resolveCapabilities({
    deployments: [input.deployments[2], input.deployments[1], input.deployments[0]],
  });

  assert.equal(first.ok, false);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.diagnostics.map((diagnostic) => diagnostic.code),
    ["CAPABILITY_AMBIGUOUS", "CAPABILITY_REQUIRED_MISSING"],
  );
  assert.deepEqual(first.diagnostics[0]?.candidates, [
    identity("provider-a"),
    identity("provider-z"),
  ]);
});

test("@spec:capability-resolution/versioned-capability-identity/incompatible-protocol-version", () => {
  const result = resolveCapabilities({
    deployments: [
      deployment("consumer", {
        requires: [{ name: echoName, protocolRange: "^1.0.0" }],
      }),
      deployment("provider", {
        provides: [{ name: echoName, protocolVersion: "2.0.0" }],
      }),
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "CAPABILITY_REQUIRED_MISSING");
});

test("invalid or vacuous protocol ranges block resolution", () => {
  for (const range of ["", "||", ">=1.0.0 ||", "|| >=1.0.0", "nonsense || ^1.0.0"]) {
    const result = resolveCapabilities({
      deployments: [
        deployment("consumer", {
          requires: [{ name: echoName, protocolRange: range }],
        }),
        deployment("provider", {
          provides: [{ name: echoName, protocolVersion: "1.0.0" }],
        }),
      ],
    });
    assert.equal(result.ok, false, range);
    assert.equal(result.diagnostics[0]?.code, "CAPABILITY_PROTOCOL_RANGE_INVALID", range);
  }
});

test("@spec:capability-resolution/dependency-ordering-and-cycle-rejection/required-dependency-cycle", () => {
  const result = resolveCapabilities({
    deployments: [
      deployment("a", {
        provides: [{ name: echoName, protocolVersion: "1.0.0" }],
        requires: [{ name: auditName, protocolRange: "^1.0.0" }],
      }),
      deployment("b", {
        provides: [{ name: auditName, protocolVersion: "1.0.0" }],
        requires: [{ name: echoName, protocolRange: "^1.0.0" }],
      }),
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics, [
    {
      code: "CAPABILITY_REQUIRED_CYCLE",
      capability: null,
      consumer: null,
      candidates: [identity("a"), identity("b")],
      message: "Required capability dependencies form a cycle",
    },
  ]);
});

test("self cycles are rejected but optional cycles are not required cycles", () => {
  const self = resolveCapabilities({
    deployments: [
      deployment("self", {
        provides: [{ name: echoName, protocolVersion: "1.0.0" }],
        requires: [{ name: echoName, protocolRange: "^1.0.0" }],
      }),
    ],
  });
  assert.equal(self.ok, false);
  assert.equal(self.diagnostics[0]?.code, "CAPABILITY_REQUIRED_CYCLE");

  const optional = resolveCapabilities({
    deployments: [
      deployment("a", {
        provides: [{ name: echoName, protocolVersion: "1.0.0" }],
        requires: [{ name: auditName, protocolRange: "^1.0.0", optional: true }],
      }),
      deployment("b", {
        provides: [{ name: auditName, protocolVersion: "1.0.0" }],
        requires: [{ name: echoName, protocolRange: "^1.0.0", optional: true }],
      }),
    ],
  });
  assert.equal(optional.ok, true);
  assert.equal(
    optional.diagnostics.some((diagnostic) => diagnostic.code === "CAPABILITY_REQUIRED_CYCLE"),
    false,
  );
});

test("optional providers start first when doing so does not create a cycle", () => {
  const result = resolveCapabilities({
    deployments: [
      deployment("consumer", {
        requires: [{ name: echoName, protocolRange: "^1.0.0", optional: true }],
      }),
      deployment("provider", {
        provides: [{ name: echoName, protocolVersion: "1.0.0" }],
      }),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.order, [identity("provider"), identity("consumer")]);
});

test("duplicate deployments, providers, and requirements are rejected deterministically", () => {
  const cases = [
    {
      code: "CAPABILITY_DUPLICATE_DEPLOYMENT",
      deployments: [deployment("a"), deployment("a")],
    },
    {
      code: "CAPABILITY_DUPLICATE_PROVIDER",
      deployments: [
        deployment("a", {
          provides: [
            { name: echoName, protocolVersion: "1.0.0" },
            { name: echoName, protocolVersion: "1.0.0" },
          ],
        }),
      ],
    },
    {
      code: "CAPABILITY_DUPLICATE_REQUIREMENT",
      deployments: [
        deployment("a", {
          requires: [
            { name: echoName, protocolRange: "^1.0.0" },
            { name: echoName, protocolRange: "^2.0.0" },
          ],
        }),
      ],
    },
  ] as const;

  for (const item of cases) {
    const result = resolveCapabilities({ deployments: item.deployments });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, item.code);
  }
});

test("one deployment may expose distinct protocol versions of the same capability", () => {
  const result = resolveCapabilities({
    deployments: [
      deployment("consumer", {
        requires: [{ name: echoName, protocolRange: "^2.0.0" }],
      }),
      deployment("provider", {
        provides: [
          { name: echoName, protocolVersion: "1.0.0" },
          { name: echoName, protocolVersion: "2.1.0" },
        ],
      }),
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.bindings?.[0]?.provider?.capability.protocolVersion, "2.1.0");
});

test("strict versions reject invalid prerelease identifiers and compare prereleases below releases", () => {
  assert.equal(isValidVersion("1.0.0-01"), false);
  assert.equal(isValidVersion("1.0.0-alpha.1"), true);
  assert.equal(satisfiesVersionRange("1.0.0-alpha.1", ">=1.0.0"), false);
  assert.equal(satisfiesVersionRange("1.0.0+build.1", "=1.0.0"), true);
});

test("supported version ranges have strict partial, wildcard, caret, and prerelease semantics", () => {
  for (const [version, range, expected] of [
    ["99.0.0", "*", true],
    ["99.0.0", "x", true],
    ["99.0.0", "X", true],
    ["1.9.9", "1.x", true],
    ["2.0.0", "1.x", false],
    ["26.9.9", ">26", false],
    ["27.0.0", ">26", true],
    ["26.9.9", "<=26", true],
    ["27.0.0", "<=26", false],
    ["0.9.9", "^0", true],
    ["1.0.0", "^0", false],
    ["0.0.9", "^0.0", true],
    ["0.1.0", "^0.0", false],
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
    ["1.0.0-alpha", "=1.0.0-alpha", true],
    ["1.0.0-alpha", ">=1.0.0", false],
    ["1.0.0-alpha", ">=0.0.0", false],
    ["1.0.0-beta", ">=1.0.0-alpha <2.0.0", true],
    ["1.0.0-999999999999999999999999", ">=1.0.0-1000000000000000000000000", false],
    ["1.0.0-1000000000000000000000000", ">1.0.0-999999999999999999999999", true],
  ] as const) {
    assert.equal(satisfiesVersionRange(version, range), expected, `${version} ${range}`);
  }

  for (const range of ["1.0.0 - 2.0.0", "latest", ">=1.0.0 ||", "|| >=1.0.0"]) {
    assert.equal(isValidVersionRange(range), false, range);
    assert.equal(satisfiesVersionRange("1.5.0", range), false, range);
  }
});

test("static required cycles are diagnosed even when every provider is unready", () => {
  const result = resolveCapabilities({
    deployments: [
      deployment("a", {
        ready: false,
        provides: [{ name: echoName, protocolVersion: "1.0.0" }],
        requires: [{ name: auditName, protocolRange: "^1.0.0" }],
      }),
      deployment("b", {
        ready: false,
        provides: [{ name: auditName, protocolVersion: "1.0.0" }],
        requires: [{ name: echoName, protocolRange: "^1.0.0" }],
      }),
    ],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.map((item) => item.code),
    [
      "CAPABILITY_REQUIRED_CYCLE",
      "CAPABILITY_REQUIRED_UNAVAILABLE",
      "CAPABILITY_REQUIRED_UNAVAILABLE",
    ],
  );
  assert.deepEqual(result.providerLossActions, []);
});

test("@spec:capability-resolution/provider-loss-propagation/suspend-on-provider-loss", () => {
  const provider = identity("provider");
  const consumers = [
    ["consumer-degrade", "degrade", false],
    ["consumer-fail", "fail", false],
    ["consumer-suspend", "suspend", true],
  ] as const;
  const result = resolveCapabilities({
    deployments: [
      ...consumers.map(([pluginId, lossPolicy, optional]) =>
        deployment(pluginId, {
          requires: [
            {
              name: echoName,
              protocolRange: "^1.0.0",
              lossPolicy,
              optional,
            },
          ],
          bindings: pluginId === "consumer-suspend" ? { [echoName]: provider } : {},
        }),
      ),
      deployment("provider", {
        ready: false,
        provides: [{ name: echoName, protocolVersion: "1.0.0" }],
      }),
    ],
    previousBindings: consumers.map(([pluginId]) => ({
      consumer: identity(pluginId),
      capability: echoName,
      provider,
    })),
  });

  assert.deepEqual(result.providerLossActions, [
    {
      action: "degrade",
      capability: echoName,
      consumer: identity("consumer-degrade"),
      provider,
    },
    {
      action: "fail",
      capability: echoName,
      consumer: identity("consumer-fail"),
      provider,
    },
    {
      action: "suspend",
      capability: echoName,
      consumer: identity("consumer-suspend"),
      provider,
    },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("initial unready providers do not look like provider loss and recovery clears actions", () => {
  const unavailable = deployment("provider", {
    ready: false,
    provides: [{ name: echoName, protocolVersion: "1.0.0" }],
  });
  const consumer = deployment("consumer", {
    requires: [{ name: echoName, protocolRange: "^1.0.0", lossPolicy: "suspend" }],
  });

  const initial = resolveCapabilities({ deployments: [consumer, unavailable] });
  assert.equal(initial.ok, false);
  assert.equal(initial.diagnostics[0]?.code, "CAPABILITY_REQUIRED_UNAVAILABLE");
  assert.deepEqual(initial.providerLossActions, []);

  const recovered = resolveCapabilities({
    deployments: [consumer, { ...unavailable, ready: true }],
    previousBindings: [
      {
        consumer: identity("consumer"),
        capability: echoName,
        provider: identity("provider"),
      },
    ],
  });
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.providerLossActions, []);
});
