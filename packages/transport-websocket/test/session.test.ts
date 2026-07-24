import { workerSessionConformance } from "@tegojs/testkit";
import { createMainEndpoint, createWorkerEndpoint } from "../src/index.js";

workerSessionConformance(createMainEndpoint, createWorkerEndpoint);
