class Node extends Map<Node, number> {
    get(node: Node) {
        return super.get(node) ?? 0;
    }
}

class Graph<T> extends Map<T | Node, [T | undefined, Node]> {
    clear() {
        for (const node of this.keys()) {
            if (node instanceof Node) {
                node.clear();
            }
        }

        super.clear();
    }

    addNode(value: T | Node) {
        const state = this.get(value);
        if (state !== undefined) {
            return state[1];
        }

        if (value instanceof Node) {
            this.set(value, [undefined, value]);      
            return value;      
        }

        const node = new Node();
        this.set(value, [value, node]);
        this.set(node, [value, node]);

        return node;
    }
    
    addEdge(u: T | Node, v: T | Node) {
        u = this.addNode(u);
        v = this.addNode(v);
        u.set(v, u.get(v) | 1);
        v.set(u, v.get(u) | 2);
    }

    deleteNode(value: T | Node) {
        const state = this.get(value);
        if (state === undefined) {
            return undefined;
        }

        const [result, node] = state;
        const from = new Set<Node>();
        const to = new Set<Node>();
        for (const [u, r] of node) {
            if (r & 1) {
                to.add(u);
            }

            if (r & 2) {
                from.add(u);
            }

            node.delete(u);
            u.delete(node);
        }

        this.delete(node);
        result !== undefined && this.delete(result);
        from.delete(node);
        to.delete(node);

        for (const u of from) {
            for (const v of to) {
                if (u !== v) {
                    this.addEdge(u, v);
                }
            }
        }

        return result;
    }

    *descend(node: Node) {
        const queue = new Set([node]);
        for (const u of queue) {
            yield u;

            for (const [v, value] of u) {
                if (value & 1) {
                    queue.add(v);
                }
            }
        }
    }
}

export default Graph;
