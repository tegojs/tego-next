import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveNpmCli(env = process.env, execPath = process.execPath) {
  if (env.npm_execpath?.trim()) return env.npm_execpath;

  const executableDirectory = dirname(execPath);
  const candidates =
    process.platform === "win32"
      ? [
          join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
          join(executableDirectory, "npm-cli.js"),
        ]
      : [resolve(executableDirectory, "../lib/node_modules/npm/bin/npm-cli.js")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function parseReporterArguments(args) {
  const separator = args.indexOf("--");
  const options = args.slice(0, separator);
  const command = separator === -1 ? [] : args.slice(separator + 1);
  let name;
  let artifacts;
  for (let index = 0; index < options.length; index += 2) {
    if (options[index] === "--name") name = options[index + 1];
    if (options[index] === "--artifacts") artifacts = options[index + 1];
  }
  if (!name || !artifacts || command.length === 0) {
    throw new Error(
      "Usage: run-ci-test.mjs --name <name> --artifacts <directory> -- <command> [args...]",
    );
  }
  return { name, artifacts, command: command[0], args: command.slice(1) };
}

export async function runReportedCommand({ name, artifacts, command, args }) {
  mkdirSync(artifacts, { recursive: true });
  const resultPath = join(artifacts, `${name}-result.json`);
  const logPath = join(artifacts, `${name}-process.log`);
  writeFileSync(logPath, `[ci-test] ${command} ${args.join(" ")}\n`);

  const requestedCommand = command;
  const requestedArgs = args;
  const npmInvocation = command === "npm";
  const actualCommand = npmInvocation ? process.execPath : command;
  const actualArgs = npmInvocation ? [resolveNpmCli(), ...args] : args;
  const startedAt = new Date().toISOString();

  const outcome = await new Promise((resolveOutcome) => {
    const child = spawn(actualCommand, actualArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      appendFileSync(logPath, chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      appendFileSync(logPath, chunk);
    });
    child.once("error", (error) => resolveOutcome({ exitCode: 1, error: error.message }));
    child.once("close", (exitCode, signal) =>
      resolveOutcome({ exitCode: exitCode ?? 1, signal: signal ?? undefined }),
    );
  });

  const metadata = {
    name,
    command: requestedCommand,
    args: requestedArgs,
    actualCommand,
    actualArgs,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...outcome,
  };
  writeFileSync(resultPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata.exitCode;
}

async function main() {
  try {
    process.exitCode = await runReportedCommand(parseReporterArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
