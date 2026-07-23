import type {
  OperationJournalCursor,
  PersistedOperationJournalEntry,
  StateStore,
} from "@tegojs/contracts";

const recoveryPageSize = 100;

export interface RuntimeRecoverySnapshot {
  readonly installationCount: number;
  readonly deploymentCount: number;
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

export async function recoverRuntimeState(state: StateStore): Promise<RuntimeRecoverySnapshot> {
  const installationCount = await countCollection(state, "installations");
  const deploymentCount = await countCollection(state, "deployments");
  const taskCount = await countCollection(state, "tasks");
  const operations = await recoverOperations(state);
  return {
    installationCount,
    deploymentCount,
    taskCount,
    operations,
  };
}
