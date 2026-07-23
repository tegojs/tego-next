## Why

Tego needs a new backend runtime whose kernel can boot, run plugins, dispatch work, and recover failures without importing HTTP, security, database, cache, frontend, or Tego 1.x concepts. Building this as an independent repository establishes a testable foundation for embedded single-Main deployments and future highly available multi-Main deployments without carrying forward the coupling of the existing implementation.

## What Changes

- Create a Node.js 26 and TypeScript 7 ESM workspace for a clean-room Tego runtime.
- Define stable, runtime-validated contracts for applications, runtime drivers, plugins, capabilities, workers, executors, tasks, and lifecycle state.
- Implement a bootable `single-main` runtime with local coordination and durable local state.
- Implement desired-state reconciliation for plugin installation and deployment.
- Implement capability dependency resolution, permission gating, essential-plugin readiness, and structured diagnostics.
- Implement interchangeable thread, child-process, and remote-worker executors behind one task protocol.
- Implement the WebSocket Main/Worker protocol, including registration, heartbeats, task execution, cancellation, reconnect, and orphan-result recovery.
- Define and certify the multi-Main coordination contract, including leadership, leases, compare-and-set, watch, and fencing epochs, with one production external provider.
- Provide a plugin SDK, contract-test kit, CLI, example plugin, and a reproducible plugin package format so the first layer is directly usable.
- **BREAKING**: This repository exposes only Tego Next contracts. It intentionally provides no Tego 1.x compatibility API, CommonJS loader, frontend loader, HTTP API, database abstraction, ACL, cache, workflow engine, or business capability.

## Capabilities

### New Capabilities

- `runtime-bootstrap`: Boot, inspect, stop, and recover a Tego Main using explicit runtime drivers in `single-main` or `multi-main` mode.
- `plugin-artifacts`: Validate manifests without executing plugin code and register immutable, digest-addressed plugin installations.
- `plugin-deployment`: Persist desired plugin deployments, resolve their dependencies and permissions, reconcile component instances, and report observed state.
- `capability-resolution`: Register versioned capability providers and resolve required or optional capability bindings deterministically.
- `executor-runtime`: Submit, observe, cancel, drain, and retry tasks through interchangeable thread, process, and remote executors.
- `worker-protocol`: Connect remote workers to a Main over WebSocket and preserve task identity and results across reconnects.
- `coordination-provider`: Provide local coordination for one Main and a contract-tested external coordination provider for multi-Main leadership, leases, CAS, watch, and fencing.
- `runtime-operations`: Operate the kernel through a CLI, diagnostics, structured events, an example plugin, and reusable conformance test kits.

### Modified Capabilities

None. This is a new repository with no existing product specifications.

## Impact

- Creates a new public repository at `tegojs/tego-next`; the existing `tegojs/tego` repository is unchanged.
- Introduces an npm workspace containing runtime contracts, kernel, local and external drivers, executor implementations, WebSocket transport, plugin SDK, plugin test kit, CLI, and examples.
- Requires Node.js 26 during development and TypeScript 7 for type checking and declarations.
- Uses JavaScript ESM as the production runtime and plugin artifact ABI.
- Adds Docker-backed integration tests for the selected external coordination provider while keeping unit and single-Main integration tests runnable without Docker.
- Establishes the behavioral contract that later platform-capability and business-plugin repositories or packages will consume.
