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

export interface ModuleAuditOptions {
  readonly maxWork?: number;
}

const MAX_LEXICAL_NESTING = 256;
const PLUGIN_SDK_SPECIFIER = "@tegojs/plugin-sdk";
const NODE_BUILTINS = new Set(
  builtinModules.map((specifier) =>
    specifier.startsWith("node:") ? specifier : `node:${specifier}`,
  ),
);
const CONTROL_PAREN_KEYWORDS = new Set(["catch", "for", "if", "switch", "while", "with"]);
const EXPRESSION_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const MULTI_CHARACTER_PUNCTUATORS = [
  ">>>=",
  "===",
  "!==",
  ">>>",
  "**=",
  "&&=",
  "||=",
  "??=",
  "<<=",
  ">>=",
  "==",
  "!=",
  "<=",
  ">=",
  "++",
  "--",
  "=>",
  "&&",
  "||",
  "??",
  "**",
  "<<",
  ">>",
  "?.",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
] as const;

function diagnostic(
  code:
    | "ARTIFACT_IMPORT_UNSUPPORTED"
    | "ARTIFACT_MODULE_AUDIT_LIMIT"
    | "ARTIFACT_MODULE_FORMAT_UNSUPPORTED",
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

class WorkBudget {
  readonly #maximum: number;
  #used = 0;

  constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new RangeError("maxWork must be a positive safe integer");
    }
    this.#maximum = maximum;
  }

  step(): void {
    this.#used += 1;
    if (this.#used > this.#maximum) {
      throw diagnostic(
        "ARTIFACT_MODULE_AUDIT_LIMIT",
        "Plugin module audit exceeded its configured work limit",
      );
    }
  }
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/u.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[0-9A-Za-z_$]/u.test(character);
}

