import { DiagnosticError, runtimeDiagnostic } from "@tegojs/contracts";
import { builtinModules } from "node:module";

interface Token {
  readonly kind: "identifier" | "punctuation" | "string";
  readonly value: string;
  readonly escaped?: boolean;
}

export interface ModuleAudit {
  readonly runtimeImports: readonly string[];
}

const NODE_BUILTINS = new Set(
  builtinModules.map((specifier) =>
    specifier.startsWith("node:") ? specifier : `node:${specifier}`,
  ),
);

function importError(message: string, specifier?: string): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "ARTIFACT_IMPORT_UNSUPPORTED",
      message,
      source: { kind: "artifact", id: "module-audit" },
      ...(specifier === undefined ? {} : { details: { specifier } }),
    }),
  );
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/u.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[0-9A-Za-z_$]/u.test(character);
}

function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw importError("Built JavaScript contains an unterminated comment");
      index = end + 2;
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      let value = "";
      let escaped = false;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        const current = source[index] ?? "";
        if (current === "\\") {
          escaped = true;
          index += 1;
          if (index >= source.length) throw importError("Built JavaScript has an invalid string");
          value += source[index] ?? "";
          index += 1;
          continue;
        }
        if (current === "\n" || current === "\r") {
          throw importError("Built JavaScript has an unterminated string");
        }
        value += current;
        index += 1;
      }
      if (source[index] !== quote) throw importError("Built JavaScript has an unterminated string");
      index += 1;
      tokens.push({ escaped, kind: "string", value });
      continue;
    }
    if (character === "`") {
      let escaped = false;
      let interpolated = false;
      index += 1;
      while (index < source.length && source[index] !== "`") {
        if (source[index] === "\\") {
          escaped = true;
          index += 2;
          continue;
        }
        if (source[index] === "$" && source[index + 1] === "{") interpolated = true;
        index += 1;
      }
      if (source[index] !== "`") throw importError("Built JavaScript has an unterminated template");
      index += 1;
      if (interpolated) {
        throw importError("Interpolated templates are not accepted by the phase-one module audit");
      }
      tokens.push({ escaped, kind: "string", value: "" });
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index] ?? "")) index += 1;
      tokens.push({ kind: "identifier", value: source.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", value: character });
    index += 1;
  }
  return tokens;
}

function validateSpecifier(token: Token | undefined, runtimeImports: Set<string>): void {
  if (token?.kind !== "string" || token.escaped === true) {
    throw importError("Module specifiers must be unescaped string literals");
  }
  const specifier = token.value;
  if (specifier.startsWith("./") || specifier.startsWith("../")) return;
  if (NODE_BUILTINS.has(specifier)) {
    runtimeImports.add(specifier);
    return;
  }
  throw importError(
    "Bare third-party module specifiers are not supported by phase-one plugin artifacts",
    specifier,
  );
}

export function auditJavaScriptModules(source: string): ModuleAudit {
  const tokens = tokenize(source);
  const runtimeImports = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "identifier") continue;
    if (token.value === "import") {
      const next = tokens[index + 1];
      if (next?.value === ".") continue;
      if (next?.value === "(") {
        validateSpecifier(tokens[index + 2], runtimeImports);
        if (tokens[index + 3]?.value !== ")") {
          throw importError("Dynamic imports must contain exactly one literal specifier");
        }
        continue;
      }
      if (next?.kind === "string") {
        validateSpecifier(next, runtimeImports);
        continue;
      }
      let cursor = index + 1;
      while (cursor < tokens.length && tokens[cursor]?.value !== ";") {
        if (tokens[cursor]?.value === "from") {
          validateSpecifier(tokens[cursor + 1], runtimeImports);
          break;
        }
        cursor += 1;
      }
    }
    if (token.value === "export") {
      let cursor = index + 1;
      while (cursor < tokens.length && tokens[cursor]?.value !== ";") {
        if (tokens[cursor]?.value === "from") {
          validateSpecifier(tokens[cursor + 1], runtimeImports);
          break;
        }
        cursor += 1;
      }
    }
  }
  return { runtimeImports: [...runtimeImports].sort() };
}
