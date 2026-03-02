export function getArg(name: string): string | undefined {
  const eqPrefix = `--${name}=`;
  const flag = `--${name}`;

  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    // --name=value
    if (a.startsWith(eqPrefix)) return a.slice(eqPrefix.length);
    // --name value
    if (a === flag && i + 1 < process.argv.length) {
      const next = process.argv[i + 1]!;
      if (!next.startsWith('--')) return next;
    }
  }
  return undefined;
}

export function getArgOrDefault(name: string, defaultValue: string): string {
  return getArg(name) ?? defaultValue;
}

export function getNumArg(name: string): number | undefined {
  const val = getArg(name);
  return val !== undefined ? parseFloat(val) : undefined;
}

export function getNumArgOrDefault(name: string, defaultValue: number): number {
  const val = getArg(name);
  if (val === undefined) return defaultValue;
  const parsed = parseFloat(val);
  return isNaN(parsed) ? defaultValue : parsed;
}

export function getRequiredArg(name: string): string {
  const val = getArg(name);
  if (val === undefined) {
    throw new Error(`Missing required argument: --${name}`);
  }
  return val;
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