function tokenize(source: string, budget: WorkBudget): readonly Token[] {
  const tokens: Token[] = [];

  function scanString(
    index: number,
    quote: "'" | '"',
  ): { readonly index: number; readonly token: Token } {
    let value = "";
    let escaped = false;
    index += 1;
    while (index < source.length) {
      budget.step();
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
      budget.step();
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
        while (index < source.length && isIdentifierPart(source[index] ?? "")) {
          budget.step();
          index += 1;
        }
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
      budget.step();
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

  function scanPunctuator(index: number): string {
    return (
      MULTI_CHARACTER_PUNCTUATORS.find((punctuator) => source.startsWith(punctuator, index)) ??
      source[index] ??
      ""
    );
  }

  function scanCode(
    index: number,
    stopAtRightBrace: boolean,
    depth: number,
  ): { readonly closed: boolean; readonly index: number } {
    let braceDepth = 0;
    let expressionAllowed = true;
    let previous: Token | undefined;
    const parens: ("control" | "normal")[] = [];
    const emit = (token: Token) => {
      tokens.push(token);
      previous = token;
    };

    while (index < source.length) {
      budget.step();
      const character = source[index] ?? "";
      if (/\s/u.test(character)) {
        index += 1;
        continue;
      }
      if (character === "/" && source[index + 1] === "/") {
        index += 2;
        while (index < source.length && source[index] !== "\n") {
          budget.step();
          index += 1;
        }
        continue;
      }
      if (character === "/" && source[index + 1] === "*") {
        index += 2;
        while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
          budget.step();
          index += 1;
        }
        if (index >= source.length) throw lexicalError("contains an unterminated comment");
        index += 2;
        continue;
      }
      if (character === "'" || character === '"') {
        const result = scanString(index, character);
        index = result.index;
        emit(result.token);
        expressionAllowed = false;
        continue;
      }
      if (character === "`") {
        index = scanTemplate(index, depth + 1);
        emit({ kind: "template", value: "" });
        expressionAllowed = false;
        continue;
      }
      if (character === "/" && expressionAllowed) {
        index = skipRegex(index);
        emit({ kind: "punctuation", value: "/regex/" });
        expressionAllowed = false;
        continue;
      }
      if (isIdentifierStart(character)) {
        const start = index;
        index += 1;
        while (index < source.length && isIdentifierPart(source[index] ?? "")) {
          budget.step();
          index += 1;
        }
        const token = { kind: "identifier", value: source.slice(start, index) } as const;
        emit(token);
        expressionAllowed = EXPRESSION_PREFIX_KEYWORDS.has(token.value);
        continue;
      }
      if (/[0-9]/u.test(character)) {
        const start = index;
        index += 1;
        while (index < source.length && /[0-9A-Za-z_.]/u.test(source[index] ?? "")) {
          budget.step();
          index += 1;
        }
        emit({ kind: "number", value: source.slice(start, index) });
        expressionAllowed = false;
        continue;
      }
      if (character === "{") {
        braceDepth += 1;
        emit({ kind: "punctuation", value: character });
        expressionAllowed = true;
        index += 1;
        continue;
      }
      if (character === "}") {
        if (stopAtRightBrace && braceDepth === 0) {
          return { closed: true, index: index + 1 };
        }
        braceDepth = Math.max(0, braceDepth - 1);
        emit({ kind: "punctuation", value: character });
        expressionAllowed = false;
        index += 1;
        continue;
      }

      const punctuator = scanPunctuator(index);
      const wasExpressionAllowed = expressionAllowed;
      emit({ kind: "punctuation", value: punctuator });
      index += punctuator.length;
      if (punctuator === "(") {
        parens.push(
          previous !== undefined &&
            tokens[tokens.length - 2]?.kind === "identifier" &&
            CONTROL_PAREN_KEYWORDS.has(tokens[tokens.length - 2]?.value ?? "") &&
            tokens[tokens.length - 3]?.value !== "."
            ? "control"
            : "normal",
        );
        expressionAllowed = true;
      } else if (punctuator === ")") {
        expressionAllowed = parens.pop() === "control";
      } else if (punctuator === "]") {
        expressionAllowed = false;
      } else if (punctuator === "++" || punctuator === "--") {
        expressionAllowed = wasExpressionAllowed;
      } else if (punctuator === "." || punctuator === "?." || punctuator === "/regex/") {
        expressionAllowed = false;
      } else {
        expressionAllowed = true;
      }
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
  return tokens[index - 1]?.value === "." || tokens[index - 1]?.value === "?.";
}

function matchingBrace(tokens: readonly Token[], start: number, budget: WorkBudget): number {
  let depth = 0;
  for (let cursor = start; cursor < tokens.length; cursor += 1) {
    budget.step();
    if (tokens[cursor]?.value === "{") depth += 1;
    if (tokens[cursor]?.value === "}") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  throw importError("Module declaration contains an unterminated binding list");
}

function auditImport(
  tokens: readonly Token[],
  index: number,
  runtimeImports: Set<string>,
  budget: WorkBudget,
): number {
  const next = tokens[index + 1];
  if (next?.value === ".") return index + 1;
  if (next?.value === "(") {
    throw importError("Dynamic imports are not supported by phase-one plugin artifacts");
  }
  if (next?.kind === "string") {
    validateSpecifier(next, runtimeImports);
    return index + 1;
  }

  let cursor = index + 1;
  budget.step();
  if (tokens[cursor]?.kind === "identifier") {
    cursor += 1;
    if (tokens[cursor]?.value === ",") cursor += 1;
  }
  if (tokens[cursor]?.value === "*") {
    if (tokens[cursor + 1]?.value !== "as" || tokens[cursor + 2]?.kind !== "identifier") {
      throw importError("Namespace import has an invalid binding");
    }
    cursor += 3;
  } else if (tokens[cursor]?.value === "{") {
    cursor = matchingBrace(tokens, cursor, budget) + 1;
  }
  if (tokens[cursor]?.value !== "from") {
    throw importError("Static import is missing its module specifier");
  }
  validateSpecifier(tokens[cursor + 1], runtimeImports);
  return cursor + 1;
}

function auditExport(
  tokens: readonly Token[],
  index: number,
  runtimeImports: Set<string>,
  budget: WorkBudget,
): number {
  let cursor = index + 1;
  const next = tokens[cursor];
  if (next?.value === "*") {
    cursor += 1;
    if (tokens[cursor]?.value === "as") cursor += 2;
    if (tokens[cursor]?.value !== "from") {
      throw importError("Export declaration is missing its module specifier");
    }
    validateSpecifier(tokens[cursor + 1], runtimeImports);
    return cursor + 1;
  }
  if (next?.value !== "{") return index;
  cursor = matchingBrace(tokens, cursor, budget) + 1;
  if (tokens[cursor]?.value !== "from") return cursor - 1;
  validateSpecifier(tokens[cursor + 1], runtimeImports);
  return cursor + 1;
}

export function auditJavaScriptModules(
  source: string,
  options: ModuleAuditOptions = {},
): ModuleAudit {
  const defaultMaximum = Math.min(Number.MAX_SAFE_INTEGER, source.length * 4 + 1_024);
  const budget = new WorkBudget(options.maxWork ?? defaultMaximum);
  const tokens = tokenize(source, budget);
  const runtimeImports = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    budget.step();
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
    if (token.value === "import") {
      index = auditImport(tokens, index, runtimeImports, budget);
    } else if (token.value === "export") {
      index = auditExport(tokens, index, runtimeImports, budget);
    }
  }
  return { runtimeImports: [...runtimeImports].sort() };
}
