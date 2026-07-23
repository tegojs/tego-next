export interface DirectedGraph<Node> {
  readonly nodes: readonly Node[];
  readonly outgoing: ReadonlyMap<Node, ReadonlySet<Node>>;
}

export function stronglyConnectedComponents<Node>(
  graph: DirectedGraph<Node>,
  compare: (left: Node, right: Node) => number,
): readonly (readonly Node[])[] {
  let nextIndex = 0;
  const indices = new Map<Node, number>();
  const lowLinks = new Map<Node, number>();
  const stack: Node[] = [];
  const onStack = new Set<Node>();
  const components: Node[][] = [];

  const visit = (node: Node): void => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    const adjacent = [...(graph.outgoing.get(node) ?? [])].sort(compare);
    for (const neighbor of adjacent) {
      if (!indices.has(neighbor)) {
        visit(neighbor);
        lowLinks.set(node, Math.min(lowLinks.get(node) ?? 0, lowLinks.get(neighbor) ?? 0));
      } else if (onStack.has(neighbor)) {
        lowLinks.set(node, Math.min(lowLinks.get(node) ?? 0, indices.get(neighbor) ?? 0));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: Node[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort(compare));
  };

  for (const node of [...graph.nodes].sort(compare)) {
    if (!indices.has(node)) visit(node);
  }
  return components.sort((left, right) => compare(left[0] as Node, right[0] as Node));
}

export function topologicalOrder<Node>(
  graph: DirectedGraph<Node>,
  compare: (left: Node, right: Node) => number,
): readonly Node[] | undefined {
  const incoming = new Map(graph.nodes.map((node) => [node, 0]));
  for (const targets of graph.outgoing.values()) {
    for (const target of targets) {
      incoming.set(target, (incoming.get(target) ?? 0) + 1);
    }
  }
  const ready = graph.nodes.filter((node) => incoming.get(node) === 0).sort(compare);
  const order: Node[] = [];
  while (ready.length > 0) {
    const node = ready.shift();
    if (node === undefined) break;
    order.push(node);
    for (const target of [...(graph.outgoing.get(node) ?? [])].sort(compare)) {
      const next = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, next);
      if (next === 0) {
        ready.push(target);
        ready.sort(compare);
      }
    }
  }
  return order.length === graph.nodes.length ? order : undefined;
}
