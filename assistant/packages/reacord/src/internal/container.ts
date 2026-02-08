export class Container<T extends object> implements Iterable<T> {
	private items: T[] = [];

	*[Symbol.iterator]() {
		yield* this.items;
	}

	add(item: T) {
		this.items.push(item);
	}

	addBefore(item: T, before: T) {
		const index = this.items.indexOf(before);
		if (index === -1) {
			this.items.push(item);
		} else {
			this.items.splice(index, 0, item);
		}
	}

	remove(item: T) {
		const index = this.items.indexOf(item);
		if (index !== -1) {
			this.items.splice(index, 1);
		}
	}

	clear() {
		this.items = [];
	}

	map<U>(fn: (item: T) => U): U[] {
		return this.items.map(fn);
	}

	findType<U extends T>(type: new (...args: never[]) => U): U | undefined {
		return this.items.find((item): item is U => item instanceof type);
	}

	get length() {
		return this.items.length;
	}
}
