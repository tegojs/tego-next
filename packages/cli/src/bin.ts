#!/usr/bin/env node
import { runCli } from "./run-cli.js";

process.exitCode = await runCli({ argv: process.argv.slice(2) });
