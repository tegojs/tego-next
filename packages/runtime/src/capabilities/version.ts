/**
 * Supported range subset:
 * - exact and partial stable versions (`1.2.3`, `1.2`, `1`);
 * - exact prerelease versions (`1.2.3-alpha.1`);
 * - `x`, `X`, and `*` wildcards;
 * - `<`, `<=`, `>`, `>=`, and `=` comparators;
 * - `~`, `^`, whitespace intersections, and `||` alternatives.
 *
 * Hyphen ranges and every other syntax are invalid rather than approximately interpreted.
 */
interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

interface RangeVersion {
  readonly any: boolean;
  readonly precision: 0 | 1 | 2 | 3;
  readonly version: Version;
  readonly wildcard: boolean;
}

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function stableVersion(major: number, minor: number, patch: number): Version {
  return { major, minor, patch, prerelease: [] };
}

function parseVersion(value: string): Version | undefined {
  const match = VERSION_PATTERN.exec(value);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (identifier) =>
        identifier.length === 0 ||
        (/^\d+$/u.test(identifier) && !/^(?:0|[1-9]\d*)$/u.test(identifier)),
    )
  ) {
    return undefined;
  }
  return { major, minor, patch, prerelease };
}

function parseRangeVersion(value: string): RangeVersion | undefined {
  if (value === "*" || value.toLowerCase() === "x") {
    return { any: true, precision: 0, version: stableVersion(0, 0, 0), wildcard: true };
  }
  const exact = parseVersion(value);
  if (exact !== undefined) {
    return { any: false, precision: 3, version: exact, wildcard: false };
  }
  const parts = value.split(".");
  if (parts.length < 1 || parts.length > 3) return undefined;
  const numbers: number[] = [];
  let wildcardIndex: number | undefined;
  for (const [index, part] of parts.entries()) {
    if (part === "*" || part.toLowerCase() === "x") {
      if (index === 0) return undefined;
      wildcardIndex ??= index;
      numbers.push(0);
      if (parts.slice(index + 1).some((nested) => nested !== "*" && nested.toLowerCase() !== "x")) {
        return undefined;
      }
      continue;
    }
    if (wildcardIndex !== undefined || !/^(?:0|[1-9]\d*)$/u.test(part)) return undefined;
    const number = Number(part);
    if (!Number.isSafeInteger(number)) return undefined;
    numbers.push(number);
  }
  const precision = (wildcardIndex ?? parts.length) as 1 | 2 | 3;
  return {
    any: false,
    precision,
    version: stableVersion(numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0),
    wildcard: wildcardIndex !== undefined,
  };
}

function compareNumericIdentifier(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+/u, "") || "0";
  const normalizedRight = right.replace(/^0+/u, "") || "0";
  return (
    normalizedLeft.length - normalizedRight.length ||
    (normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0)
  );
}

