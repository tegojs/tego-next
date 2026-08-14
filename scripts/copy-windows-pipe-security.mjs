import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const brokerPowerShellSource = join(root, "scripts", "windows-control-broker.ps1");
const brokerPowerShellDestination = join(
  root,
  "packages",
  "cli",
  "dist",
  "src",
  "control",
  "windows-control-broker.ps1",
);
const brokerCSharpSource = join(root, "scripts", "windows-control-broker.cs");
const brokerCSharpDestination = join(
  root,
  "packages",
  "cli",
  "dist",
  "src",
  "control",
  "windows-control-broker.cs",
);
const cliBinary = join(root, "packages", "cli", "dist", "src", "bin.js");

export async function finalizeCliBuild({
  binary,
  brokerCSharpDestination,
  brokerCSharpSource,
  brokerPowerShellDestination,
  brokerPowerShellSource,
  platform = process.platform,
}) {
  await Promise.all(
    [brokerPowerShellDestination, brokerCSharpDestination].map((asset) =>
      mkdir(dirname(asset), { recursive: true }),
    ),
  );
  await Promise.all([
    copyFile(brokerPowerShellSource, brokerPowerShellDestination),
    copyFile(brokerCSharpSource, brokerCSharpDestination),
  ]);
  if (platform !== "win32") await chmod(binary, 0o755);
}

await finalizeCliBuild({
  binary: cliBinary,
  brokerCSharpDestination,
  brokerCSharpSource,
  brokerPowerShellDestination,
  brokerPowerShellSource,
});
