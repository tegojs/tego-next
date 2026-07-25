import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RuntimeStatus } from "@tegojs/contracts";
import { removeOwnedControlEndpoint } from "../control/server.js";
import type { RuntimeStartCommand } from "../parse-command.js";
import { runNodeMainProcess } from "../runtime/main-process.js";

const DETACHED_START_TIMEOUT_MS = 10_000;
const DETACHED_TERMINATION_TIMEOUT_MS = 2_000;

export async function startRuntimeForeground(command: RuntimeStartCommand): Promise<RuntimeStatus> {
  let ready: RuntimeStatus | undefined;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runNodeMainProcess({
      ...command,
      signal: controller.signal,
      onReady: (status) => {
        ready = status;
      },
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (ready === undefined) throw new Error("LIFECYCLE_RUNTIME_NOT_READY");
  return ready;
}

export interface DetachedRuntimeStartOptions {
  readonly mainProcessPath?: string;
  readonly readinessTimeoutMs?: number;
  readonly terminationTimeoutMs?: number;
}

function validDeadline(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function childExited(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<boolean> {
  if (childExited(child)) return true;
  return await new Promise<boolean>((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(childExited(child));
    const timer = setTimeout(() => finish(childExited(child)), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function terminateDetachedChild(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<void> {
  if (childExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, timeoutMs)) return;
  child.kill("SIGKILL");
  if (await waitForChildExit(child, timeoutMs)) return;
  throw new Error("LIFECYCLE_DETACHED_TERMINATION_TIMEOUT");
}

export async function startRuntimeDetached(
  command: RuntimeStartCommand,
  options: DetachedRuntimeStartOptions = {},
): Promise<RuntimeStatus> {
  const readinessTimeoutMs = validDeadline(
    options.readinessTimeoutMs ?? DETACHED_START_TIMEOUT_MS,
    "readinessTimeoutMs",
  );
  const terminationTimeoutMs = validDeadline(
    options.terminationTimeoutMs ?? DETACHED_TERMINATION_TIMEOUT_MS,
    "terminationTimeoutMs",
  );
  const mainProcessPath =
    options.mainProcessPath ??
    fileURLToPath(new URL("../runtime/main-process.js", import.meta.url));
  const child = spawn(process.execPath, [mainProcessPath], {
    detached: true,
    env: {
      ...process.env,
      TEGO_MAIN_PROCESS_OPTIONS: JSON.stringify({
        applicationId: command.applicationId,
        dataDirectory: command.dataDirectory,
        endpoint: command.endpoint,
        mode: command.mode,
        nodeId: command.nodeId,
        runtimeId: command.runtimeId,
        ...(command.postgresUrl === undefined ? {} : { postgresUrl: command.postgresUrl }),
      }),
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });

  try {
    const status = await new Promise<RuntimeStatus>((resolve, reject) => {
      const finish = (outcome: { readonly error: Error } | { readonly status: RuntimeStatus }) => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("message", onMessage);
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.status);
      };
      const onError = () => finish({ error: new Error("LIFECYCLE_DETACHED_START_FAILED") });
      const onExit = () => finish({ error: new Error("LIFECYCLE_DETACHED_START_FAILED") });
      const onMessage = (message: unknown) => {
        if (typeof message !== "object" || message === null || !("type" in message)) return;
        if (message.type === "runtime.ready" && "status" in message) {
          finish({ status: message.status as RuntimeStatus });
        } else if (message.type === "runtime.failed") {
          finish({ error: new Error("LIFECYCLE_DETACHED_START_FAILED") });
        }
      };
      const timer = setTimeout(
        () => finish({ error: new Error("LIFECYCLE_DETACHED_START_TIMEOUT") }),
        readinessTimeoutMs,
      );
      timer.unref();
      child.once("error", onError);
      child.once("exit", onExit);
      child.on("message", onMessage);
    });
    if (child.connected) child.disconnect();
    child.unref();
    return status;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await terminateDetachedChild(child, terminationTimeoutMs);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (child.connected) child.disconnect();
    if (childExited(child)) child.unref();
    try {
      await removeOwnedControlEndpoint(command.endpoint);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Detached runtime startup and cleanup failed",
      );
    }
    throw error;
  }
}
