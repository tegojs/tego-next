import { fileURLToPath } from "node:url";
import type { Runtime, RuntimeStatus } from "@tegojs/contracts";
import { type LocalArtifactIngress, startControlServer } from "../control/server.js";
import {
  type CreateNodeRuntimeHostOptions,
  createNodeRuntimeHost,
} from "./create-node-runtime-host.js";

export interface MainProcessOptions {
  readonly endpoint: string;
  readonly runtime: Runtime;
  readonly artifactIngress?: LocalArtifactIngress;
  readonly signal?: AbortSignal;
  readonly onReady?: (status: RuntimeStatus) => void | Promise<void>;
}

async function waitForStop(runtime: Runtime, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  const aborted = Promise.withResolvers<void>();
  const onAbort = () => aborted.resolve();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const stopped = (async () => {
      for await (const event of runtime.events) {
        if (event.current === "stopped" || event.current === "failed") return;
      }
    })();
    await Promise.race([stopped, aborted.promise]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function runMainProcess(options: MainProcessOptions): Promise<void> {
  let server: Awaited<ReturnType<typeof startControlServer>> | undefined;
  try {
    await options.runtime.start();
    server = await startControlServer({
      endpoint: options.endpoint,
      operations: options.runtime,
      ...(options.artifactIngress === undefined
        ? {}
        : { artifactIngress: options.artifactIngress }),
    });
    await options.onReady?.(await options.runtime.status());
    await waitForStop(options.runtime, options.signal);
  } finally {
    await options.runtime.stop();
    await server?.close();
  }
}

export interface NodeMainProcessOptions extends CreateNodeRuntimeHostOptions {
  readonly endpoint: string;
  readonly signal?: AbortSignal;
  readonly onReady?: (status: RuntimeStatus) => void | Promise<void>;
}

export async function runNodeMainProcess(options: NodeMainProcessOptions): Promise<void> {
  const host = await createNodeRuntimeHost(options);
  await runMainProcess({
    endpoint: options.endpoint,
    runtime: host.runtime,
    artifactIngress: host.artifactIngress,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onReady === undefined ? {} : { onReady: options.onReady }),
  });
}

async function runEntrypoint(): Promise<void> {
  const configuration = JSON.parse(
    process.env.TEGO_MAIN_PROCESS_OPTIONS ?? "{}",
  ) as NodeMainProcessOptions;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runNodeMainProcess({
      ...configuration,
      signal: controller.signal,
      onReady: (status) => {
        process.send?.({ type: "runtime.ready", status });
      },
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runEntrypoint().catch((error: unknown) => {
    process.send?.({
      type: "runtime.failed",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
