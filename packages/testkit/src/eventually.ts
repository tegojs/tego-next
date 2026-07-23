export interface EventuallyOptions {
  readonly attempts?: number;
  readonly advance?: () => void | Promise<void>;
}

export async function eventually<T>(
  assertion: () => T | Promise<T>,
  options: EventuallyOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 20;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("attempts must be a positive integer");
  }

  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await assertion();
    } catch (error) {
      failure = error;
      if (attempt + 1 < attempts) {
        await (options.advance?.() ?? Promise.resolve());
      }
    }
  }
  throw failure;
}
