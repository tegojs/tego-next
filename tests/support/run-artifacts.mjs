import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const artifactFiles = [
  "stdout.log",
  "stderr.log",
  "events.ndjson",
  "transcript.ndjson",
  "cleanup.json",
];

function safeName(value) {
  const name = value.replaceAll(/[^a-zA-Z0-9._-]/gu, "-");
  if (name.length === 0 || name === "." || name === "..") {
    throw new Error(`INVALID_ARTIFACT_NAME:${value}`);
  }
  return name;
}

export async function createRunArtifacts(testName) {
  const configuredDirectory = process.env.TEGO_TEST_ARTIFACTS_DIR;
  const baseDirectory = configuredDirectory ?? tmpdir();
  await mkdir(baseDirectory, { recursive: true });
  const directory = await mkdtemp(join(baseDirectory, `tego-${safeName(testName)}-`));

  function processDirectory(name) {
    return join(directory, safeName(name));
  }

  function artifact(name, file) {
    return join(processDirectory(name), file);
  }

  return Object.freeze({
    directory,
    stdout: (name) => artifact(name, "stdout.log"),
    stderr: (name) => artifact(name, "stderr.log"),
    events: (name) => artifact(name, "events.ndjson"),
    transcript: (name) => artifact(name, "transcript.ndjson"),
    cleanup: (name) => artifact(name, "cleanup.json"),
    async dispose() {
      if (configuredDirectory !== undefined) return;
      await rm(directory, { force: true, recursive: true });
    },
    async initialize(name) {
      const target = processDirectory(name);
      await mkdir(target);
      await Promise.all(
        artifactFiles.map((file) =>
          writeFile(join(target, file), file === "cleanup.json" ? "{}\n" : ""),
        ),
      );
    },
  });
}
