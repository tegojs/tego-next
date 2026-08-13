import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const helper = fileURLToPath(new URL("./windows-pipe-security.ps1", import.meta.url));
const cases = ["RW", "RWRC", "RWRCD"];

if (process.platform !== "win32") throw new Error("Windows diagnostic requires Windows");

for (const access of cases) {
  const endpoint = `\\\\.\\pipe\\tego-windows-access-probe-${process.pid}-${randomUUID()}`;
  const server = createServer({ pauseOnConnect: true });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ exclusive: true, path: endpoint }, resolve);
  });
  try {
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        helper,
        "-Endpoint",
        endpoint,
        "-Operation",
        "inspect",
        "-BarrierCount",
        "0",
        "-ProbeOnly",
        "-ProbeAccess",
        access,
      ],
      { encoding: "utf8", maxBuffer: 4096, shell: false, timeout: 3_000, windowsHide: true },
    );
    const output = `${result.stdout}${result.stderr}`.trim();
    const safe =
      /^TEGO_WINDOWS_PIPE_(?:ACCESS_(?:RW|RWRC|RWRCD)_OK|SECURITY_INITIAL_OPEN_FAILED(?::(?:2|5|87|123|231))?)$/u.test(
        output,
      )
        ? output
        : result.error?.code === "ETIMEDOUT"
          ? "TEGO_WINDOWS_PIPE_ACCESS_TIMEOUT"
          : "TEGO_WINDOWS_PIPE_ACCESS_UNKNOWN_FAILED";
    process.stdout.write(`${access}:${safe}\n`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}
