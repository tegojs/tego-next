import {
  DiagnosticError,
  runtimeDiagnostic,
  type Clock,
  type PersistedOperationJournalEntry,
  type RuntimeOperations,
} from "@tegojs/contracts";

export class RuntimeOperationController implements RuntimeOperations {
  readonly #clock: Clock;
  #accepting = false;
  #recovered: readonly PersistedOperationJournalEntry[] = [];

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  get accepting(): boolean {
    return this.#accepting;
  }

  setRecovered(entries: readonly PersistedOperationJournalEntry[]): void {
    this.#recovered = structuredClone(entries);
  }

  open(): void {
    this.#accepting = true;
  }

  close(): void {
    this.#accepting = false;
  }

  async recoveredOperations(): Promise<readonly PersistedOperationJournalEntry[]> {
    if (!this.#accepting) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "BOOTSTRAP_NOT_READY",
          message: "Runtime operations are unavailable until recovery completes",
          source: { kind: "runtime", id: "operations" },
          details: { acceptingOperations: false },
          observedAt: this.#clock.now().toISOString(),
        }),
      );
    }
    return structuredClone(this.#recovered);
  }
}
