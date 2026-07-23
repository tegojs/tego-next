import type {
  ApplicationId,
  OperationJournalCursor,
  PersistedOperationJournalEntry,
  StateStore,
} from "@tegojs/contracts";
import { parsePluginDeployment } from "@tegojs/contracts";
import type { DeploymentReadiness } from "./readiness.js";

const recoveryPageSize = 100;

export interface RuntimeRecoverySnapshot {
  readonly installationCount: number;
  readonly deploymentCount: number;
  readonly deploymentReadiness: readonly DeploymentReadiness[];
  readonly taskCount: number;
  readonly operations: readonly PersistedOperationJournalEntry[];
}

async function countCollection(
  state: StateStore,
  collection: "deployments" | "installations" | "tasks",
): Promise<number> {
  let count = 0;
  for await (const _record of state.scan({
    namespace: "tego",
    collection,
  })) {
    count += 1;
  }
  return count;
}

async function recoverDeployments(
  state: StateStore,
  applicationId: ApplicationId,
): Promise<{
  readonly count: number;
  readonly readiness: readonly DeploymentReadiness[];
}> {
  const readiness: DeploymentReadiness[] = [];
  for await (const record of state.scan({
    namespace: "tego",
    collection: "deployments",
  })) {
    const deployment = parsePluginDeployment(record.value);
    if (deployment.applicationId !== applicationId) continue;
    readiness.push({
      desired: deployment.state === "active",
      essential: deployment.essential,
      ready: false,
    });
  }
  return { count: readiness.length, readiness };
}

async function recoverOperations(
  state: StateStore,
): Promise<readonly PersistedOperationJournalEntry[]> {
  const recovered: PersistedOperationJournalEntry[] = [];
  let after: OperationJournalCursor | undefined;

  while (true) {
    const page: PersistedOperationJournalEntry[] = [];
    for await (const entry of state.scanRecoverableOperations({
      ...(after === undefined ? {} : { after }),
      limit: recoveryPageSize,
    })) {
      page.push(entry);
    }
    recovered.push(...page);
    if (page.length < recoveryPageSize) {
      return recovered;
    }
    const last = page.at(-1);
    if (last === undefined) {
      return recovered;
    }
    after = { revision: last.revision, operationId: last.operationId };
  }
}

export async function recoverRuntimeState(
  state: StateStore,
  applicationId: ApplicationId,
): Promise<RuntimeRecoverySnapshot> {
  const installationCount = await countCollection(state, "installations");
  const deployments = await recoverDeployments(state, applicationId);
  const taskCount = await countCollection(state, "tasks");
  const operations = await recoverOperations(state);
  return {
    installationCount,
    deploymentCount: deployments.count,
    deploymentReadiness: deployments.readiness,
    taskCount,
    operations,
  };
}
