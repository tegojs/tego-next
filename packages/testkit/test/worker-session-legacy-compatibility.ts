import {
  workerSessionConformance,
  type MainEndpointLike,
  type WorkerEndpointFactoryOptions,
  type WorkerEndpointLike,
  type WorkerRegistration,
  type WorkerRegistrationInput,
  type WorkerSessionLike,
  type WorkerSessionSocket,
} from "@tegojs/testkit";
import type { JsonObject, WorkerId } from "@tegojs/contracts";

interface LegacyWorkerRegistration extends JsonObject {
  readonly workerId: WorkerId;
  readonly labels: JsonObject;
  readonly resources: JsonObject;
  readonly executors: readonly string[];
  readonly preparedArtifacts: readonly string[];
}

interface LegacyWorkerRegistrationInput {
  readonly labels: JsonObject;
  readonly resources: JsonObject;
  readonly executors: readonly string[];
  readonly preparedArtifacts: readonly string[];
}

interface LegacyWorkerSession extends Omit<WorkerSessionLike, "epoch"> {
  readonly epoch: string;
}

interface LegacyMainEndpoint extends Omit<MainEndpointLike, "attach" | "current" | "registration"> {
  attach(socket: WorkerSessionSocket): LegacyWorkerSession;
  current(workerId: WorkerId): LegacyWorkerSession | undefined;
  registration(workerId: WorkerId): LegacyWorkerRegistration | undefined;
}

interface LegacyWorkerEndpoint extends Omit<WorkerEndpointLike, "attach" | "current"> {
  readonly current: LegacyWorkerSession | undefined;
  attach(socket: WorkerSessionSocket): LegacyWorkerSession;
}

interface LegacyFactoryOptions extends Omit<WorkerEndpointFactoryOptions, "registration"> {
  readonly registration?: LegacyWorkerRegistrationInput;
}

declare const legacyMainFactory: (
  options: LegacyFactoryOptions,
) => LegacyMainEndpoint | Promise<LegacyMainEndpoint>;
declare const legacyWorkerFactory: (
  options: LegacyFactoryOptions,
) => LegacyWorkerEndpoint | Promise<LegacyWorkerEndpoint>;

const legacyExecutors: string[] = ["process"];
const legacyArtifacts: string[] = [`sha256:${"0".repeat(64)}`];
const registrationInput: WorkerRegistrationInput = {
  labels: {},
  resources: {},
  executors: legacyExecutors,
  preparedArtifacts: legacyArtifacts,
};
const registration: WorkerRegistration = {
  workerId: "legacy-worker" as WorkerId,
  ...registrationInput,
};
const epoch: string = "1";
const publicEpoch: WorkerSessionLike["epoch"] = epoch;

void registration;
void publicEpoch;
workerSessionConformance(legacyMainFactory, legacyWorkerFactory);
