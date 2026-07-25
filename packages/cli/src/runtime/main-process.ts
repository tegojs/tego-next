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
  readonly controlServerFactory?: typeof startControlServer;
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

type PreReadinessResult<T> =
  | { readonly aborted: true }
  | { readonly aborted: false; readonly value: T };

async function runUntilAbort<T>(
  operation: () => T | PromiseLike<T>,
  signal?: AbortSignal,
  onLateValue?: (value: T) => void | Promise<void>,
): Promise<PreReadinessResult<T>> {
  if (signal?.aborted === true) return { aborted: true };
  const operationPromise = Promise.resolve().then(() => {
    if (signal?.aborted === true) {
      throw new DOMException("Pre-readiness operation aborted", "AbortError");
    }
    return operation();
  });
  if (signal === undefined) {
    return { aborted: false, value: await operationPromise };
  }
  const aborted = Promise.withResolvers<PreReadinessResult<T>>();
  const onAbort = () => aborted.resolve({ aborted: true });
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    const result = await Promise.race([
      operationPromise.then((value) => ({ aborted: false as const, value })),
      aborted.promise,
    ]);
    if (result.aborted && onLateValue !== undefined) {
      void operationPromise.then(onLateValue).catch(() => undefined);
    }
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function runMainProcess(options: MainProcessOptions): Promise<void> {
  let server: Awaited<ReturnType<typeof startControlServer>> | undefined;
  const errors: unknown[] = [];
  try {
    const started = await runUntilAbort(() => options.runtime.start(), options.signal);
    if (!started.aborted) {
      const created = await runUntilAbort(
        () =>
          (options.controlServerFactory ?? startControlServer)({
            endpoint: options.endpoint,
            operations: options.runtime,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.artifactIngress === undefined
              ? {}
              : { artifactIngress: options.artifactIngress }),
          }),
        options.signal,
        (lateServer) => lateServer.close(),
      );
      if (!created.aborted) {
        server = created.value;
        const status = await runUntilAbort(() => options.runtime.status(), options.signal);
        if (!status.aborted) {
          const ready = await runUntilAbort(() => options.onReady?.(status.value), options.signal);
          if (!ready.aborted) await waitForStop(options.runtime, options.signal);
        }
      }
    }
  } catch (error) {
    errors.push(error);
  } finally {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => options.runtime.stop()),
      Promise.resolve().then(() => server?.close()),
    ]);
    for (const result of cleanup) {
      if (result.status === "rejected") errors.push(result.reason);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Main process shutdown failed");
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
  void runEntrypoint().catch(() => {
    process.send?.({
      type: "runtime.failed",
      message: "Runtime Main process failed",
    });
    process.exitCode = 1;
  });
}
