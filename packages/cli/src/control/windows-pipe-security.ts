import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { DiagnosticError } from "@tego/contracts";
import { protocolDiagnostic } from "./protocol.js";

export const WINDOWS_SYSTEM_SID = "S-1-5-18";
export const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";
export const WINDOWS_EVERYONE_SID = "S-1-1-0";
export const WINDOWS_ANONYMOUS_SID = "S-1-5-7";
export const WINDOWS_AUTHENTICATED_USERS_SID = "S-1-5-11";

const WINDOWS_PIPE_FULL_CONTROL = 0x1f01ff;
const WINDOWS_PIPE_HELPER_TIMEOUT_MS = 10_000;
const WINDOWS_PIPE_HELPER_MAX_OUTPUT_BYTES = 64 * 1024;
const WINDOWS_PIPE_ADMISSION_BARRIER_COUNT = 2;

export const WINDOWS_PIPE_ADMISSION_BARRIER_FRAME = "TEGO_WINDOWS_PIPE_SECURITY_BARRIER_V1\n";
export const WINDOWS_PIPE_ADMISSION_BARRIER_ACK = "TEGO_WINDOWS_PIPE_SECURITY_BARRIER_ACK_V1\n";

export interface WindowsPipeSecurityAccessRule {
  readonly accessMask: number;
  readonly inherited: boolean;
  readonly sid: string;
  readonly type: "allow" | "deny";
}

export interface WindowsPipeSecurityDescriptor {
  readonly ownerSid: string;
  readonly accessSids: readonly string[];
  readonly protectedDacl: boolean;
}

export interface WindowsPipeSecurityInspection extends WindowsPipeSecurityDescriptor {
  readonly accessRules: readonly WindowsPipeSecurityAccessRule[];
}

export interface WindowsPipeSecurityAdapter {
  readonly usesAdmissionBarrier: true;
  harden(endpoint: string, signal?: AbortSignal): Promise<WindowsPipeSecurityInspection>;
}

export interface WindowsPipeSecurityInspector {
  inspect(endpoint: string, signal?: AbortSignal): Promise<WindowsPipeSecurityInspection>;
}

export type WindowsPipeSecurityHelperSpawner = (
  command: string,
  args: readonly string[],
) => ChildProcessByStdio<null, Readable, Readable>;

export type WindowsPipeSecurityHelperFailureStage =
  | "TEGO_WINDOWS_PIPE_SECURITY_APPLY_DESCRIPTOR_FAILED"
  | "TEGO_WINDOWS_PIPE_SECURITY_BARRIER_IO_FAILED"
  | "TEGO_WINDOWS_PIPE_SECURITY_BARRIER_OPEN_FAILED"
  | "TEGO_WINDOWS_PIPE_SECURITY_BARRIER_WAIT_FAILED"
  | "TEGO_WINDOWS_PIPE_SECURITY_DESCRIPTOR_PARSE_FAILED"
  | "TEGO_WINDOWS_PIPE_SECURITY_DESCRIPTOR_READ_FAILED"
  | "TEGO_WINDOWS_PIPE_SECURITY_DESCRIPTOR_SIZE_FAILED"
  | "TEGO_WINDOWS_PIPE_SECURITY_IDENTITY_FAILED"
  | "TEGO_WINDOWS_PIPE_SECURITY_INITIAL_OPEN_FAILED";

const WINDOWS_PIPE_SECURITY_HELPER_FAILURE =
  /^TEGO_WINDOWS_PIPE_SECURITY_(?:APPLY_DESCRIPTOR|BARRIER_IO|BARRIER_OPEN|BARRIER_WAIT|DESCRIPTOR_PARSE|DESCRIPTOR_READ|DESCRIPTOR_SIZE|IDENTITY|INITIAL_OPEN)_FAILED\r?\n$/u;

class WindowsPipeSecurityHelperFailure extends Error {
  readonly stage: WindowsPipeSecurityHelperFailureStage;

  constructor(stage: WindowsPipeSecurityHelperFailureStage) {
    super("WINDOWS_PIPE_SECURITY_HELPER_FAILED");
    this.name = "WindowsPipeSecurityHelperFailure";
    this.stage = stage;
  }
}

