import { parentOf, ROOT_PATH, type FileEntry } from '@platform/shared';

export interface TreeNode {
  entry: FileEntry;
  children: TreeNode[];
}

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

export function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  for (let parent = parentOf(path); parent !== ROOT_PATH; parent = parentOf(parent)) {
    ancestors.push(parent);
  }
  return ancestors;
}
