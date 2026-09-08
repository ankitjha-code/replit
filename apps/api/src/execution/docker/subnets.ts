/**
 * Choosing an address range for a project's network.
 *
 * ## Why this exists
 *
 * Every project gets a network of its own, which is what stops one project
 * reaching another. Left to itself, Docker gives each new network a large
 * subnet from a small default pool — enough for about thirty networks on a
 * default installation. Found by running the browser suite: after roughly thirty
 * projects had ever started, the daemon refused with "all predefined address
 * pools have been fully subnetted" and **no project could start at all**.
 *
 * So the platform hands out small subnets itself, from a range of its own. A
 * `/16` split into `/28`s is 4,096 project networks, each with room for a
 * dozen containers — a project's environment, its builds, its deployments and
 * a backup running at once.
 *
 * Pure functions, so the arithmetic can be checked without a daemon.
 */

export interface SubnetPool {
  /** The range networks are carved from, as `a.b.c.d/n`. */
  base: string;
  /** The size of each network's subnet, as a prefix length. */
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
  // `>>> 0` keeps it unsigned: bitwise operators work on signed 32-bit numbers.
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

/** How many project networks a pool holds. */
export function capacity(pool: SubnetPool): number {
  const base = parse(pool.base);
  if (pool.prefixLength < base.prefix || pool.prefixLength > 29) {
    throw new Error('A network subnet must fit inside the pool and leave room for containers.');
  }
  return 2 ** (pool.prefixLength - base.prefix);
}

/** The subnet at one position in the pool, as `a.b.c.d/n`. */
export function subnetAt(pool: SubnetPool, index: number): string {
  const base = parse(pool.base);
  const size = 2 ** (32 - pool.prefixLength);
  return `${toAddress((base.start + index * size) >>> 0)}/${String(pool.prefixLength)}`;
}

/**
 * Where to start looking for a free subnet for a project.
 *
 * Derived from the project's identifier, so the same project tends to land in
 * the same place and two projects created at once usually start their search in
 * different places. It is a starting point, not an assignment: the caller walks
 * forward from here past anything already taken.
 */
export function startingIndex(pool: SubnetPool, projectId: string): number {
  let hash = 2_166_136_261;
  for (const character of projectId) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  }
  return hash % capacity(pool);
}

/**
 * The first subnet at or after a starting point that nothing is using.
 *
 * Undefined when the pool is full, which the caller reports as a refusal with
 * the pool named — a full pool is a configuration problem an operator can fix,
 * and it must not look like a transient failure worth retrying.
 */
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
