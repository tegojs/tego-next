import { stateStoreConformance } from "@tego/testkit";
import { MemoryStateStore } from "../src/index.js";

stateStoreConformance(() => new MemoryStateStore(), { name: "MemoryStateStore" });
