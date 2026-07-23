interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

interface RangeVersion {
  readonly precision: 1 | 2 | 3;
  readonly version: Version;
  readonly wildcard: boolean;
}

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

function parseVersion(value: string): Version | undefined {
  const match = VERSION_PATTERN.exec(value);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return { major, minor, patch };
}

function parseRangeVersion(value: string): RangeVersion | undefined {
  const parts = value.split(".");
  if (parts.length < 1 || parts.length > 3) return undefined;
  const numbers: number[] = [];
  let wildcard = false;
  let wildcardIndex: number | undefined;
  for (const [index, part] of parts.entries()) {
    if (part === "*" || part.toLowerCase() === "x") {
      wildcard = true;
      wildcardIndex ??= index;
      numbers.push(0);
      if (parts.slice(index + 1).some((nested) => nested !== "*" && nested.toLowerCase() !== "x")) {
        return undefined;
      }
      continue;
    }
    if (wildcard || !/^(?:0|[1-9]\d*)$/u.test(part)) return undefined;
    const number = Number(part);
    if (!Number.isSafeInteger(number)) return undefined;
    numbers.push(number);
  }
  return {
    precision: (wildcardIndex === undefined ? parts.length : Math.max(1, wildcardIndex)) as
      | 1
      | 2
      | 3,
    version: {
      major: numbers[0] ?? 0,
      minor: numbers[1] ?? 0,
      patch: numbers[2] ?? 0,
    },
    wildcard,
  };
}

function compareVersion(left: Version, right: Version): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function upperBound(target: RangeVersion): Version {
  if (target.precision === 1) {
    return { major: target.version.major + 1, minor: 0, patch: 0 };
  }
  return {
    major: target.version.major,
    minor: target.version.minor + 1,
    patch: 0,
  };
}

function satisfiesComparator(version: Version, comparator: string): boolean {
  if (comparator === "*") return true;
  if (comparator.startsWith("^")) {
    const target = parseRangeVersion(comparator.slice(1));
    if (target === undefined || target.wildcard) return false;
    const minimum = target.version;
    const maximum =
      minimum.major > 0
        ? { major: minimum.major + 1, minor: 0, patch: 0 }
        : minimum.minor > 0
          ? { major: 0, minor: minimum.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: minimum.patch + 1 };
    return compareVersion(version, minimum) >= 0 && compareVersion(version, maximum) < 0;
  }
  if (comparator.startsWith("~")) {
    const target = parseRangeVersion(comparator.slice(1));
    return (
      target !== undefined &&
      !target.wildcard &&
      compareVersion(version, target.version) >= 0 &&
      compareVersion(version, upperBound(target)) < 0
    );
  }
  const match = /^(>=|<=|>|<|=)?(.+)$/u.exec(comparator);
  const target = match === null ? undefined : parseRangeVersion(match[2] ?? "");
  if (match === null || target === undefined) return false;
  const order = compareVersion(version, target.version);
  switch (match[1] ?? "=") {
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    default:
      return target.precision === 3 && !target.wildcard
        ? order === 0
        : order >= 0 && compareVersion(version, upperBound(target)) < 0;
  }
}

function isSupportedComparator(comparator: string): boolean {
  if (comparator === "*") return true;
  if (comparator.startsWith("^") || comparator.startsWith("~")) {
    const target = parseRangeVersion(comparator.slice(1));
    return target !== undefined && !target.wildcard;
  }
  const match = /^(>=|<=|>|<|=)?(.+)$/u.exec(comparator);
  if (match === null) return false;
  const target = parseRangeVersion(match[2] ?? "");
  return target !== undefined && (match[1] === undefined || !target.wildcard);
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
  return sets.some((comparators) =>
    comparators.every((comparator) => satisfiesComparator(version, comparator)),
  );
}
