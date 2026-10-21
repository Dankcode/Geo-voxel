export class MinHeap {
    constructor() { this.items = []; }
    get size() { return this.items.length; }
    push(value, priority) {
        const item = { value, priority }, a = this.items;
        let i = a.length; a.push(item);
        while (i) { const parent = (i - 1) >> 1; if (a[parent].priority <= priority) break; a[i] = a[parent]; i = parent; }
        a[i] = item;
    }
    pop() {
        const a = this.items, first = a[0], last = a.pop();
        if (!a.length) return first;
        let i = 0;
        while (i * 2 + 1 < a.length) {
            let child = i * 2 + 1;
            if (child + 1 < a.length && a[child + 1].priority < a[child].priority) child++;
            if (last.priority <= a[child].priority) break;
            a[i] = a[child]; i = child;
        }
        a[i] = last; return first;
    }
}
