/* Deterministic child-before-parent playback of the rebuilt hierarchy. */
(function (root) {
  function build(tree) {
    const byId = Object.fromEntries(tree.nodes.map(node => [node.id, node]));
    const chapters = [], steps = [], active = new Set(), visited = new Set();
    function visit(id) {
      if (active.has(id)) throw new Error('Cycle in assembly hierarchy');
      if (visited.has(id)) return;
      const node = byId[id];
      if (!node) throw new Error('Missing assembly node: ' + id);
      active.add(id);
      node.children.forEach(visit);
      if (node.children.length) {
        const chapter = {nodeId: id, depth: node.depth, start: steps.length, count: node.children.length};
        chapters.push(chapter);
        steps.push({chapter: chapters.length - 1, nodeId: id, added: 0, highlight: null});
        node.children.forEach((child, index) => {
          steps.push({chapter: chapters.length - 1, nodeId: id, added: index + 1, highlight: child});
        });
        // Settle to a neutral completed assembly before the next chapter.
        steps.push({chapter: chapters.length - 1, nodeId: id, added: node.children.length, highlight: null});
        chapter.end = steps.length - 1;
      }
      active.delete(id);
      visited.add(id);
    }
    visit(tree.root);
    if (!steps.length) {
      chapters.push({nodeId: tree.root, depth: 0, start: 0, end: 0, count: 0});
      steps.push({chapter: 0, nodeId: tree.root, added: 0, highlight: tree.root});
    }
    return {chapters, steps};
  }
  function masks(tree, step, atomicCount) {
    const byId = tree.byId || Object.fromEntries(tree.nodes.map(node => [node.id, node]));
    const labels = new Int32Array(atomicCount).fill(-1);
    const active = new Uint8Array(atomicCount);
    const node = byId[step.nodeId];
    const children = node.children.length ? node.children.slice(0, step.added) : [node.id];
    children.forEach((id, index) => {
      byId[id].atomics.forEach(atomic => {
        labels[atomic] = index;
        active[atomic] = id === step.highlight ? 2 : 1;
      });
    });
    return [labels, active];
  }
  const api = {build, masks};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AssemblySequence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
