import type { ManagedDriver } from "./drivers.js";

export type HostedProcessSignal = "SIGINT" | "SIGTERM";

export interface ProcessSpawnRequest {
  /** Absolute trusted runtime entrypoint. */
  readonly entrypoint: string;
  readonly arguments?: readonly string[];
  /**
   * Non-secret bootstrap environment. Secret-like names are rejected by local
   * hosts; secret values travel only through the internal bounded RPC channel.
   */
  readonly environment?: Readonly<Record<string, string>>;
}

export interface HostedProcessExit {
  readonly code?: number;
  readonly signal?: string;
}

export interface HostedProcessInput {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface HostedProcess {
  readonly pid: number | undefined;
  readonly stdin: HostedProcessInput;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  signal(signal: HostedProcessSignal): Promise<void>;
  /**
   * Forces termination and resolves only after the process exit has settled.
   * A host that cannot deliver termination must reject instead of leaving the
   * returned promise pending.
   */
  kill(): Promise<HostedProcessExit>;
  wait(): Promise<HostedProcessExit>;
  close(): Promise<void>;
}

export interface ProcessHost extends ManagedDriver {
  readonly activeProcessCount: number;
  spawn(request: ProcessSpawnRequest): Promise<HostedProcess>;
}
