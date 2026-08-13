import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./windows-pipe-security.ps1", import.meta.url));
const cases = ["RW", "RC", "WD", "RCWD"];

if (process.platform !== "win32") throw new Error("Windows diagnostic requires Windows");

async function probe(access) {
  const endpoint = `\\\\.\\pipe\\tego-windows-access-probe-${process.pid}-${randomUUID()}`;
  const sockets = new Set();
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ exclusive: true, path: endpoint }, resolve);
  });
  try {
    const output = await new Promise((resolve) => {
      const child = spawn(
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
        { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      let bytes = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 3_000);
      const append = (chunk) => {
        if (bytes.length < 4096) bytes += chunk.toString("utf8").slice(0, 4096 - bytes.length);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.once("error", () => {});
      child.once("close", () => {
        clearTimeout(timer);
        const trimmed = bytes.trim();
        resolve(
          timedOut
            ? "TEGO_WINDOWS_PIPE_ACCESS_TIMEOUT"
            : /^TEGO_WINDOWS_PIPE_ACCESS_(?:RW|RC|WD|RCWD)_(?:OK|FAILED:[0-9]{1,10})$/u.test(
                  trimmed,
                )
              ? trimmed
              : "TEGO_WINDOWS_PIPE_ACCESS_UNKNOWN_FAILED",
        );
      });
    });
    process.stdout.write(`${access}:${output}\n`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

for (const access of cases) await probe(access);
