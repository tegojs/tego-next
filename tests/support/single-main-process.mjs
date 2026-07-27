export const semanticSnapshotCollections = [
  "installations",
  "deployments",
  "instances",
  "operations",
  "tasks",
];

export async function collectSemanticSnapshot(fetchSnapshot) {
  const first = await fetchSnapshot({});
  const result = {};
  for (const collection of semanticSnapshotCollections) {
    const items = [...first[collection].items];
    const recordKeys = new Set();
    for (const item of items) {
      acceptSnapshotRecord(collection, item, recordKeys);
    }
    let cursor = first[collection].nextCursor;
    const cursors = new Set();
    while (cursor !== undefined) {
      if (cursors.has(cursor)) {
        throw new Error(`RUNTIME_SNAPSHOT_CURSOR_REPEATED:${collection}`);
      }
      cursors.add(cursor);
      const page = (await fetchSnapshot({ cursors: { [collection]: cursor } }))[collection];
      for (const item of page.items) {
        acceptSnapshotRecord(collection, item, recordKeys);
        items.push(item);
      }
      cursor = page.nextCursor;
    }
    result[collection] = items;
  }
  return result;
}

export async function settleWithCleanup(operation, cleanupSteps) {
  let operationError;
  let result;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors = [];
  for (const cleanup of cleanupSteps) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
      operationError === undefined
        ? "Single Main process cleanup failed"
        : "Single Main process test and cleanup failed",
    );
  }
  if (operationError !== undefined) throw operationError;
  return result;
}

function snapshotRecordKey(collection, item) {
  return collection === "operations"
    ? JSON.stringify([item.revision, item.operationId])
    : JSON.stringify([item.id]);
}

function acceptSnapshotRecord(collection, item, recordKeys) {
  const key = snapshotRecordKey(collection, item);
  if (recordKeys.has(key)) {
    throw new Error(`RUNTIME_SNAPSHOT_RECORD_REPEATED:${collection}:${key}`);
  }
  recordKeys.add(key);
}
