import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const helperSource = join(root, "scripts", "windows-pipe-security.ps1");
const helperDestination = join(
  root,
  "packages",
  "cli",
  "dist",
  "src",
  "control",
  "windows-pipe-security.ps1",
);
const cliBinary = join(root, "packages", "cli", "dist", "src", "bin.js");

export async function finalizeCliBuild({
  binary,
  helperDestination: destination,
  helperSource: source,
  platform = process.platform,
}) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (platform !== "win32") await chmod(binary, 0o755);
}

await finalizeCliBuild({
  binary: cliBinary,
  helperDestination,
  helperSource,
});
