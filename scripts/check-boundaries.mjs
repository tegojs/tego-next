import { readdir, readFile } from "node:fs/promises";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const CONTRACTS_PACKAGE = "@tegojs/contracts";
const CLI_PACKAGE = "@tegojs/cli";

const FIRST_LAYER_FORBIDDEN_FRAGMENTS = [
  "tego/",
  "frontend",
  "http",
  "acl",
  "cache",
  "workflow",
  "datasource",
];

function npmAliasTarget(version) {
  if (typeof version !== "string") {
    return undefined;
  }

  return /^npm:((?:@[^/]+\/[^@]+)|(?:[^@]+))(?:@.*)?$/.exec(version)?.[1];
}

function localAliasTarget(version) {
  return typeof version === "string" ? /^(?:file|link):(.+)$/.exec(version)?.[1] : undefined;
}

function dependencyEntries(manifest) {
  return DEPENDENCY_FIELDS.flatMap((field) =>
    Object.entries(manifest[field] ?? {}).map(([specifier, version]) => ({
      specifier,
      targetSpecifier: npmAliasTarget(version) ?? localAliasTarget(version) ?? specifier,
    })),
  );
}

function containsForbiddenFragment(value) {
  const normalized = value.toLowerCase();
  return FIRST_LAYER_FORBIDDEN_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

async function readWorkspaceManifests(root, directoryName, kind) {
  const directory = new URL(`${directoryName}/`, root);
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const workspaceDirectory = new URL(`${entry.name}/`, directory);
        const manifest = JSON.parse(
          await readFile(new URL("package.json", workspaceDirectory), "utf8"),
        );
        return { directory: workspaceDirectory, kind, manifest };
      }),
  );
}

async function emittedJavaScriptFiles(directory) {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryUrl = new URL(entry.name, directory);
      if (entry.isDirectory()) {
        return emittedJavaScriptFiles(new URL(`${entry.name}/`, directory));
      }
      return entry.isFile() && /\.(?:m?js)$/.test(entry.name) ? [entryUrl] : [];
    }),
  );

  return files.flat();
}

function canStartRegularExpression(tokens) {
  const previous = tokens.at(-1);
  if (!previous) {
    return true;
  }

  if (
    previous.type === "identifier" &&
    ["await", "case", "delete", "return", "throw", "typeof", "void", "yield"].includes(
      previous.value,
    )
  ) {
    return true;
  }

  return (
    previous.type === "punctuator" &&
    [
      "(",
      "[",
      "{",
      ",",
      ";",
      ":",
      "=",
      "!",
      "?",
      "&",
      "|",
      "+",
      "-",
      "*",
      "%",
      "^",
      "~",
      "<",
      ">",
    ].includes(previous.value)
  );
}

function javascriptTokens(source) {
  const tokens = [];
  const templateExpressionDepths = [];
  let index = 0;

  function skipTemplateText() {
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
        continue;
      }
      if (source[index] === "`") {
        index += 1;
        return;
      }
      if (source[index] === "$" && source[index + 1] === "{") {
        templateExpressionDepths.push(0);
        index += 2;
        return;
      }
      index += 1;
    }
  }

  while (index < source.length) {
    const character = source[index];

    if (character === "}" && templateExpressionDepths.length > 0) {
      const depthIndex = templateExpressionDepths.length - 1;
      if (templateExpressionDepths[depthIndex] === 0) {
        templateExpressionDepths.pop();
        index += 1;
        skipTemplateText();
        continue;
      }
      templateExpressionDepths[depthIndex] -= 1;
    }

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) {
        break;
      }
      continue;
    }

    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }

    if (character === "'" || character === '"') {
      const quote = character;
      let escaped = false;
      let value = "";
      index += 1;

      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          escaped = true;
          index += 1;
          if (index < source.length) {
            value += source[index];
          }
        } else {
          value += source[index];
        }
        index += 1;
      }

      index += 1;
      tokens.push({ escaped, type: "string", value });
      continue;
    }

    if (character === "`") {
      tokens.push({ type: "template", value: "" });
      index += 1;
      skipTemplateText();
      continue;
    }

    if (["++", "--"].includes(source.slice(index, index + 2))) {
      tokens.push({ type: "punctuator", value: source.slice(index, index + 2) });
      index += 2;
      continue;
    }

    if (character === "/" && canStartRegularExpression(tokens)) {
      let inCharacterClass = false;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "[") {
          inCharacterClass = true;
        } else if (source[index] === "]") {
          inCharacterClass = false;
        } else if (source[index] === "/" && !inCharacterClass) {
          index += 1;
          while (index < source.length && /[A-Za-z]/.test(source[index])) {
            index += 1;
          }
          break;
        }
        index += 1;
      }
      continue;
    }

    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[\w$]/.test(source[index])) {
        index += 1;
      }
      tokens.push({ type: "identifier", value: source.slice(start, index) });
      continue;
    }

    if (character === "{" && templateExpressionDepths.length > 0) {
      templateExpressionDepths[templateExpressionDepths.length - 1] += 1;
    }

    tokens.push({ type: "punctuator", value: character });
    index += 1;
  }

  return tokens;
}

