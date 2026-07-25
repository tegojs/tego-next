const marker = Symbol.for("tego.example.echo.loaded");
const globals = globalThis as Record<PropertyKey, unknown>;
globals[marker] = (typeof globals[marker] === "number" ? globals[marker] : 0) + 1;

export default {
  protocol: "tego.component/1.0",
  kind: "task",
  async run(_context: unknown, input: unknown): Promise<unknown> {
    return input;
  },
};
