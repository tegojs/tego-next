import {
  DiagnosticError,
  runtimeDiagnostic,
  type Clock,
  type PersistedOperationJournalEntry,
  type RuntimeOperations,
} from "@tegojs/contracts";

export class RuntimeOperationController implements RuntimeOperations {
  readonly #clock: Clock;
  #available = false;
  #acceptingMutations = false;
  #recovered: readonly PersistedOperationJournalEntry[] = [];

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  get accepting(): boolean {
    return this.#acceptingMutations;
  }

  setRecovered(entries: readonly PersistedOperationJournalEntry[]): void {
    this.#recovered = structuredClone(entries);
  }

  open(): void {
    this.openReadOnly();
    this.openMutations();
  }

  openReadOnly(): void {
    this.#available = true;
  }

  openMutations(): void {
    this.#acceptingMutations = true;
  }

  closeMutations(): void {
    this.#acceptingMutations = false;
  }

  close(): void {
    this.#available = false;
    this.#acceptingMutations = false;
  }

  async recoveredOperations(): Promise<readonly PersistedOperationJournalEntry[]> {
    if (!this.#available) {
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
