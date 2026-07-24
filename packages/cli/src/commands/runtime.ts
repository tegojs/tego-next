import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RuntimeStatus } from "@tegojs/contracts";
import type { RuntimeStartCommand } from "../parse-command.js";
import { runNodeMainProcess } from "../runtime/main-process.js";

const DETACHED_START_TIMEOUT_MS = 10_000;

export async function startRuntimeForeground(command: RuntimeStartCommand): Promise<RuntimeStatus> {
  let ready: RuntimeStatus | undefined;
  await runNodeMainProcess({
    ...command,
    onReady: (status) => {
      ready = status;
    },
  });
  if (ready === undefined) throw new Error("LIFECYCLE_RUNTIME_NOT_READY");
  return ready;
}

export async function startRuntimeDetached(command: RuntimeStartCommand): Promise<RuntimeStatus> {
  const mainProcessPath = fileURLToPath(new URL("../runtime/main-process.js", import.meta.url));
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

  return await new Promise<RuntimeStatus>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { readonly error: Error } | { readonly status: RuntimeStatus }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
      if ("error" in outcome && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      if (child.connected) child.disconnect();
      child.unref();
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.status);
    };
    const onError = (error: Error) => finish({ error });
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish({
        error: new Error(
          `LIFECYCLE_DETACHED_START_FAILED: child exited (${String(code)}, ${String(signal)})`,
        ),
      });
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type === "runtime.ready" && "status" in message) {
        finish({ status: message.status as RuntimeStatus });
      } else if (message.type === "runtime.failed" && "message" in message) {
        finish({
          error: new Error(`LIFECYCLE_DETACHED_START_FAILED: ${String(message.message)}`),
        });
      }
    };
    const timer = setTimeout(
      () =>
        finish({
          error: new Error("LIFECYCLE_DETACHED_START_TIMEOUT: recovery did not complete"),
        }),
      DETACHED_START_TIMEOUT_MS,
    );
    timer.unref();
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
}
