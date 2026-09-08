import { parentOf, ROOT_PATH, type FileEntry } from '@platform/shared';

/**
 * A node in the rendered tree.
 *
 * Built from the flat, path-sorted list the API returns. The server sends flat
 * because that is what it stores and what a diff is cheap over; the shape a
 * sidebar wants to draw is the client's concern.
 */
export interface TreeNode {
  entry: FileEntry;
  children: TreeNode[];
}

/**
 * Turns flat entries into a tree.
 *
 * Directories sort before files at each level, then by name, which is what
 * every file manager does and what people expect to scan.
 *
 * An entry whose parent is missing is attached to the root rather than
 * dropped. That should not happen, because writes create their ancestors, but
 * silently losing a file from the display would be a much worse failure than
 * showing it in the wrong place.
 */
export function buildTree(entries: readonly FileEntry[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const entry of entries) {
    nodes.set(entry.path, { entry, children: [] });
  }

  const roots: TreeNode[] = [];

  for (const node of nodes.values()) {
    const parent = parentOf(node.entry.path);
    const parentNode = parent === ROOT_PATH ? undefined : nodes.get(parent);

    if (parentNode && parentNode.entry.type === 'DIRECTORY') {
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }

  sortInPlace(roots);
  return roots;
}

function sortInPlace(nodes: TreeNode[]): void {
  nodes.sort(compare);
  for (const node of nodes) sortInPlace(node.children);
}

function compare(a: TreeNode, b: TreeNode): number {
  if (a.entry.type !== b.entry.type) return a.entry.type === 'DIRECTORY' ? -1 : 1;
  return a.entry.name.localeCompare(b.entry.name, undefined, { numeric: true });
}

/**
 * The visible rows, in the order they appear on screen.
 *
 * Keyboard navigation moves between rows as drawn, so up and down have to
 * follow what the eye follows, which means skipping anything inside a
 * collapsed directory.
 */
export function flattenVisible(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
): { node: TreeNode; depth: number }[] {
  const rows: { node: TreeNode; depth: number }[] = [];

  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.entry.type === 'DIRECTORY' && expanded.has(node.entry.path)) {
      rows.push(...flattenVisible(node.children, expanded, depth + 1));
    }
  }

  return rows;
}

/** Every directory on the way to a path, so revealing a file opens its folders. */
export function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  for (let parent = parentOf(path); parent !== ROOT_PATH; parent = parentOf(parent)) {
    ancestors.push(parent);
  }
  return ancestors;
}