const WINDOWS_PIPE_SECURITY_SCRIPT = fileURLToPath(
  new URL("windows-pipe-security.ps1", import.meta.url),
);

function endpointUnsafe(): DiagnosticError {
  return new DiagnosticError(
    protocolDiagnostic("PROTOCOL_CONTROL_ENDPOINT_UNSAFE", "PROTOCOL_CONTROL_ENDPOINT_UNSAFE"),
  );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).toSorted();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseAccessRule(value: unknown): WindowsPipeSecurityAccessRule {
  const rule = objectValue(value);
  if (
    rule === undefined ||
    !exactKeys(rule, ["accessMask", "inherited", "sid", "type"]) ||
    typeof rule.sid !== "string" ||
    (rule.type !== "allow" && rule.type !== "deny") ||
    typeof rule.inherited !== "boolean" ||
    !Number.isSafeInteger(rule.accessMask) ||
    (rule.accessMask as number) < 0 ||
    (rule.accessMask as number) > 0xffff_ffff
  ) {
    throw endpointUnsafe();
  }
  return {
    accessMask: rule.accessMask as number,
    inherited: rule.inherited,
    sid: rule.sid,
    type: rule.type,
  };
}

export function validateWindowsPipeSecurityDescriptor(
  value: unknown,
  currentUserSid: string,
): WindowsPipeSecurityDescriptor {
  const descriptor = objectValue(value);
  if (
    currentUserSid.length === 0 ||
    descriptor === undefined ||
    !exactKeys(descriptor, ["accessRules", "accessSids", "ownerSid", "protectedDacl"]) ||
    descriptor.ownerSid !== currentUserSid ||
    descriptor.protectedDacl !== true ||
    !Array.isArray(descriptor.accessSids) ||
    !descriptor.accessSids.every((sid) => typeof sid === "string") ||
    !Array.isArray(descriptor.accessRules)
  ) {
    throw endpointUnsafe();
  }

  const allowedSidOrder = [
    ...new Set([currentUserSid, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID]),
  ];
  const allowedSids = new Set(allowedSidOrder);
  const accessSids = descriptor.accessSids as string[];
  if (
    accessSids.length !== allowedSids.size ||
    new Set(accessSids).size !== allowedSids.size ||
    accessSids.some((sid, index) => sid !== allowedSidOrder[index])
  ) {
    throw endpointUnsafe();
  }

  const accessRules = (descriptor.accessRules as unknown[]).map(parseAccessRule);
  if (
    accessRules.length !== allowedSids.size ||
    accessRules.some(
      (rule, index) =>
        rule.type !== "allow" ||
        rule.inherited ||
        rule.sid !== allowedSidOrder[index] ||
        rule.accessMask !== WINDOWS_PIPE_FULL_CONTROL,
    ) ||
    new Set(accessRules.map(({ sid }) => sid)).size !== allowedSids.size
  ) {
    throw endpointUnsafe();
  }

  return {
    accessSids,
    ownerSid: descriptor.ownerSid,
    protectedDacl: true,
  };
}

