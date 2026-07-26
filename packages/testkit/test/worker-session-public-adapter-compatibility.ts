import type { JsonObject, WorkerId } from "@tegojs/contracts";
import {
  type MainEndpointLike,
  type WorkerEndpointFactoryOptions,
  type WorkerEndpointLike,
  type WorkerRegistration,
  type WorkerRegistrationInput,
  type WorkerSessionLike,
  type WorkerSessionSocket,
  workerSessionConformance,
} from "@tegojs/testkit";

interface PublicAdapterWorkerRegistration extends JsonObject {
  readonly workerId: WorkerId;
  readonly labels: JsonObject;
  readonly resources: JsonObject;
  readonly executors: readonly string[];
  readonly preparedArtifacts: readonly string[];
}

interface PublicAdapterWorkerRegistrationInput {
  readonly labels: JsonObject;
  readonly resources: JsonObject;
  readonly executors: readonly string[];
  readonly preparedArtifacts: readonly string[];
}

interface PublicAdapterWorkerSession extends Omit<WorkerSessionLike, "epoch"> {
  readonly epoch: string;
}

interface PublicAdapterMainEndpoint
  extends Omit<MainEndpointLike, "attach" | "current" | "registration"> {
  attach(socket: WorkerSessionSocket): PublicAdapterWorkerSession;
  current(workerId: WorkerId): PublicAdapterWorkerSession | undefined;
  registration(workerId: WorkerId): PublicAdapterWorkerRegistration | undefined;
}

interface PublicAdapterWorkerEndpoint extends Omit<WorkerEndpointLike, "attach" | "current"> {
  readonly current: PublicAdapterWorkerSession | undefined;
  attach(socket: WorkerSessionSocket): PublicAdapterWorkerSession;
}

interface PublicAdapterFactoryOptions extends Omit<WorkerEndpointFactoryOptions, "registration"> {
  readonly registration?: PublicAdapterWorkerRegistrationInput;
}

declare const publicAdapterMainFactory: (
  options: PublicAdapterFactoryOptions,
) => PublicAdapterMainEndpoint | Promise<PublicAdapterMainEndpoint>;
declare const publicAdapterWorkerFactory: (
  options: PublicAdapterFactoryOptions,
) => PublicAdapterWorkerEndpoint | Promise<PublicAdapterWorkerEndpoint>;

const adapterExecutors: string[] = ["process"];
const adapterArtifacts: string[] = [`sha256:${"0".repeat(64)}`];
const registrationInput: WorkerRegistrationInput = {
  labels: {},
  resources: {},
  executors: adapterExecutors,
  preparedArtifacts: adapterArtifacts,
};
const registration: WorkerRegistration = {
  workerId: "public-adapter-worker" as WorkerId,
  ...registrationInput,
};
const epoch: string = "1";
const publicEpoch: WorkerSessionLike["epoch"] = epoch;

void registration;
void publicEpoch;
workerSessionConformance(publicAdapterMainFactory, publicAdapterWorkerFactory);
