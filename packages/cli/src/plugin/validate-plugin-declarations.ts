import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import process from "node:process";
import { API, DiagnosticCategory, type Diagnostic } from "typescript/unstable/sync";

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function diagnosticText(diagnostic: Diagnostic): string {
  const nested = diagnostic.messageChain?.map(diagnosticText) ?? [];
  return [diagnostic.text, ...nested].join("\n");
}

async function main(): Promise<void> {
  const [configurationPath, sourcePath] = process.argv.slice(2);
  if (configurationPath === undefined || sourcePath === undefined) {
    throw new TypeError("declaration validation requires a configuration and source root");
  }
  const sourceRoot = await realpath(sourcePath);
  const api = new API({ cwd: process.cwd() });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configurationPath] });
    try {
      const project = snapshot
        .getProjects()
        .find((candidate) => candidate.configFileName === configurationPath);
      if (project === undefined) {
        throw new Error("TypeScript did not open the plugin declaration validation project");
      }
      const diagnostics = [
        ...project.program.getSyntacticDiagnostics(),
        ...project.program.getBindDiagnostics(),
        ...project.program.getSemanticDiagnostics(),
        ...project.program.getDeclarationDiagnostics(),
      ];
      const localDiagnostics: Diagnostic[] = [];
      for (const diagnostic of diagnostics) {
        if (
          diagnostic.category !== DiagnosticCategory.Error ||
          diagnostic.fileName === undefined ||
          !isContained(sourceRoot, diagnostic.fileName)
        ) {
          continue;
        }
        const canonical = await realpath(diagnostic.fileName);
        if (isContained(sourceRoot, canonical)) {
          localDiagnostics.push(diagnostic);
        }
      }
      if (localDiagnostics.length > 0) {
        process.stderr.write(
          localDiagnostics
            .map(
              (diagnostic) =>
                `${diagnostic.fileName ?? sourceRoot}:${diagnostic.pos} TS${diagnostic.code}: ${diagnosticText(diagnostic)}`,
            )
            .join("\n"),
        );
        process.stderr.write("\n");
        process.exitCode = 1;
      }
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

await main();