async function runPowerShellHelperWith(
  spawnPowerShell: WindowsPipeSecurityHelperSpawner,
  endpoint: string,
  operation: "harden" | "inspect",
  barrierCount: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted === true) throw signal.reason;
  return await new Promise<string>((resolve, reject) => {
    const child = spawnPowerShell("pwsh", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      WINDOWS_PIPE_SECURITY_SCRIPT,
      "-Endpoint",
      endpoint,
      "-Operation",
      operation,
      "-BarrierCount",
      String(barrierCount),
    ]);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let failure: unknown;
    let settled = false;
    const finish = (error: unknown, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve(output ?? "");
      else reject(error);
    };
    const terminate = (error: unknown) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const onAbort = () => terminate(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    const timeout = setTimeout(
      () => terminate(new Error("WINDOWS_PIPE_SECURITY_HELPER_TIMEOUT")),
      WINDOWS_PIPE_HELPER_TIMEOUT_MS,
    );
    timeout.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure !== undefined) return;
      const available = WINDOWS_PIPE_HELPER_MAX_OUTPUT_BYTES - stdout.byteLength;
      if (chunk.byteLength > available) {
        if (available > 0) stdout = Buffer.concat([stdout, chunk.subarray(0, available)]);
        terminate(new Error("WINDOWS_PIPE_SECURITY_HELPER_OUTPUT_LIMIT"));
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (failure !== undefined) return;
      const available = WINDOWS_PIPE_HELPER_MAX_OUTPUT_BYTES - stderr.byteLength;
      if (chunk.byteLength > available) {
        if (available > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, available)]);
        terminate(new Error("WINDOWS_PIPE_SECURITY_HELPER_OUTPUT_LIMIT"));
        return;
      }
      stderr = Buffer.concat([stderr, chunk]);
    });
    child.once("close", (code, childSignal) => {
      if (failure !== undefined) {
        finish(failure);
        return;
      }
      if (code !== 0 || childSignal !== null || stderr.byteLength !== 0) {
        const diagnostic = stderr.toString("utf8");
        if (WINDOWS_PIPE_SECURITY_HELPER_FAILURE.test(diagnostic)) {
          finish(
            new WindowsPipeSecurityHelperFailure(
              diagnostic.trim() as WindowsPipeSecurityHelperFailureStage,
            ),
          );
          return;
        }
        finish(new Error("WINDOWS_PIPE_SECURITY_HELPER_FAILED"));
        return;
      }
      finish(undefined, stdout.toString("utf8"));
    });
    if (signal?.aborted === true) onAbort();
  });
}

export function parseWindowsPipeSecurityHelperOutput(
  output: string,
): WindowsPipeSecurityInspection {
  if (!/^[^\r\n]+(?:\r?\n)?$/u.test(output)) throw endpointUnsafe();
  let decoded: unknown;
  try {
    decoded = JSON.parse(output.trim());
  } catch {
    throw endpointUnsafe();
  }
  const result = objectValue(decoded);
  if (
    result === undefined ||
    !exactKeys(result, [
      "accessRules",
      "accessSids",
      "currentUserSid",
      "ownerSid",
      "protectedDacl",
    ]) ||
    typeof result.currentUserSid !== "string" ||
    !Array.isArray(result.accessRules)
  ) {
    throw endpointUnsafe();
  }
  const inspected = {
    accessRules: (result.accessRules as unknown[]).map(parseAccessRule),
    accessSids: result.accessSids,
    ownerSid: result.ownerSid,
    protectedDacl: result.protectedDacl,
  };
  validateWindowsPipeSecurityDescriptor(inspected, result.currentUserSid);
  return inspected as WindowsPipeSecurityInspection;
}

export function createWindowsPipeSecurityAdapter(
  options: {
    readonly onHelperFailure?: (stage: WindowsPipeSecurityHelperFailureStage) => void;
    readonly spawnHelper?: WindowsPipeSecurityHelperSpawner;
  } = {},
): WindowsPipeSecurityAdapter & WindowsPipeSecurityInspector {
  try {
    accessSync(WINDOWS_PIPE_SECURITY_SCRIPT, fsConstants.R_OK);
  } catch {
    throw endpointUnsafe();
  }
  const spawnPowerShell =
    options.spawnHelper ??
    ((command, args) =>
      spawn(command, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }));
  const run = async (
    endpoint: string,
    operation: "harden" | "inspect",
    signal?: AbortSignal,
  ): Promise<WindowsPipeSecurityInspection> => {
    if (!/^\\\\\.\\pipe\\[^\\\r\n]+$/u.test(endpoint)) {
      throw endpointUnsafe();
    }
    try {
      return parseWindowsPipeSecurityHelperOutput(
        await runPowerShellHelperWith(
          spawnPowerShell,
          endpoint,
          operation,
          operation === "harden" ? WINDOWS_PIPE_ADMISSION_BARRIER_COUNT : 0,
          signal,
        ),
      );
    } catch (error) {
      if (signal?.aborted === true) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      if (error instanceof WindowsPipeSecurityHelperFailure) {
        try {
          options.onHelperFailure?.(error.stage);
        } catch {
          // Diagnostic observers cannot change the fail-closed production result.
        }
      }
      if (error instanceof DiagnosticError) throw error;
      throw endpointUnsafe();
    }
  };
  return {
    harden: (endpoint, signal) => run(endpoint, "harden", signal),
    inspect: (endpoint, signal) => run(endpoint, "inspect", signal),
    usesAdmissionBarrier: true,
  };
}
