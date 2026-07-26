export const semanticSnapshotCollections = [
  "installations",
  "deployments",
  "instances",
  "operations",
  "tasks",
];

export async function collectSemanticSnapshot(fetchSnapshot) {
  const snapshot = await fetchSnapshot({});
  return Object.fromEntries(
    semanticSnapshotCollections.map((collection) => [collection, snapshot[collection].items]),
  );
}

export async function settleWithCleanup(operation, cleanupSteps) {
  let result;
  try {
    result = await operation();
  } catch {
    // The harness currently treats cleanup as best effort.
  }
  for (const cleanup of cleanupSteps) {
    await cleanup().catch(() => undefined);
  }
  return result;
}