// The architecture grammar accepts only unescaped quoted import specifiers.
// Template and computed dynamic imports fail closed instead of being evaluated.
function analyzeImports(source) {
  const specifiers = new Set();
  const tokens = javascriptTokens(source);
  let unsupportedSpecifier = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token.type !== "identifier" ||
      !["import", "export"].includes(token.value) ||
      tokens[index - 1]?.value === "."
    ) {
      continue;
    }

    const next = tokens[index + 1];
    if (token.value === "import" && next?.type === "string") {
      if (next.escaped) {
        unsupportedSpecifier = true;
      } else {
        specifiers.add(next.value);
      }
      continue;
    }

    if (token.value === "import" && next?.value === "(") {
      const argument = tokens[index + 2];
      const delimiter = tokens[index + 3]?.value;
      if (argument?.type === "string" && !argument.escaped && [")", ","].includes(delimiter)) {
        specifiers.add(argument.value);
      } else {
        unsupportedSpecifier = true;
      }
      continue;
    }

    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor];
      if (candidate.value === ";" || ["import", "export"].includes(candidate.value)) {
        break;
      }
      if (candidate.value === "from" && tokens[cursor + 1]?.type === "string") {
        if (tokens[cursor + 1].escaped) {
          unsupportedSpecifier = true;
        } else {
          specifiers.add(tokens[cursor + 1].value);
        }
        break;
      }
    }
  }

  return { specifiers, unsupportedSpecifier };
}

function referencedWorkspace(specifier, workspaces, importingFile) {
  const packageTarget = workspaces.find(
    (workspace) =>
      specifier === workspace.manifest.name || specifier.startsWith(`${workspace.manifest.name}/`),
  );
  if (packageTarget || !importingFile || !specifier.startsWith(".")) {
    return packageTarget;
  }

  const resolvedImport = new URL(specifier, importingFile).href;
  return workspaces.find(
    (workspace) =>
      resolvedImport === workspace.directory.href.slice(0, -1) ||
      resolvedImport.startsWith(workspace.directory.href),
  );
}

function addEdgeViolation(violations, source, specifier, workspaces, importingFile, edgeKind) {
  const target = referencedWorkspace(specifier, workspaces, importingFile);
  if (!target) {
    return;
  }

  if (edgeKind === "import" && target.manifest.name === source.manifest.name) {
    return;
  }

  if (
    source.kind === "first-layer" &&
    (source.manifest.name === CONTRACTS_PACKAGE || target.manifest.name !== CONTRACTS_PACKAGE)
  ) {
    violations.add(`${source.manifest.name} -> ${specifier}`);
  }

  if (source.kind === "cli" && target.kind !== "first-layer") {
    violations.add(`${source.manifest.name} -> ${specifier}`);
  }
}

export async function checkWorkspaceBoundaries(root) {
  const packageWorkspaces = await readWorkspaceManifests(root, "packages", "first-layer");
  const exampleWorkspaces = await readWorkspaceManifests(root, "examples", "example");
  const workspaces = [...packageWorkspaces, ...exampleWorkspaces];

  for (const workspace of packageWorkspaces) {
    if (workspace.manifest.name === CLI_PACKAGE) {
      workspace.kind = "cli";
    }
  }

  const violations = new Set();

  for (const workspace of workspaces) {
    const dependencies = dependencyEntries(workspace.manifest);

    if (workspace.kind === "first-layer" && containsForbiddenFragment(workspace.manifest.name)) {
      violations.add(`${workspace.manifest.name} -> ${workspace.manifest.name}`);
    }

    for (const dependency of dependencies) {
      if (
        workspace.kind === "first-layer" &&
        [dependency.specifier, dependency.targetSpecifier].some(containsForbiddenFragment)
      ) {
        violations.add(`${workspace.manifest.name} -> ${dependency.targetSpecifier}`);
      }
      addEdgeViolation(
        violations,
        workspace,
        dependency.targetSpecifier,
        workspaces,
        new URL("package.json", workspace.directory),
        "manifest",
      );
    }

    const files = await emittedJavaScriptFiles(new URL("dist/", workspace.directory));
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const imports = analyzeImports(source);

      if (workspace.kind !== "example" && imports.unsupportedSpecifier) {
        violations.add(`${workspace.manifest.name} -> [unsupported import specifier]`);
      }

      for (const specifier of imports.specifiers) {
        if (workspace.kind === "first-layer" && containsForbiddenFragment(specifier)) {
          violations.add(`${workspace.manifest.name} -> ${specifier}`);
        }
        addEdgeViolation(violations, workspace, specifier, workspaces, file, "import");
      }
    }
  }

  return [...violations].sort();
}
