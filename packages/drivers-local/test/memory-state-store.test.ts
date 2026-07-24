import { stateStoreConformance } from "@tegojs/testkit";
import { MemoryStateStore } from "../src/index.js";

stateStoreConformance(() => new MemoryStateStore(), { name: "MemoryStateStore" });
