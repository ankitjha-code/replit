export interface SubnetPool {
  base: string;
  prefixLength: number;
}

function toNumber(address: string): number {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    throw new Error(`Not an IPv4 address: ${address}`);
  }
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function toAddress(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function parse(cidr: string): { start: number; prefix: number } {
  const [address, prefix] = cidr.split('/');
  const length = Number.parseInt(prefix ?? '', 10);
  if (!address || !Number.isInteger(length) || length < 8 || length > 30) {
    throw new Error(`Not a usable CIDR range: ${cidr}`);
  }
  const mask = length === 0 ? 0 : (0xffffffff << (32 - length)) >>> 0;
  return { start: (toNumber(address) & mask) >>> 0, prefix: length };
}

export function capacity(pool: SubnetPool): number {
  const base = parse(pool.base);
  if (pool.prefixLength < base.prefix || pool.prefixLength > 29) {
    throw new Error('A network subnet must fit inside the pool and leave room for containers.');
  }
  return 2 ** (pool.prefixLength - base.prefix);
}

export function subnetAt(pool: SubnetPool, index: number): string {
  const base = parse(pool.base);
  const size = 2 ** (32 - pool.prefixLength);
  return `${toAddress((base.start + index * size) >>> 0)}/${String(pool.prefixLength)}`;
}

export function startingIndex(pool: SubnetPool, projectId: string): number {
  let hash = 2_166_136_261;
  for (const character of projectId) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  }
  return hash % capacity(pool);
}

export function firstFree(
  pool: SubnetPool,
  from: number,
  taken: ReadonlySet<string>,
): string | undefined {
  const total = capacity(pool);
  for (let step = 0; step < total; step += 1) {
    const candidate = subnetAt(pool, (from + step) % total);
    if (!taken.has(candidate)) return candidate;
  }
  return undefined;
}
