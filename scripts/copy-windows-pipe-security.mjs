import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "scripts", "windows-pipe-security.ps1");
const destination = join(
  root,
  "packages",
  "cli",
  "dist",
  "src",
  "control",
  "windows-pipe-security.ps1",
);

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
