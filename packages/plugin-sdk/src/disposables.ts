import {
  runtimeDiagnostic,
  type DiagnosticSource,
  type RuntimeDiagnostic,
} from "@tegojs/contracts";

export type ComponentDisposable =
  | (() => Promise<void> | void)
  | { readonly dispose: () => Promise<void> | void };

export interface ComponentDisposableStack {
  add(disposable: ComponentDisposable): void;
  dispose(): Promise<readonly RuntimeDiagnostic[]>;
  readonly disposed: boolean;
}

export interface DisposableStackOptions {
  readonly diagnosticSource?: DiagnosticSource;
  readonly redact?: (value: string) => string;
}

function disposalFunction(disposable: ComponentDisposable): () => Promise<void> | void {
  if (typeof disposable === "function") return disposable;
  if (typeof disposable !== "object" || disposable === null || Array.isArray(disposable)) {
    throw new TypeError("Disposable must be a function or a plain disposable object");
  }
  const prototype = Object.getPrototypeOf(disposable);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Disposable must be a function or a plain disposable object");
  }
  const descriptor = Object.getOwnPropertyDescriptor(disposable, "dispose");
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError("Disposable dispose must be an enumerable data property");
  }
  if (typeof descriptor.value !== "function") {
    throw new TypeError("Disposable dispose must be a function");
  }
  return descriptor.value as () => Promise<void> | void;
}

function disposalDiagnostic(
  error: unknown,
  source: DiagnosticSource,
  redact: (value: string) => string,
): RuntimeDiagnostic {
  const errorValue = error instanceof Error ? error : undefined;
  return runtimeDiagnostic({
    code: "LIFECYCLE_DISPOSAL_FAILED",
    message: "Component disposable failed",
    source,
    cause:
      errorValue === undefined
        ? { name: "UnknownCause", message: "Non-Error thrown by component disposable" }
        : {
            name: redact(errorValue.name),
            message: redact(errorValue.message),
            ...(errorValue.stack === undefined ? {} : { stack: redact(errorValue.stack) }),
          },
  });
}

export function createDisposableStack(
  options: DisposableStackOptions = {},
): ComponentDisposableStack {
  const source = options.diagnosticSource ?? { kind: "plugin", id: "component" };
  const redact = options.redact ?? ((value: string) => value);
  const pending: Array<() => Promise<void> | void> = [];
  let disposePromise: Promise<readonly RuntimeDiagnostic[]> | undefined;

  return Object.freeze({
    add(disposable: ComponentDisposable): void {
      if (disposePromise !== undefined) {
        throw new Error("Cannot add a disposable after disposal has started");
      }
      pending.push(disposalFunction(disposable));
    },
    dispose(): Promise<readonly RuntimeDiagnostic[]> {
      if (disposePromise !== undefined) return disposePromise;
      disposePromise = (async () => {
        const diagnostics: RuntimeDiagnostic[] = [];
        for (const dispose of pending.splice(0).reverse()) {
          try {
            await dispose();
          } catch (error) {
            diagnostics.push(disposalDiagnostic(error, source, redact));
          }
        }
        return Object.freeze(diagnostics);
      })();
      return disposePromise;
    },
    get disposed(): boolean {
      return disposePromise !== undefined;
    },
  });
}
