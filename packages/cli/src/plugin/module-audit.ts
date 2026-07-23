import { builtinModules } from "node:module";
import { DiagnosticError, runtimeDiagnostic } from "@tegojs/contracts";

interface Token {
  readonly kind: "identifier" | "number" | "punctuation" | "string" | "template";
  readonly value: string;
  readonly escaped?: boolean;
}

export interface ModuleAudit {
  readonly runtimeImports: readonly string[];
}

const MAX_LEXICAL_NESTING = 256;
const PLUGIN_SDK_SPECIFIER = "@tegojs/plugin-sdk";
const NODE_BUILTINS = new Set(
  builtinModules.map((specifier) =>
    specifier.startsWith("node:") ? specifier : `node:${specifier}`,
  ),
);
const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

function diagnostic(
  code: "ARTIFACT_IMPORT_UNSUPPORTED" | "ARTIFACT_MODULE_FORMAT_UNSUPPORTED",
  message: string,
  specifier?: string,
): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code,
      message,
      source: { kind: "artifact", id: "module-audit" },
      ...(specifier === undefined ? {} : { details: { specifier } }),
    }),
  );
}

function importError(message: string, specifier?: string): DiagnosticError {
  return diagnostic("ARTIFACT_IMPORT_UNSUPPORTED", message, specifier);
}

function lexicalError(message: string): DiagnosticError {
  return importError(`Built JavaScript ${message}`);
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/u.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[0-9A-Za-z_$]/u.test(character);
}

function canStartRegex(previous: Token | undefined): boolean {
  if (previous === undefined) return true;
  if (previous.kind === "identifier") return REGEX_PREFIX_KEYWORDS.has(previous.value);
  if (previous.kind === "number" || previous.kind === "string" || previous.kind === "template") {
    return false;
  }
  return previous.value !== ")" && previous.value !== "]" && previous.value !== "}";
}

function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];

  function scanString(
    index: number,
    quote: "'" | '"',
  ): { readonly index: number; readonly token: Token } {
    let value = "";
    let escaped = false;
    index += 1;
    while (index < source.length) {
      const character = source[index] ?? "";
      if (character === quote) {
        return { index: index + 1, token: { escaped, kind: "string", value } };
      }
      if (character === "\\") {
        escaped = true;
        index += 1;
        if (index >= source.length) throw lexicalError("has an invalid string");
        if (source[index] === "\r" && source[index + 1] === "\n") index += 1;
        value += source[index] ?? "";
        index += 1;
        continue;
      }
      if (character === "\n" || character === "\r") {
        throw lexicalError("has an unterminated string");
      }
      value += character;
      index += 1;
    }
    throw lexicalError("has an unterminated string");
  }

  function skipRegex(index: number): number {
    let inCharacterClass = false;
    index += 1;
    while (index < source.length) {
      const character = source[index] ?? "";
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === "\n" || character === "\r") {
        throw lexicalError("has an unterminated regular expression");
      }
      if (character === "[") {
        inCharacterClass = true;
        index += 1;
        continue;
      }
      if (character === "]" && inCharacterClass) {
        inCharacterClass = false;
        index += 1;
        continue;
      }
      if (character === "/" && !inCharacterClass) {
        index += 1;
        while (index < source.length && isIdentifierPart(source[index] ?? "")) index += 1;
        return index;
      }
      index += 1;
    }
    throw lexicalError("has an unterminated regular expression");
  }

  function scanTemplate(index: number, depth: number): number {
    if (depth > MAX_LEXICAL_NESTING) {
      throw lexicalError("exceeds the module audit nesting limit");
    }
    index += 1;
    while (index < source.length) {
      const character = source[index] ?? "";
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === "`") return index + 1;
      if (character === "$" && source[index + 1] === "{") {
        const expression = scanCode(index + 2, true, depth + 1);
        if (!expression.closed) throw lexicalError("has an unterminated template expression");
        index = expression.index;
        continue;
      }
      index += 1;
    }
    throw lexicalError("has an unterminated template");
  }

  function scanCode(
    index: number,
    stopAtRightBrace: boolean,
    depth: number,
  ): { readonly closed: boolean; readonly index: number } {
    let braceDepth = 0;
    let previous: Token | undefined;
    const emit = (token: Token) => {
      tokens.push(token);
      previous = token;
    };

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
        if (end < 0) throw lexicalError("contains an unterminated comment");
        index = end + 2;
        continue;
      }
      if (character === "'" || character === '"') {
        const result = scanString(index, character);
        index = result.index;
        emit(result.token);
        continue;
      }
      if (character === "`") {
        index = scanTemplate(index, depth + 1);
        emit({ kind: "template", value: "" });
        continue;
      }
      if (character === "/" && canStartRegex(previous)) {
        index = skipRegex(index);
        emit({ kind: "punctuation", value: "/regex/" });
        continue;
      }
      if (isIdentifierStart(character)) {
        const start = index;
        index += 1;
        while (index < source.length && isIdentifierPart(source[index] ?? "")) index += 1;
        emit({ kind: "identifier", value: source.slice(start, index) });
        continue;
      }
      if (/[0-9]/u.test(character)) {
        const start = index;
        index += 1;
        while (index < source.length && /[0-9A-Za-z_.]/u.test(source[index] ?? "")) index += 1;
        emit({ kind: "number", value: source.slice(start, index) });
        continue;
      }
      if (character === "{") {
        braceDepth += 1;
        emit({ kind: "punctuation", value: character });
        index += 1;
        continue;
      }
      if (character === "}") {
        if (stopAtRightBrace && braceDepth === 0) {
          return { closed: true, index: index + 1 };
        }
        braceDepth = Math.max(0, braceDepth - 1);
        emit({ kind: "punctuation", value: character });
        index += 1;
        continue;
      }
      emit({ kind: "punctuation", value: character });
      index += 1;
    }
    return { closed: false, index };
  }

  scanCode(0, false, 0);
  return tokens;
}

function validateSpecifier(token: Token | undefined, runtimeImports: Set<string>): void {
  if (token?.kind !== "string" || token.escaped === true) {
    throw importError("Module specifiers must be unescaped string literals");
  }
  const specifier = token.value;
  if (specifier.startsWith("./") || specifier.startsWith("../")) return;
  if (specifier === PLUGIN_SDK_SPECIFIER || NODE_BUILTINS.has(specifier)) {
    runtimeImports.add(specifier);
    return;
  }
  throw importError(
    "Bare third-party module specifiers are not supported by phase-one plugin artifacts",
    specifier,
  );
}

function isPropertyAccess(tokens: readonly Token[], index: number): boolean {
  return tokens[index - 1]?.value === ".";
}

function assertNoCommonJs(tokens: readonly Token[]): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "identifier" || isPropertyAccess(tokens, index)) continue;
    const next = tokens[index + 1];
    const afterNext = tokens[index + 2];
    if (
      (token.value === "require" && next?.value === "(") ||
      (token.value === "module" && next?.value === "." && afterNext?.value === "exports") ||
      (token.value === "exports" && next?.value === ".")
    ) {
      throw diagnostic(
        "ARTIFACT_MODULE_FORMAT_UNSUPPORTED",
        "Plugin build output contains CommonJS syntax",
      );
    }
  }
}

export function auditJavaScriptModules(source: string): ModuleAudit {
  const tokens = tokenize(source);
  assertNoCommonJs(tokens);
  const runtimeImports = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "identifier" || isPropertyAccess(tokens, index)) continue;
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
