import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const zeroObjectId = /^0{40}$/u;

export function commitlintArguments(environment = process.env) {
  const from = environment.COMMITLINT_FROM?.trim();
  const to = environment.COMMITLINT_TO?.trim() || "HEAD";

  if (from && !zeroObjectId.test(from)) {
    return ["--from", from, "--to", to, "--verbose"];
  }

  return ["--last", "--verbose"];
}

export function runCommitlint(environment = process.env) {
  const result = spawnSync("commitlint", commitlintArguments(environment), {
    env: environment,
    stdio: "inherit",
  });

  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runCommitlint();
}