function compareVersion(left: Version, right: Version): number {
  const core = left.major - right.major || left.minor - right.minor || left.patch - right.patch;
  if (core !== 0) return core;
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function increment(value: number): number | undefined {
  const next = value + 1;
  return Number.isSafeInteger(next) ? next : undefined;
}

function partialUpperBound(target: RangeVersion): Version | undefined {
  if (target.any) return undefined;
  if (target.precision <= 1) {
    const major = increment(target.version.major);
    return major === undefined ? undefined : stableVersion(major, 0, 0);
  }
  const minor = increment(target.version.minor);
  return minor === undefined ? undefined : stableVersion(target.version.major, minor, 0);
}

function caretUpperBound(target: RangeVersion): Version | undefined {
  if (target.any) return undefined;
  if (target.precision === 1 || target.version.major > 0) {
    const major = increment(target.version.major);
    return major === undefined ? undefined : stableVersion(major, 0, 0);
  }
  if (target.precision === 2 || target.version.minor > 0) {
    const minor = increment(target.version.minor);
    return minor === undefined ? undefined : stableVersion(0, minor, 0);
  }
  const patch = increment(target.version.patch);
  return patch === undefined ? undefined : stableVersion(0, 0, patch);
}

function comparatorParts(
  comparator: string,
): { readonly operator: string; readonly target: RangeVersion } | undefined {
  if (comparator.startsWith("^") || comparator.startsWith("~")) {
    const target = parseRangeVersion(comparator.slice(1));
    return target === undefined || target.any || target.wildcard
      ? undefined
      : { operator: comparator[0] as string, target };
  }
  const match = /^(>=|<=|>|<|=)?(.+)$/u.exec(comparator);
  if (match === null) return undefined;
  const target = parseRangeVersion(match[2] ?? "");
  if (target === undefined) return undefined;
  const operator = match[1] ?? "";
  if (operator !== "" && target.wildcard) return undefined;
  return { operator, target };
}

function isSupportedComparator(comparator: string): boolean {
  const parts = comparatorParts(comparator);
  if (parts === undefined) return false;
  if (parts.target.any) return parts.operator === "";
  if (parts.operator === "^") return caretUpperBound(parts.target) !== undefined;
  if (parts.operator === "~") return partialUpperBound(parts.target) !== undefined;
  if (
    (parts.operator === "" || parts.operator === "=") &&
    (parts.target.wildcard || parts.target.precision < 3)
  ) {
    return partialUpperBound(parts.target) !== undefined;
  }
  if ((parts.operator === ">" || parts.operator === "<=") && parts.target.precision < 3) {
    return partialUpperBound(parts.target) !== undefined;
  }
  return true;
}

function satisfiesComparator(version: Version, comparator: string): boolean {
  const parts = comparatorParts(comparator);
  if (parts === undefined) return false;
  const { operator, target } = parts;
  if (target.any) return true;
  if (operator === "^") {
    const maximum = caretUpperBound(target);
    return (
      maximum !== undefined &&
      compareVersion(version, target.version) >= 0 &&
      compareVersion(version, maximum) < 0
    );
  }
  if (operator === "~") {
    const maximum = partialUpperBound(target);
    return (
      maximum !== undefined &&
      compareVersion(version, target.version) >= 0 &&
      compareVersion(version, maximum) < 0
    );
  }
  const order = compareVersion(version, target.version);
  switch (operator) {
    case ">": {
      if (target.precision === 3) return order > 0;
      const maximum = partialUpperBound(target);
      return maximum !== undefined && compareVersion(version, maximum) >= 0;
    }
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    case "<=": {
      if (target.precision === 3) return order <= 0;
      const maximum = partialUpperBound(target);
      return maximum !== undefined && compareVersion(version, maximum) < 0;
    }
    default: {
      if (target.precision === 3 && !target.wildcard) return order === 0;
      const maximum = partialUpperBound(target);
      return maximum !== undefined && order >= 0 && compareVersion(version, maximum) < 0;
    }
  }
}

function comparatorSets(range: string): readonly (readonly string[])[] | undefined {
  const alternatives = range.split("||").map((part) => part.trim());
  if (alternatives.length === 0 || alternatives.some((alternative) => alternative.length === 0)) {
    return undefined;
  }
  const sets = alternatives.map((alternative) => alternative.split(/\s+/u));
  return sets.some((comparators) => comparators.some((value) => !isSupportedComparator(value)))
    ? undefined
    : sets;
}

function optsIntoPrerelease(comparators: readonly string[], version: Version): boolean {
  if (version.prerelease.length === 0) return true;
  return comparators.some((comparator) => {
    const target = comparatorParts(comparator)?.target.version;
    return (
      target !== undefined &&
      target.prerelease.length > 0 &&
      target.major === version.major &&
      target.minor === version.minor &&
      target.patch === version.patch
    );
  });
}

export function isValidVersion(value: string): boolean {
  return parseVersion(value) !== undefined;
}

export function isValidVersionRange(range: string): boolean {
  return comparatorSets(range) !== undefined;
}

export function satisfiesVersionRange(value: string, range: string): boolean {
  const version = parseVersion(value);
  const sets = comparatorSets(range);
  if (version === undefined || sets === undefined) return false;
  return sets.some(
    (comparators) =>
      optsIntoPrerelease(comparators, version) &&
      comparators.every((comparator) => satisfiesComparator(version, comparator)),
  );
}
