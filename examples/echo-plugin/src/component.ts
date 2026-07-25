import { defineComponent } from "@tegojs/plugin-sdk";

const marker = Symbol.for("tego.example.echo.loaded");
const globals = globalThis as Record<PropertyKey, unknown>;
globals[marker] = (typeof globals[marker] === "number" ? globals[marker] : 0) + 1;

export default defineComponent({
  kind: "task",
  async run(_context, input) {
    return input;
  },
});
