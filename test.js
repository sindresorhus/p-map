import process from 'node:process';
import {getEventListeners} from 'node:events';
import test from 'ava';
import delay from 'delay';
import timeSpan from 'time-span';
import randomInt from 'random-int';
import assertInRange from './assert-in-range.js';
import pMap, {pMapIterable, pMapSkip, pMapStop} from './index.js';

const sharedInput = [
	[async () => 10, 300],
	[20, 200],
	Promise.resolve([30, 100]),
];

const longerSharedInput = [
	[10, 300],
	[20, 200],
	[30, 100],
	[40, 50],
	[50, 25],
];

const errorInput1 = [
	[20, 200],
	[30, 100],
	[async () => {
		throw new Error('foo');
	}, 10],
	[() => {
		throw new Error('bar');
	}, 10],
];

const errorInput2 = [
	[20, 200],
	[async () => {
		throw new Error('bar');
	}, 10],
	[30, 100],
	[() => {
		throw new Error('foo');
	}, 10],
];

const errorInput3 = [
	[20, 10],
	[async () => {
		throw new Error('bar');
	}, 100],
	[30, 100],
];

const mapper = async ([value, ms]) => {
	await delay(ms);

	if (typeof value === 'function') {
		value = await value();
	}

	return value;
};

const mapperWithIndex = async ([value, ms], index) => {
	await delay(ms);

	if (typeof value === 'function') {
		value = await value();
	}

	return {value, index};
};

class ThrowingIterator {
	constructor(max, throwOnIndex) {
		this._max = max;
		this._throwOnIndex = throwOnIndex;
		this.index = 0;
		this[Symbol.iterator] = this[Symbol.iterator].bind(this);
	}

	[Symbol.iterator]() {
		let index = 0;
		const max = this._max;
		const throwOnIndex = this._throwOnIndex;
		return {
			next: (() => {
				try {
					if (index === throwOnIndex) {
						throw new Error(`throwing on index ${index}`);
					}

					const item = {value: index, done: index === max};
					return item;
				} finally {
					index++;
					this.index = index;
				}
			// eslint is wrong - bind is needed else the next() call cannot update
			// this.index, which we need to track how many times the iterator was called
			// eslint-disable-next-line no-extra-bind
			}).bind(this),
		};
	}
}

test.serial('main', async t => {
	// The results stay in input order even when the mappers finish in a different order.
	t.deepEqual(await pMap(sharedInput, mapper), [10, 20, 30]);
});

test.serial('concurrency: 1', async t => {
	const end = timeSpan();
	t.deepEqual(await pMap(sharedInput, mapper, {concurrency: 1}), [10, 20, 30]);
	assertInRange(t, end(), {start: 590, end: 760});
});

test('concurrency: 4', async t => {
	const concurrency = 4;
	let running = 0;

	await pMap(Array.from({length: 100}).fill(0), async () => {
		running++;
		t.true(running <= concurrency);
		await delay(randomInt(30, 200));
		running--;
	}, {concurrency});
});

// The timing tests only show that the run took about as long as the limit allows. These show the
// limit is never exceeded, and that it is actually reached.
const concurrencyPeak = async (limit, length = 20) => {
	let running = 0;
	let peak = 0;
	await pMap(Array.from({length}, (_, index) => index), async value => {
		running++;
		peak = Math.max(peak, running);
		await delay(1);
		running--;
		return value;
	}, {concurrency: limit});
	return peak;
};

test('pMap - never runs more mappers at once than the concurrency limit', async t => {
	t.is(await concurrencyPeak(1), 1);
	t.is(await concurrencyPeak(2), 2);
	t.is(await concurrencyPeak(4), 4);
	t.is(await concurrencyPeak(Number.POSITIVE_INFINITY), 20);
});

test('pMapIterable - never runs more mappers at once than the concurrency limit', async t => {
	const iterablePeak = async (limit, length = 20) => {
		let running = 0;
		let peak = 0;
		const values = [];
		for await (const value of pMapIterable(Array.from({length}, (_, index) => index), async item => {
			running++;
			peak = Math.max(peak, running);
			await delay(1);
			running--;
			return item;
		}, {concurrency: limit, backpressure: limit + 1})) {
			values.push(value);
		}

		t.is(values.length, length);
		return peak;
	};

	t.is(await iterablePeak(1), 1);
	t.is(await iterablePeak(2), 2);
	t.is(await iterablePeak(4), 4);
	t.is(await iterablePeak(Number.POSITIVE_INFINITY), 20);
});

test('handles empty iterable', async t => {
	t.deepEqual(await pMap([], mapper), []);
});

test('maps a Set', async t => {
	t.deepEqual(await pMap(new Set([1, 2, 3]), async value => value * 2, {concurrency: 2}), [2, 4, 6]);
});

test('maps a Map, so the mapper gets the entries', async t => {
	const input = new Map([['a', 1], ['b', 2]]);
	t.deepEqual(await pMap(input, async ([key, value]) => `${key}${value}`), ['a1', 'b2']);
});

test('maps a frozen array', async t => {
	t.deepEqual(await pMap(Object.freeze([1, 2, 3]), async value => value + 1), [2, 3, 4]);
});

test('pMapSkip for every element', async t => {
	t.deepEqual(await pMap([1, 2, 3], async () => pMapSkip, {concurrency: 2}), []);
});

test('maps an empty string', async t => {
	t.deepEqual(await pMap('', async value => value), []);
});

test('maps a string, one character at a time', async t => {
	t.deepEqual(await pMap('abc', async value => value.toUpperCase()), ['A', 'B', 'C']);
});

test('continues a generator that was already partly consumed, and closes it', async t => {
	let isClosed = false;
	async function * source() {
		try {
			yield 0;
			yield 1;
			yield 2;
		} finally {
			isClosed = true;
		}
	}

	const generator = source();
	t.deepEqual(await generator.next(), {done: false, value: 0});
	t.deepEqual(await pMap(generator, async value => value * 2), [2, 4]);
	t.true(isClosed);
});

test('closes a generator that was already partly consumed when the mapper throws', async t => {
	let isClosed = false;
	async function * source() {
		try {
			yield 0;
			yield 1;
			yield 2;
		} finally {
			isClosed = true;
		}
	}

	const generator = source();
	await generator.next();
	// `concurrency: 1`, so the generator is not read to its end and only `return()` can close it.
	await t.throwsAsync(pMap(generator, async () => {
		throw new Error('foo');
	}, {concurrency: 1}), {message: 'foo'});
	await delay(10);
	t.true(isClosed);
});

test('keeps undefined results', async t => {
	t.deepEqual(await pMap([1, 2], async value => (value === 1 ? undefined : value)), [undefined, 2]);
});

test('async with concurrency: 2 (random time sequence)', async t => {
	const input = Array.from({length: 10}).map(() => randomInt(0, 100));
	const mapper = value => delay(value, {value});
	const result = await pMap(input, mapper, {concurrency: 2});
	t.deepEqual(result, input);
});

test('async with concurrency: 2 (problematic time sequence)', async t => {
	const input = [100, 200, 10, 36, 13, 45];
	const mapper = value => delay(value, {value});
	const result = await pMap(input, mapper, {concurrency: 2});
	t.deepEqual(result, input);
});

test('async with concurrency: 2 (out of order time sequence)', async t => {
	const input = [200, 100, 50];
	const mapper = value => delay(value, {value});
	const result = await pMap(input, mapper, {concurrency: 2});
	t.deepEqual(result, input);
});

test('enforce number in options.concurrency', async t => {
	await t.throwsAsync(pMap([], () => {}, {concurrency: 0}), {instanceOf: TypeError});
	await t.throwsAsync(pMap([], () => {}, {concurrency: 1.5}), {instanceOf: TypeError});
	await t.notThrowsAsync(pMap([], () => {}, {concurrency: 1}));
	await t.notThrowsAsync(pMap([], () => {}, {concurrency: 10}));
	await t.notThrowsAsync(pMap([], () => {}, {concurrency: Number.POSITIVE_INFINITY}));
});

test('immediately rejects when stopOnError is true', async t => {
	await t.throwsAsync(pMap(errorInput1, mapper, {concurrency: 1}), {message: 'foo'});
	await t.throwsAsync(pMap(errorInput2, mapper, {concurrency: 1}), {message: 'bar'});
});

test('aggregate errors when stopOnError is false', async t => {
	await t.notThrowsAsync(pMap(sharedInput, mapper, {concurrency: 1, stopOnError: false}));
	await t.throwsAsync(pMap(errorInput1, mapper, {concurrency: 1, stopOnError: false}), {instanceOf: AggregateError, message: ''});
	await t.throwsAsync(pMap(errorInput2, mapper, {concurrency: 1, stopOnError: false}), {instanceOf: AggregateError, message: ''});
});

// A source whose `next()` calls settle out of call order, unlike a generator, which queues
// them. `for await` still sees every item in call order, so `pMap` must too.
function outOfOrderSource(items, delays) {
	let callIndex = 0;

	return {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					const index = callIndex++;

					if (index >= items.length) {
						return {done: true};
					}

					await delay(delays[index % delays.length]);
					return {done: false, value: items[index]};
				},
			};
		},
	};
}

test('pMap - a source whose `next()` settles out of order keeps input order', async t => {
	const source = outOfOrderSource(['a', 'b', 'c', 'd'], [50, 0, 0, 0]);
	t.deepEqual(await pMap(source, (value, index) => `${value}${index}`, {concurrency: 4}), ['a0', 'b1', 'c2', 'd3']);
});

test('pMap - a source whose `next()` settles out of order keeps input order with concurrency 2', async t => {
	const source = outOfOrderSource(['a', 'b', 'c', 'd'], [50, 10, 0, 0]);
	t.deepEqual(await pMap(source, (value, index) => `${value}${index}`, {concurrency: 2}), ['a0', 'b1', 'c2', 'd3']);
});

// A source that throws from `next()` is still closed, so it can release whatever it is holding.
// `for await` would not call `return()` here, but the cleanup is harmless and worth having.
test('pMap - closes the source when the source itself throws', async t => {
	let returnCallCount = 0;
	let index = 0;

	const iterable = {
		[Symbol.iterator]() {
			return {
				next() {
					if (index === 1) {
						throw new Error('source boom');
					}

					return {done: false, value: index++};
				},
				return() {
					returnCallCount++;
					return {done: true, value: undefined};
				},
			};
		},
	};

	await t.throwsAsync(pMap(iterable, async value => value, {concurrency: 2}), {message: 'source boom'});
	await delay(10);
	t.is(returnCallCount, 1);
});

test('pMapIterable - closes the source when the source itself throws', async t => {
	let returnCallCount = 0;
	let index = 0;

	const iterable = {
		[Symbol.iterator]() {
			return {
				next() {
					if (index === 1) {
						throw new Error('source boom');
					}

					return {done: false, value: index++};
				},
				return() {
					returnCallCount++;
					return {done: true, value: undefined};
				},
			};
		},
	};

	await t.throwsAsync(collectAsyncIterable(pMapIterable(iterable, async value => value, {concurrency: 2})), {message: 'source boom'});
	await delay(10);
	t.is(returnCallCount, 1);
});

test('pMap - a source that resolves `done` before an earlier item does not drop that item', async t => {
	const source = outOfOrderSource(['a', 'b', 'c'], [50, 0, 0]);
	t.deepEqual(await pMap(source, value => value, {concurrency: 3}), ['a', 'b', 'c']);
});

test('pMap - waits for a pull before `done`', async t => {
	let releaseFirstPull;
	const firstPull = new Promise(resolve => {
		releaseFirstPull = resolve;
	});

	let nextCallCount = 0;
	const source = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					return nextCallCount++ === 0 ? firstPull : Promise.resolve({done: true});
				},
			};
		},
	};

	let settled = false;
	const task = pMap(source, value => value, {concurrency: 2}).then(value => {
		settled = true;
		return value;
	});

	await drainEventLoop();
	t.false(settled);
	releaseFirstPull({done: false, value: 'first'});
	t.deepEqual(await task, ['first']);
});

test('pMap - does not wait for a pull after `done`', async t => {
	let releaseDone;
	const done = new Promise(resolve => {
		releaseDone = resolve;
	});

	let releaseLastPull;
	const lastPull = new Promise(resolve => {
		releaseLastPull = resolve;
	});

	let lastPullStarted;
	const lastPullStartedPromise = new Promise(resolve => {
		lastPullStarted = resolve;
	});

	let nextCallCount = 0;
	const source = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					const index = nextCallCount++;
					if (index === 0) {
						return Promise.resolve({done: false, value: 'first'});
					}

					if (index === 1) {
						return done;
					}

					lastPullStarted();
					return lastPull;
				},
			};
		},
	};

	let result;
	const task = pMap(source, value => value, {concurrency: 2}).then(value => {
		result = value;
	});

	await lastPullStartedPromise;
	releaseDone({done: true});
	await drainEventLoop();
	t.deepEqual(result, ['first']);
	releaseLastPull({done: false, value: 'after done'});
	await task;
});

test('pMap - ignores a rejected pull after `done`', async t => {
	for (const stopOnError of [true, false]) {
		let releaseDone;
		const done = new Promise(resolve => {
			releaseDone = resolve;
		});

		let rejectLastPull;
		const lastPull = new Promise((resolve, reject) => {
			rejectLastPull = reject;
		});

		let lastPullStarted;
		const lastPullStartedPromise = new Promise(resolve => {
			lastPullStarted = resolve;
		});

		let nextCallCount = 0;
		const source = {
			[Symbol.asyncIterator]() {
				return {
					next() {
						const index = nextCallCount++;
						if (index === 0) {
							return Promise.resolve({done: false, value: 'first'});
						}

						if (index === 1) {
							return done;
						}

						lastPullStarted();
						return lastPull;
					},
				};
			},
		};

		const task = pMap(source, value => value, {concurrency: 2, stopOnError});
		// eslint-disable-next-line no-await-in-loop
		await lastPullStartedPromise;
		releaseDone({done: true});
		rejectLastPull(new Error('after done'));
		// eslint-disable-next-line no-await-in-loop
		t.deepEqual(await task, ['first']);
	}
});

test('pMap - propagates a rejected pull before `done`', async t => {
	let rejectFirstPull;
	const firstPull = new Promise((resolve, reject) => {
		rejectFirstPull = reject;
	});

	let nextCallCount = 0;
	const source = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					return nextCallCount++ === 0 ? firstPull : Promise.resolve({done: true});
				},
			};
		},
	};

	const task = pMap(source, value => value, {concurrency: 2});
	await drainEventLoop();
	rejectFirstPull(new Error('before done'));
	await t.throwsAsync(task, {message: 'before done'});
});

test('pMap - ignores a mapper rejection after `done`', async t => {
	let releaseDone;
	const done = new Promise(resolve => {
		releaseDone = resolve;
	});

	let rejectLaterMapper;
	const laterMapper = new Promise((resolve, reject) => {
		rejectLaterMapper = reject;
	});

	let laterMapperStarted;
	const laterMapperStartedPromise = new Promise(resolve => {
		laterMapperStarted = resolve;
	});

	let nextCallCount = 0;
	const source = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					const index = nextCallCount++;
					if (index === 0) {
						return Promise.resolve({done: false, value: 0});
					}

					if (index === 1) {
						return done;
					}

					return Promise.resolve(index === 2 ? {done: false, value: 2} : {done: true});
				},
			};
		},
	};

	let result;
	const task = pMap(source, value => {
		if (value === 2) {
			laterMapperStarted();
			return laterMapper;
		}

		return value;
	}, {concurrency: 2}).then(value => {
		result = value;
	});

	await laterMapperStartedPromise;
	releaseDone({done: true});
	await drainEventLoop();
	t.deepEqual(result, [0]);
	rejectLaterMapper(new Error('after done'));
	await task;
});

test('pMap - excludes an error after `done` from an aggregate', async t => {
	let releaseDone;
	const done = new Promise(resolve => {
		releaseDone = resolve;
	});

	let laterMapperStarted;
	const laterMapperStartedPromise = new Promise(resolve => {
		laterMapperStarted = resolve;
	});

	let nextCallCount = 0;
	const source = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					const index = nextCallCount++;
					if (index === 0) {
						return Promise.resolve({done: false, value: 0});
					}

					if (index === 1) {
						return done;
					}

					return Promise.resolve(index === 2 ? {done: false, value: 2} : {done: true});
				},
			};
		},
	};

	const task = pMap(source, value => {
		if (value === 2) {
			laterMapperStarted();
			throw new Error('after done');
		}

		return value;
	}, {concurrency: 2, stopOnError: false});

	await laterMapperStartedPromise;
	await drainEventLoop();
	releaseDone({done: true});
	t.deepEqual(await task, [0]);
});

// A source that reports `done` and then keeps producing is broken, but `pMap` and `pMapIterable`
// still have to treat the `done` as the end of the input, like `for await` does. The first element
// arrives late, so its mapper finishes before the `done` is observed and the pull after it is
// already in flight.
function doneThenMoreSource() {
	let callIndex = 0;

	return {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					const index = callIndex++;

					if (index === 1) {
						return {done: true};
					}

					await delay(index === 0 ? 20 : 0);
					return {done: false, value: `v${index}`};
				},
			};
		},
	};
}

test('pMap - a source that reports `done` and then keeps producing stops at the `done`', async t => {
	const result = await pMap(doneThenMoreSource(), (value, index) => `${value}@${index}`, {concurrency: 3});
	t.deepEqual(result, ['v0@0']);
	// A hole would make these two disagree. A hole turns into `null` under `JSON.stringify` and
	// `undefined` under `Array.from`, which is a nasty thing to pass on to a caller.
	t.is(result.length, Object.keys(result).length);
});

test('pMap and pMapIterable agree on a source that reports `done` and then keeps producing', async t => {
	const collected = [];
	for await (const value of pMapIterable(doneThenMoreSource(), (value, index) => `${value}@${index}`, {concurrency: 3})) {
		collected.push(value);
	}

	t.deepEqual(await pMap(doneThenMoreSource(), (value, index) => `${value}@${index}`, {concurrency: 3}), collected);
	t.deepEqual(await collectAsyncIterable(pMapIterable(doneThenMoreSource(), (value, index) => `${value}@${index}`, {concurrency: 3, preserveOrder: false})), collected);
});

// A `pMapSkip` in front of a `done` that lands between two elements goes through the same trim as
// either one on its own, so the two together are worth pinning: the skipped element is dropped, and
// so is everything the source produced past the `done`, leaving a dense array.
test('pMap - a `pMapSkip` in front of a `done` that lands between two elements', async t => {
	let callIndex = 0;
	const source = {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					const index = callIndex++;

					// The `done` at index 2 lands late, so the pull after it produces `v3` first.
					if (index === 2) {
						await delay(10);
						return {done: true};
					}

					if (index > 3) {
						return {done: true};
					}

					await delay(index === 0 ? 20 : 0);
					return {done: false, value: `v${index}`};
				},
			};
		},
	};

	const result = await pMap(source, value => (value === 'v1' ? pMapSkip : value), {concurrency: 3});

	// `v0` survives the `done` at index 2, `v1` is skipped, and `v3` is past the `done`.
	t.deepEqual(result, ['v0']);
	t.is(result.length, Object.keys(result).length);
});

// With nothing bounding the read-ahead, an endless source and a mapper that never waits on anything
// produce faster than the event loop can turn, and the consumer stops receiving values entirely. A
// finite `backpressure` is what keeps a source that never ends flowing.
test('pMapIterable - a finite `backpressure` keeps an endless source flowing', async t => {
	const pulls = [];
	const source = {
		[Symbol.iterator]() {
			return {
				next() {
					pulls.push(pulls.length);
					return {done: false, value: pulls.length - 1};
				},
			};
		},
	};

	const received = [];
	for await (const value of pMapIterable(source, async value => value, {concurrency: 2, backpressure: 4})) {
		received.push(value);

		// A real consumer awaits something per element, and that is what has to keep working.
		await delay(1);

		if (received.length === 20) {
			break;
		}
	}

	t.deepEqual(received, Array.from({length: 20}, (_, index) => index));
	// The read-ahead never grows past the window `backpressure` allows.
	t.is(pulls.length, received.length + 4);
});

// The errors are staged by index in a sparse array, so a mapper that throws `undefined` must not be
// mistaken for an index that never got an error.
test('stopOnError: false keeps a mapper error that is `undefined`', async t => {
	// Thrown through a variable so the intent is not a bare `throw undefined`.
	const thrown = undefined;
	const error = await t.throwsAsync(pMap([1, 2, 3], async value => {
		await delay(value === 1 ? 20 : 1);
		if (value === 1) {
			throw thrown;
		}

		return value;
	}, {concurrency: 3, stopOnError: false}), {instanceOf: AggregateError});

	t.is(error.errors.length, 1);
	t.is(error.errors[0], thrown);
});

test('stopOnError: false keeps a mapper error that is `null`', async t => {
	const thrown = null;
	const error = await t.throwsAsync(pMap([1], async () => {
		throw thrown;
	}, {stopOnError: false}), {instanceOf: AggregateError});

	t.is(error.errors.length, 1);
	t.is(error.errors[0], thrown);
});

// The order the mappers happen to finish in is not stable from run to run, so the errors are
// reported in input order instead. Otherwise `error.errors[0]` is a different error on every run.
test('stopOnError: false reports the errors in input order', async t => {
	const input = [0, 1, 2, 3, 4];
	// Finish in the exact reverse of input order.
	const delays = [40, 30, 20, 10, 0];
	const orders = new Set();

	for (let run = 0; run < 3; run++) {
		// eslint-disable-next-line no-await-in-loop
		const error = await t.throwsAsync(pMap(input, async value => {
			await delay(delays[value]);
			throw new Error(`boom ${value}`);
		}, {concurrency: 5, stopOnError: false}), {instanceOf: AggregateError});

		orders.add(error.errors.map(error => error.message).join(','));
	}

	t.deepEqual([...orders], ['boom 0,boom 1,boom 2,boom 3,boom 4']);
});

test('pMapSkip', async t => {
	t.deepEqual(await pMap([
		1,
		pMapSkip,
		2,
	], async value => value), [1, 2]);
});

test('multiple pMapSkips', async t => {
	t.deepEqual(await pMap([
		1,
		pMapSkip,
		2,
		pMapSkip,
		3,
		pMapSkip,
		pMapSkip,
		4,
	], async value => value), [1, 2, 3, 4]);
});

test('all pMapSkips', async t => {
	t.deepEqual(await pMap([
		pMapSkip,
		pMapSkip,
		pMapSkip,
		pMapSkip,
	], async value => value), []);
});

test('all mappers should run when concurrency is infinite, even after stop-on-error happened', async t => {
	const input = [1, async () => delay(300, {value: 2}), 3];
	const mappedValues = [];
	await t.throwsAsync(
		pMap(input, async value => {
			value = typeof value === 'function' ? await value() : value;
			mappedValues.push(value);
			if (value === 1) {
				await delay(100);
				throw new Error('Oops!');
			}
		}),
	);
	await delay(500);
	t.deepEqual(mappedValues, [1, 3, 2]);
});

// Resolve once every microtask and I/O callback queued so far has run. Used instead of a delay
// to reach a point where everything that could have started has started.
const drainEventLoop = () => new Promise(resolve => {
	setImmediate(resolve);
});

class AsyncTestData {
	constructor(data) {
		this.data = data;
	}

	async * [Symbol.asyncIterator]() {
		for (let index = 0; index < this.data.length; index++) {
			// Add a delay between each iterated item
			// eslint-disable-next-line no-await-in-loop
			await delay(10);
			yield this.data[index];
		}
	}
}

//
// Async Iterator tests
//

test.serial('asyncIterator - main', async t => {
	const end = timeSpan();
	t.deepEqual(await pMap(new AsyncTestData(sharedInput), mapper), [10, 20, 30]);

	// We give it some leeway on both sides of the expected 300ms as the exact value depends on the machine and workload.
	assertInRange(t, end(), {start: 290, end: 430});
});

test.serial('asyncIterator - concurrency: 1', async t => {
	const end = timeSpan();
	t.deepEqual(await pMap(new AsyncTestData(sharedInput), mapper, {concurrency: 1}), [10, 20, 30]);
	assertInRange(t, end(), {start: 590, end: 760});
});

test('asyncIterator - concurrency: 4', async t => {
	const concurrency = 4;
	let running = 0;

	await pMap(new AsyncTestData(Array.from({length: 100}).fill(0)), async () => {
		running++;
		t.true(running <= concurrency);
		await delay(randomInt(30, 200));
		running--;
	}, {concurrency});
});

test('asyncIterator - handles empty iterable', async t => {
	t.deepEqual(await pMap(new AsyncTestData([]), mapper), []);
});

test('asyncIterator - async with concurrency: 2 (random time sequence)', async t => {
	const input = Array.from({length: 10}).map(() => randomInt(0, 100));
	const mapper = value => delay(value, {value});
	const result = await pMap(new AsyncTestData(input), mapper, {concurrency: 2});
	t.deepEqual(result, input);
});

test('asyncIterator - async with concurrency: 2 (problematic time sequence)', async t => {
	const input = [100, 200, 10, 36, 13, 45];
	const mapper = value => delay(value, {value});
	const result = await pMap(new AsyncTestData(input), mapper, {concurrency: 2});
	t.deepEqual(result, input);
});

test('asyncIterator - async with concurrency: 2 (out of order time sequence)', async t => {
	const input = [200, 100, 50];
	const mapper = value => delay(value, {value});
	const result = await pMap(new AsyncTestData(input), mapper, {concurrency: 2});
	t.deepEqual(result, input);
});

test('asyncIterator - enforce number in options.concurrency', async t => {
	await t.throwsAsync(pMap(new AsyncTestData([]), () => {}, {concurrency: 0}), {instanceOf: TypeError});
	await t.throwsAsync(pMap(new AsyncTestData([]), () => {}, {concurrency: 1.5}), {instanceOf: TypeError});
	await t.notThrowsAsync(pMap(new AsyncTestData([]), () => {}, {concurrency: 1}));
	await t.notThrowsAsync(pMap(new AsyncTestData([]), () => {}, {concurrency: 10}));
	await t.notThrowsAsync(pMap(new AsyncTestData([]), () => {}, {concurrency: Number.POSITIVE_INFINITY}));
});

test('asyncIterator - immediately rejects when stopOnError is true', async t => {
	await t.throwsAsync(pMap(new AsyncTestData(errorInput1), mapper, {concurrency: 1}), {message: 'foo'});
	await t.throwsAsync(pMap(new AsyncTestData(errorInput2), mapper, {concurrency: 1}), {message: 'bar'});
});

test('asyncIterator - aggregate errors when stopOnError is false', async t => {
	await t.notThrowsAsync(pMap(new AsyncTestData(sharedInput), mapper, {concurrency: 1, stopOnError: false}));
	await t.throwsAsync(pMap(new AsyncTestData(errorInput1), mapper, {concurrency: 1, stopOnError: false}), {instanceOf: AggregateError, message: ''});
	await t.throwsAsync(pMap(new AsyncTestData(errorInput2), mapper, {concurrency: 1, stopOnError: false}), {instanceOf: AggregateError, message: ''});
});

test('asyncIterator - pMapSkip', async t => {
	t.deepEqual(await pMap(new AsyncTestData([
		1,
		pMapSkip,
		2,
	]), async value => value), [1, 2]);
});

test('asyncIterator - multiple pMapSkips', async t => {
	t.deepEqual(await pMap(new AsyncTestData([
		1,
		pMapSkip,
		2,
		pMapSkip,
		3,
		pMapSkip,
		pMapSkip,
		4,
	]), async value => value), [1, 2, 3, 4]);
});

test('asyncIterator - all pMapSkips', async t => {
	t.deepEqual(await pMap(new AsyncTestData([
		pMapSkip,
		pMapSkip,
		pMapSkip,
		pMapSkip,
	]), async value => value), []);
});

test('asyncIterator - already-started mappers continue after stop-on-error', async t => {
	const input = [1, 2, 3];
	const startedValues = [];
	const finishedValues = [];
	let allMapped;
	const allMappedPromise = new Promise(resolve => {
		allMapped = resolve;
	});
	let releaseRemaining;
	const remainingCanFinish = new Promise(resolve => {
		releaseRemaining = resolve;
	});
	let remainingFinished;
	const remainingFinishedPromise = new Promise(resolve => {
		remainingFinished = resolve;
	});

	const rejection = t.throwsAsync(
		pMap(new AsyncTestData(input), async value => {
			startedValues.push(value);
			if (startedValues.length === input.length) {
				allMapped();
			}

			if (value === 1) {
				await allMappedPromise;
				throw new Error('Oops! 1');
			}

			await remainingCanFinish;
			finishedValues.push(value);
			if (finishedValues.length === input.length - 1) {
				remainingFinished();
			}
		}),
		{message: 'Oops! 1'},
	);

	await allMappedPromise;
	await rejection;
	// Release the already-started mappers after the first rejection to verify they continue.
	releaseRemaining();
	await remainingFinishedPromise;
	t.deepEqual(startedValues, input);
	t.deepEqual(finishedValues, [2, 3]);
});

test('catches exception from source iterator - 1st item', async t => {
	const input = new ThrowingIterator(100, 0);
	const mappedValues = [];
	const error = await t.throwsAsync(pMap(
		input,
		async value => {
			mappedValues.push(value);
			await delay(100);
			return value;
		},
		{concurrency: 1, stopOnError: true},
	));
	t.is(error.message, 'throwing on index 0');
	t.is(input.index, 1);
	await delay(300);
	t.deepEqual(mappedValues, []);
});

// The 2nd iterable item throwing is distinct from the 1st when concurrency is 1 because
// it means that the source next() is invoked from next() and not from
// the constructor
test('catches exception from source iterator - 2nd item', async t => {
	const input = new ThrowingIterator(100, 1);
	const mappedValues = [];
	await t.throwsAsync(pMap(
		input,
		async value => {
			mappedValues.push(value);
			await delay(100);
			return value;
		},
		{concurrency: 1, stopOnError: true},
	));
	await delay(300);
	t.is(input.index, 2);
	t.deepEqual(mappedValues, [0]);
});

// The 2nd iterable item throwing after a 1st item mapper exception, with stopOnError false,
// is distinct from other cases because our next() is called from a catch block
test('catches exception from source iterator - 2nd item after 1st item mapper throw', async t => {
	const input = new ThrowingIterator(100, 1);
	const mappedValues = [];
	const error = await t.throwsAsync(pMap(
		input,
		async value => {
			mappedValues.push(value);
			await delay(100);
			throw new Error('mapper threw error');
		},
		{concurrency: 1, stopOnError: false},
	));
	await delay(300);
	t.is(error.message, 'throwing on index 1');
	t.is(input.index, 2);
	t.deepEqual(mappedValues, [0]);
});

// The iterator throwing after a mapper resolved, with stopOnError false, is distinct because
// our next() is called from the mapper success path and must not double-decrement the in-flight count
test('catches exception from source iterator - after a mapper resolved with stopOnError: false', async t => {
	const input = new ThrowingIterator(6, 3);
	const mappedValues = [];
	const error = await t.throwsAsync(pMap(
		input,
		async value => {
			mappedValues.push(value);
			await delay(50);
			return value;
		},
		{concurrency: 2, stopOnError: false},
	));
	t.is(error.message, 'throwing on index 3');
	t.is(input.index, 4);
	await delay(200);
	t.is(input.index, 4);
	t.deepEqual(mappedValues, [0, 1, 2]);
});

test('asyncIterator - catches exception from source iterator with stopOnError: false', async t => {
	let didThrow = false;

	async function * source() {
		yield 0;
		yield 1;
		yield 2;
		didThrow = true;
		throw new Error('source failed');
	}

	const mappedValues = [];
	const error = await t.throwsAsync(pMap(
		source(),
		async value => {
			mappedValues.push(value);
			await delay(50);
			return value;
		},
		{concurrency: 2, stopOnError: false},
	));
	t.is(error.message, 'source failed');
	t.true(didThrow);
	await delay(200);
	t.deepEqual(mappedValues, [0, 1, 2]);
});

test('aggregates rejected input elements when stopOnError is false', async t => {
	const input = [
		Promise.reject(new Error('input 0')),
		1,
		Promise.reject(new Error('input 2')),
		3,
	];
	const mappedValues = [];
	const error = await t.throwsAsync(pMap(input, async value => {
		mappedValues.push(value);
		await delay(10);
		return value;
	}, {concurrency: 2, stopOnError: false}), {instanceOf: AggregateError});
	t.deepEqual(error.errors.map(error => error.message), ['input 0', 'input 2']);
	t.deepEqual(mappedValues, [1, 3]);
});

test('asyncIterator - first mapper error wins after stop-on-error', async t => {
	const input = [1, 2, 3];
	const startedValues = [];
	const failedValues = [];
	let allMapped;
	const allMappedPromise = new Promise(resolve => {
		allMapped = resolve;
	});
	let releaseLaterErrors;
	const laterErrorsCanThrow = new Promise(resolve => {
		releaseLaterErrors = resolve;
	});
	let laterErrorsThrown;
	const laterErrorsThrownPromise = new Promise(resolve => {
		laterErrorsThrown = resolve;
	});

	// Handle the rejection right away, otherwise it is reported as unhandled while the test waits for every mapper to start.
	const rejection = t.throwsAsync(pMap(new AsyncTestData(input), async value => {
		startedValues.push(value);
		if (startedValues.length === input.length) {
			allMapped();
		}

		await (value === 1 ? allMappedPromise : laterErrorsCanThrow);

		failedValues.push(value);
		if (failedValues.length === input.length) {
			laterErrorsThrown();
		}

		// Every mapper throws, but only the first error is reported to the consumer.
		throw new Error(`Oops! ${value}`);
	}), {message: 'Oops! 1'});

	await allMappedPromise;
	await rejection;
	releaseLaterErrors();
	await laterErrorsThrownPromise;
	t.deepEqual(startedValues, input);
	t.deepEqual(failedValues, input);
});

test('incorrect input type', async t => {
	let mapperCalled = false;

	// Handle the rejection right away, otherwise it is reported as unhandled while the test waits.
	const task = pMap(123_456, async () => {
		mapperCalled = true;
		await delay(100);
	}).then(value => ({value}), error => ({error}));

	const {error} = await task;
	t.is(error.message, 'Expected `input` to be either an `Iterable` or `AsyncIterable`, got (number)');
	t.false(mapperCalled);
});

// A nullish input is the most likely mistake, so it has to reach the same message as any other
// wrong input rather than Node's internal "null is not iterable".
test('incorrect input type: nullish', async t => {
	await t.throwsAsync(pMap(null, async () => {}), {message: 'Expected `input` to be either an `Iterable` or `AsyncIterable`, got (object)'});
	await t.throwsAsync(pMap(undefined, async () => {}), {message: 'Expected `input` to be either an `Iterable` or `AsyncIterable`, got (undefined)'});
});

test('pMapIterable - incorrect input type: nullish', t => {
	t.throws(() => pMapIterable(null, async () => {}), {message: 'Expected `input` to be either an `Iterable` or `AsyncIterable`, got (object)'});
	t.throws(() => pMapIterable(undefined, async () => {}), {message: 'Expected `input` to be either an `Iterable` or `AsyncIterable`, got (undefined)'});
});

test('prefers the async iterator when the input has both, like `for await`', async t => {
	const input = {
		[Symbol.iterator]() {
			throw new Error('sync iteration is not supported');
		},
		async * [Symbol.asyncIterator]() {
			yield 1;
			yield 2;
		},
	};

	t.deepEqual(await pMap(input, value => value * 10), [10, 20]);
	t.deepEqual(await collectAsyncIterable(pMapIterable(input, value => value * 10)), [10, 20]);
});

test('no unhandled rejected promises from mapper throws - infinite concurrency', async t => {
	const input = [1, 2, 3];
	const mappedValues = [];
	await t.throwsAsync(
		pMap(input, async value => {
			mappedValues.push(value);
			await delay(100);
			throw new Error(`Oops! ${value}`);
		}),
		{message: 'Oops! 1'},
	);
	// Note: All 3 mappers get invoked, all 3 throw, even with `{stopOnError: true}` this
	// should raise an AggregateError with all 3 exceptions instead of throwing 1
	// exception and hiding the other 2.
	t.deepEqual(mappedValues, [1, 2, 3]);
});

test('no unhandled rejected promises from mapper throws - concurrency 1', async t => {
	const input = [1, 2, 3];
	const mappedValues = [];
	await t.throwsAsync(
		pMap(input, async value => {
			mappedValues.push(value);
			await delay(100);
			throw new Error(`Oops! ${value}`);
		},
		{concurrency: 1}),
		{message: 'Oops! 1'},
	);
	t.deepEqual(mappedValues, [1]);
});

test('invalid mapper', async t => {
	await t.throwsAsync(pMap([], 'invalid mapper', {concurrency: 2}), {instanceOf: TypeError});
});

test('pMapIterable - invalid mapper', t => {
	t.throws(() => pMapIterable([], 'invalid mapper', {concurrency: 2}), {instanceOf: TypeError});
});

// Asserting that the listener count drops back to zero is only meaningful if it was ever above
// zero, so these check the count from inside a mapper while the run is in flight as well.
const abortListenerCount = signal => getEventListeners(signal, 'abort').length;

test('installs the abort listener while the run is in flight and removes it when it resolves', async t => {
	const abortController = new AbortController();
	const {signal} = abortController;
	let countWhileRunning;

	t.deepEqual(await pMap([1, 2], async value => {
		countWhileRunning = abortListenerCount(signal);
		await delay(10);
		return value;
	}, {signal}), [1, 2]);

	t.is(countWhileRunning, 1);
	t.is(abortListenerCount(signal), 0);

	// Aborting a settled run cannot reach the listener that was just removed.
	abortController.abort();
	t.is(abortListenerCount(signal), 0);
});

test('installs the abort listener while the run is in flight and removes it when it rejects', async t => {
	const abortController = new AbortController();
	const {signal} = abortController;
	let countWhileRunning;

	await t.throwsAsync(pMap([1], async () => {
		countWhileRunning = abortListenerCount(signal);
		await delay(10);
		throw new Error('foo');
	}, {signal}), {message: 'foo'});

	t.is(countWhileRunning, 1);
	t.is(abortListenerCount(signal), 0);
});

test('rejects with the abort reason', async t => {
	const abortController = new AbortController();
	abortController.abort(new Error('custom reason'));
	await t.throwsAsync(pMap([1], async value => value, {signal: abortController.signal}), {message: 'custom reason'});
});

// The iterator was created before the signal was looked at, so a run that never starts still
// hands the source its one `return()`.
test('an already aborted signal still closes the source', async t => {
	let returnCallCount = 0;
	const source = {
		[Symbol.iterator]() {
			return {
				next: () => ({done: false, value: 1}),
				return() {
					returnCallCount++;
					return {done: true, value: undefined};
				},
			};
		},
	};

	const abortController = new AbortController();
	abortController.abort();

	await t.throwsAsync(pMap(source, async value => value, {signal: abortController.signal}), {name: 'AbortError'});
	t.is(returnCallCount, 1);
});

// Closing the source is deliberately not awaited, so a `return()` that never settles cannot hold
// the abort back.
test('an abort does not wait for a source that is blocked in `next()`', async t => {
	async function * source() {
		yield 0;
		await new Promise(() => {}); // Never settles
	}

	const abortController = new AbortController();
	setTimeout(() => {
		abortController.abort();
	}, 10);

	await t.throwsAsync(pMap(source(), async value => value, {concurrency: 2, signal: abortController.signal}), {name: 'AbortError'});
});

// An element that is still arriving when the abort lands must not reach the mapper.
test('no mapper runs for an input element that arrives after the abort', async t => {
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	let releaseFirst;
	let firstMapped;
	const firstMappedPromise = new Promise(resolve => {
		firstMapped = resolve;
		releaseFirst = resolve;
	});

	const abortController = new AbortController();
	const mappedValues = [];

	// The first element reaches the mapper before the abort, the other two only resolve after it.
	const input = [0, gate.then(() => 1), gate.then(() => 2)];

	const task = pMap(input, async value => {
		mappedValues.push(value);

		if (value === 0) {
			firstMapped();
			await firstMappedPromise;
		}

		return value;
	}, {concurrency: 3, signal: abortController.signal}).then(value => ({value}), error => ({error}));

	await firstMappedPromise;
	abortController.abort();
	releaseFirst();
	release();

	const {error} = await task;
	t.is(error.name, 'AbortError');

	await delay(50);

	t.deepEqual(mappedValues, [0]);
});

test('an abort wins over the collected errors when stopOnError is false', async t => {
	const abortController = new AbortController();
	setTimeout(() => {
		abortController.abort();
	}, 10);

	// The first error is collected before the abort, and the rest only after it.
	await t.throwsAsync(pMap([1, 2, 3], async value => {
		await delay(value === 1 ? 0 : 100);
		throw new Error(`Oops! ${value}`);
	}, {concurrency: 3, stopOnError: false, signal: abortController.signal}), {name: 'AbortError'});
});

test('abort by AbortController', async t => {
	const abortController = new AbortController();

	setTimeout(() => {
		abortController.abort();
	}, 100);

	const mapper = async value => value;

	await t.throwsAsync(pMap([delay(1000), new AsyncTestData(100), 100], mapper, {signal: abortController.signal}), {
		name: 'AbortError',
	});
});

test('already aborted signal', async t => {
	const abortController = new AbortController();

	abortController.abort();

	const mapper = async value => value;

	await t.throwsAsync(pMap([delay(1000), new AsyncTestData(100), 100], mapper, {signal: abortController.signal}), {
		name: 'AbortError',
	});
	t.is(abortListenerCount(abortController.signal), 0);
});

async function collectAsyncIterable(asyncIterable) {
	const values = [];

	for await (const value of asyncIterable) {
		values.push(value);
	}

	return values;
}

test('pMapIterable', async t => {
	t.deepEqual(await collectAsyncIterable(pMapIterable(sharedInput, mapper)), [10, 20, 30]);
});

test('pMapIterable - index in mapper', async t => {
	t.deepEqual(await collectAsyncIterable(pMapIterable(sharedInput, mapperWithIndex)), [
		{value: 10, index: 0},
		{value: 20, index: 1},
		{value: 30, index: 2},
	]);
	t.deepEqual(await collectAsyncIterable(pMapIterable(longerSharedInput, mapperWithIndex)), [
		{value: 10, index: 0},
		{value: 20, index: 1},
		{value: 30, index: 2},
		{value: 40, index: 3},
		{value: 50, index: 4},
	]);
});

test('pMapIterable - index in mapper (out-of-order-settling promises)', async t => {
	const input = [
		delay(50, {value: 'a'}),
		delay(10, {value: 'b'}),
		delay(30, {value: 'c'}),
	];

	const result = [];
	for await (const item of pMapIterable(input, async (value, index) => [value, index], {concurrency: 3})) {
		result.push(item);
	}

	t.deepEqual(result, [['a', 0], ['b', 1], ['c', 2]]);
});

// `pMapIterable` validates the same `concurrency` as `pMap`, plus `backpressure`, which has to
// be at least `concurrency`. Neither had a test, so a validation that silently stopped throwing
// would have gone unnoticed.
test('pMapIterable - enforce the options', t => {
	t.throws(() => pMapIterable([], () => {}, {concurrency: 0}), {instanceOf: TypeError});
	t.throws(() => pMapIterable([], () => {}, {concurrency: 1.5}), {instanceOf: TypeError});
	t.throws(() => pMapIterable([], () => {}, {concurrency: '2'}), {instanceOf: TypeError});
	t.notThrows(() => pMapIterable([], () => {}, {concurrency: 1}));
	t.notThrows(() => pMapIterable([], () => {}, {concurrency: Number.POSITIVE_INFINITY}));

	t.throws(() => pMapIterable([], () => {}, {concurrency: 2, backpressure: 1}), {
		instanceOf: TypeError,
		message: 'Expected `backpressure` to be an integer from `concurrency` (2) and up or `Infinity`, got `1` (number)',
	});
	t.throws(() => pMapIterable([], () => {}, {concurrency: 2, backpressure: 2.5}), {instanceOf: TypeError});
	t.throws(() => pMapIterable([], () => {}, {concurrency: 2, backpressure: null}), {instanceOf: TypeError});

	// `concurrency` defaults to `Infinity`, so a finite `backpressure` on its own is not enough.
	t.throws(() => pMapIterable([], () => {}, {backpressure: 2}), {instanceOf: TypeError, message: /Infinity/});

	t.notThrows(() => pMapIterable([], () => {}, {concurrency: 2, backpressure: 2}));
	t.notThrows(() => pMapIterable([], () => {}, {concurrency: 2, backpressure: 10}));
	t.notThrows(() => pMapIterable([], () => {}, {concurrency: Number.POSITIVE_INFINITY, backpressure: Number.POSITIVE_INFINITY}));
});

test('pMapIterable - empty', async t => {
	t.deepEqual(await collectAsyncIterable(pMapIterable([], mapper)), []);
});

test('pMapIterable - iterable that throws', async t => {
	let isFirstNextCall = true;

	const iterable = {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					if (!isFirstNextCall) {
						return {done: true};
					}

					isFirstNextCall = false;
					throw new Error('foo');
				},
			};
		},
	};

	const iterator = pMapIterable(iterable, mapper)[Symbol.asyncIterator]();

	await t.throwsAsync(iterator.next(), {message: 'foo'});
});

test('pMapIterable - iterable that rejects with undefined', async t => {
	const iterable = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					return Promise.reject();
				},
			};
		},
	};

	const iterator = pMapIterable(iterable, mapper)[Symbol.asyncIterator]();
	let didReject = false;
	let rejectionReason;

	try {
		await iterator.next();
	} catch (error) {
		didReject = true;
		rejectionReason = error;
	}

	t.true(didReject);
	t.is(rejectionReason, undefined);
});

test.serial('pMapIterable - no unhandled rejection when an in-flight `next()` rejects after an error', async t => {
	let nextCallCount = 0;

	const iterable = {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					nextCallCount++;

					if (nextCallCount === 1) {
						return {done: false, value: 1};
					}

					await delay(50);
					throw new Error('next() failed');
				},
			};
		},
	};

	const unhandledRejections = [];
	const onUnhandledRejection = error => {
		unhandledRejections.push(error);
	};

	process.on('unhandledRejection', onUnhandledRejection);

	try {
		await t.throwsAsync(collectAsyncIterable(pMapIterable(iterable, async () => {
			throw new Error('foo');
		}, {concurrency: 2})), {message: 'foo'});

		// Give the abandoned in-flight `next()` time to reject.
		await delay(200);
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	t.deepEqual(unhandledRejections, []);
});

// The same for `pMap`: the puller hands the caller a promise it also watches itself, so an
// abandoned pull cannot turn into an unhandled rejection once the run has already failed.
test.serial('pMap - no unhandled rejection when an in-flight `next()` rejects after an error', async t => {
	let nextCallCount = 0;

	const iterable = {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					nextCallCount++;

					if (nextCallCount === 1) {
						return {done: false, value: 1};
					}

					await delay(50);
					throw new Error('next() failed');
				},
			};
		},
	};

	const unhandledRejections = [];
	const onUnhandledRejection = error => {
		unhandledRejections.push(error);
	};

	process.on('unhandledRejection', onUnhandledRejection);

	try {
		await t.throwsAsync(pMap(iterable, async () => {
			throw new Error('foo');
		}, {concurrency: 2}), {message: 'foo'});

		// Give the abandoned in-flight `next()` time to reject.
		await delay(200);
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	t.deepEqual(unhandledRejections, []);
});

test('pMapIterable - mapper that throws', async t => {
	await t.throwsAsync(collectAsyncIterable(pMapIterable(sharedInput, async () => {
		throw new Error('foo');
	})), {message: 'foo'});
});

test('pMapIterable - stop on error', async t => {
	const output = [];

	try {
		for await (const value of pMapIterable(errorInput3, mapper)) {
			output.push(value);
		}
	} catch (error) {
		t.is(error.message, 'bar');
	}

	t.deepEqual(output, [20]);
});

test.serial('pMapIterable - concurrency: 1', async t => {
	const end = timeSpan();
	t.deepEqual(await collectAsyncIterable(pMapIterable(sharedInput, mapper, {concurrency: 1, backpressure: Number.POSITIVE_INFINITY})), [10, 20, 30]);

	// It could've only taken this much time if each were run in series
	assertInRange(t, end(), {start: 590, end: 760});
});

test.serial('pMapIterable - concurrency: 2', async t => {
	const times = new Map();
	const end = timeSpan();

	t.deepEqual(await collectAsyncIterable(pMapIterable(longerSharedInput, value => {
		times.set(value[0], end());
		return mapper(value);
	}, {concurrency: 2, backpressure: Number.POSITIVE_INFINITY})), [10, 20, 30, 40, 50]);

	assertInRange(t, times.get(10), {start: 0, end: 50});
	assertInRange(t, times.get(20), {start: 0, end: 50});
	// A timer can fire a little before its delay as measured here, so the lower bounds have some slack.
	assertInRange(t, times.get(30), {start: 195, end: 250});
	assertInRange(t, times.get(40), {start: 295, end: 350});
	assertInRange(t, times.get(50), {start: 295, end: 350});
});

test('pMapIterable - backpressure', async t => {
	const started = [];
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	// The mappers wait on a gate this test opens, so "everything that could have started has
	// started" is a point the test reaches by draining the event loop rather than by guessing at
	// a duration. A mapper that ignored `backpressure` would have started all five by then.
	const asyncIterator = pMapIterable(longerSharedInput, async value => {
		started.push(value[0]);
		await gate;
		return value[0];
	}, {backpressure: 2, concurrency: 2})[Symbol.asyncIterator]();

	const first = asyncIterator.next();
	await drainEventLoop();

	// Two in flight, which is also everything `backpressure` allows, so nothing is read further.
	t.deepEqual(started, [10, 20]);

	release();

	const {value: firstValue} = await first;
	t.is(firstValue, 10);
	await drainEventLoop();

	// Taking that result freed exactly one slot, so the source is read one element further.
	t.deepEqual(started, [10, 20, 30]);

	const {value: secondValue} = await asyncIterator.next();
	t.is(secondValue, 20);
	await asyncIterator.return();
});

test('pMapIterable - async input, backpressure > concurrency', async t => {
	async function * source() {
		yield 1;
		yield 2;
		yield 3;
	}

	const log = [];
	await collectAsyncIterable(pMapIterable(source(), async n => {
		log.push(n);
		await delay(100);
		log.push(n);
	}, {concurrency: 1, backpressure: 2}));

	t.deepEqual(log, [1, 1, 2, 2, 3, 3]);
});

test('pMapIterable - a skipped result holds its backpressure slot until the consumer passes it', async t => {
	let pulledCount = 0;

	async function * source() {
		for (let index = 0; index < 1000; index++) {
			pulledCount++;
			yield index;
		}
	}

	// The first element is slow and everything behind it skips, so the skipped results are
	// resolved results the consumer has not collected yet. Each one has to hold a backpressure
	// slot, otherwise dropping them frees a slot and the whole source is read.
	const iterator = pMapIterable(source(), async value => {
		if (value === 0) {
			await delay(50);
			return value;
		}

		return pMapSkip;
	}, {concurrency: 4, backpressure: 4})[Symbol.asyncIterator]();

	const {value: first} = await iterator.next();
	t.is(first, 0);

	// A handful of elements: `backpressure`, plus what freeing the first result's slot allows.
	// The point is that it is nowhere near the whole source.
	t.true(pulledCount <= 6, `pulled ${pulledCount} elements, expected at most 6`);

	await iterator.return();
});

test('pMapIterable - a source whose `next()` settles out of order keeps input order', async t => {
	const source = outOfOrderSource(['a', 'b', 'c', 'd'], [50, 5, 40, 5]);
	t.deepEqual(await collectAsyncIterable(pMapIterable(source, (value, index) => `${value}${index}`, {concurrency: 4})), ['a0', 'b1', 'c2', 'd3']);
});

// Each mapper waits on a gate of its own, so the test decides the order the mappers settle in rather than guessing at durations.
function gatedMapper() {
	const releases = new Map();

	return {
		mapper: value => new Promise(resolve => {
			releases.set(value, () => {
				resolve(value);
			});
		}),
		release(value) {
			releases.get(value)();
		},
	};
}

test('pMapIterable - `preserveOrder: false` yields the results in the order they settle', async t => {
	const {mapper, release} = gatedMapper();

	// The `index` is still the position in the input, whatever order the results come out in.
	const iterator = pMapIterable(['a', 'b', 'c'], async (value, index) => `${await mapper(value)}${index}`, {concurrency: 3, preserveOrder: false})[Symbol.asyncIterator]();
	const first = iterator.next();
	await drainEventLoop();

	release('c');
	t.deepEqual(await first, {done: false, value: 'c2'});

	release('a');
	t.deepEqual(await iterator.next(), {done: false, value: 'a0'});

	release('b');
	t.deepEqual(await iterator.next(), {done: false, value: 'b1'});

	t.deepEqual(await iterator.next(), {done: true, value: undefined});
});

test('pMapIterable - `preserveOrder: false` keeps mapping while an earlier element is pending', async t => {
	const {mapper, release} = gatedMapper();

	// The first element holds, and with `preserveOrder` the results behind it would fill up `backpressure` and stop the mapping until it settles.
	const iterator = pMapIterable([0, 1, 2, 3, 4], value => value === 0 ? mapper(value) : value, {concurrency: 2, preserveOrder: false})[Symbol.asyncIterator]();

	t.deepEqual(await iterator.next(), {done: false, value: 1});
	t.deepEqual(await iterator.next(), {done: false, value: 2});
	t.deepEqual(await iterator.next(), {done: false, value: 3});
	t.deepEqual(await iterator.next(), {done: false, value: 4});

	release(0);
	t.deepEqual(await iterator.next(), {done: false, value: 0});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
});

test('pMapIterable - `preserveOrder: false` throws a mapper error while an earlier element is pending', async t => {
	const {mapper} = gatedMapper();

	const iterator = pMapIterable([0, 1], value => {
		if (value === 1) {
			throw new Error('foo');
		}

		return mapper(value);
	}, {concurrency: 2, preserveOrder: false})[Symbol.asyncIterator]();

	await t.throwsAsync(iterator.next(), {message: 'foo'});
});

test('pMapIterable - `preserveOrder: false` still applies `backpressure`', async t => {
	const {mapper, release} = gatedMapper();
	const started = [];

	const iterator = pMapIterable([0, 1, 2, 3, 4], value => {
		started.push(value);
		return mapper(value);
	}, {concurrency: 2, backpressure: 2, preserveOrder: false})[Symbol.asyncIterator]();

	const first = iterator.next();
	await drainEventLoop();
	t.deepEqual(started, [0, 1]);

	release(1);
	t.deepEqual(await first, {done: false, value: 1});
	await drainEventLoop();

	// Taking that result freed exactly one slot, so the source is read one element further.
	t.deepEqual(started, [0, 1, 2]);

	await iterator.return();
});

test('pMapIterable - `preserveOrder: false` yields every result when the source ends while mappers are running', async t => {
	const {mapper, release} = gatedMapper();
	const source = exhaustibleSource(2);

	// With a spare worker, the pull that reports `done` settles while both mappers are still held, so the `done` is the first result in line and must not end the iteration.
	const iterator = pMapIterable(source, mapper, {concurrency: 3, preserveOrder: false})[Symbol.asyncIterator]();
	const first = iterator.next();
	await drainEventLoop();

	release(1);
	t.deepEqual(await first, {done: false, value: 1});

	release(0);
	t.deepEqual(await iterator.next(), {done: false, value: 0});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
	t.is(source.nextCallsAfterDone, 0);
});

test('pMapIterable - does not wait for a pull made after the source reported `done`', async t => {
	for (const preserveOrder of [true, false]) {
		let pullCount = 0;
		let reportDone;

		// Like a queue, the source blocks in `next()` once it has reported `done`.
		const source = {
			[Symbol.asyncIterator]() {
				return {
					next() {
						const pull = pullCount++;

						if (pull === 0) {
							return Promise.resolve({done: false, value: 0});
						}

						if (pull === 1) {
							return new Promise(resolve => {
								reportDone = () => {
									resolve({done: true, value: undefined});
								};
							});
						}

						return new Promise(() => {});
					},
				};
			},
		};

		const iterator = pMapIterable(source, async value => value, {concurrency: 2, preserveOrder})[Symbol.asyncIterator]();
		t.deepEqual(await iterator.next(), {done: false, value: 0}); // eslint-disable-line no-await-in-loop
		await drainEventLoop(); // eslint-disable-line no-await-in-loop

		// The first mapper finished while the pull that reports `done` was pending, so a third pull went out, and the source never answers it.
		t.is(pullCount, 3);

		reportDone();
		t.deepEqual(await iterator.next(), {done: true, value: undefined}); // eslint-disable-line no-await-in-loop
	}
});

test('pMapIterable - `preserveOrder: false` yields the item of a pull that settles after a later pull reported `done`', async t => {
	let pullCount = 0;
	const pullResolvers = [];

	// The source settles its `next()` calls out of call order, like `outOfOrderSource`.
	const source = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					if (pullCount++ === 0) {
						return Promise.resolve({done: false, value: 0});
					}

					return new Promise(resolve => {
						pullResolvers.push(resolve);
					});
				},
			};
		},
	};

	const iterator = pMapIterable(source, async value => value, {concurrency: 2, preserveOrder: false})[Symbol.asyncIterator]();
	t.deepEqual(await iterator.next(), {done: false, value: 0});
	await drainEventLoop();
	t.is(pullResolvers.length, 2);

	const [resolveSecondPull, resolveThirdPull] = pullResolvers;
	resolveThirdPull({done: true, value: undefined});
	await drainEventLoop();
	resolveSecondPull({done: false, value: 1});

	t.deepEqual(await iterator.next(), {done: false, value: 1});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
});

test('pMapIterable - `preserveOrder: false` with pMapSkip', async t => {
	const {mapper, release} = gatedMapper();

	const iterator = pMapIterable([1, 2, 3, 4], async value => {
		await mapper(value);
		return value % 2 === 0 ? value : pMapSkip;
	}, {concurrency: 4, preserveOrder: false})[Symbol.asyncIterator]();

	const first = iterator.next();
	await drainEventLoop();

	release(3);
	release(4);
	t.deepEqual(await first, {done: false, value: 4});

	release(1);
	release(2);
	t.deepEqual(await iterator.next(), {done: false, value: 2});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
});

test('pMapIterable - `preserveOrder: false` stops pulling and closes the source when the consumer breaks', async t => {
	let pulledCount = 0;
	let isSourceClosed = false;

	async function * source() {
		try {
			for (let index = 0; index < 100; index++) {
				pulledCount++;
				yield index;
			}
		} finally {
			isSourceClosed = true;
		}
	}

	for await (const value of pMapIterable(source(), async value => value, {concurrency: 2, preserveOrder: false})) { // eslint-disable-line no-unreachable-loop
		t.is(value, 0);
		break;
	}

	const pulledCountAtBreak = pulledCount;
	await drainEventLoop();

	t.true(isSourceClosed);
	t.is(pulledCount, pulledCountAtBreak);
});

test('pMapIterable - `preserveOrder` defaults to `true`', async t => {
	for (const options of [{concurrency: 3}, {concurrency: 3, preserveOrder: true}]) {
		const {mapper, release} = gatedMapper();
		const iterator = pMapIterable([0, 1, 2], mapper, options)[Symbol.asyncIterator]();
		const first = iterator.next();
		await drainEventLoop(); // eslint-disable-line no-await-in-loop

		// The later elements settle first, and still come out after the first one.
		release(2);
		release(1);
		await drainEventLoop(); // eslint-disable-line no-await-in-loop
		release(0);

		t.deepEqual(await first, {done: false, value: 0}); // eslint-disable-line no-await-in-loop
		t.deepEqual(await iterator.next(), {done: false, value: 1}); // eslint-disable-line no-await-in-loop
		t.deepEqual(await iterator.next(), {done: false, value: 2}); // eslint-disable-line no-await-in-loop
	}
});

test('pMapIterable - `preserveOrder: false` yields an input element that is a promise when it resolves', async t => {
	let resolveFirst;
	const firstElement = new Promise(resolve => {
		resolveFirst = resolve;
	});

	const iterator = pMapIterable([firstElement, 'b'], async value => value, {concurrency: 2, preserveOrder: false})[Symbol.asyncIterator]();

	t.deepEqual(await iterator.next(), {done: false, value: 'b'});

	resolveFirst('a');
	t.deepEqual(await iterator.next(), {done: false, value: 'a'});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
});

test('pMapIterable - `preserveOrder: false` with an async source', async t => {
	const {mapper, release} = gatedMapper();

	async function * source() {
		yield 'a';
		yield 'b';
		yield 'c';
	}

	const iterator = pMapIterable(source(), mapper, {concurrency: 3, preserveOrder: false})[Symbol.asyncIterator]();
	const first = iterator.next();
	await drainEventLoop();

	release('b');
	t.deepEqual(await first, {done: false, value: 'b'});

	release('c');
	t.deepEqual(await iterator.next(), {done: false, value: 'c'});

	release('a');
	t.deepEqual(await iterator.next(), {done: false, value: 'a'});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
});

test('pMapIterable - `preserveOrder: false` passes the input position as `index` for a source whose `next()` settles out of order', async t => {
	const source = outOfOrderSource(['a', 'b', 'c', 'd'], [50, 5, 40, 5]);
	const result = await collectAsyncIterable(pMapIterable(source, (value, index) => `${value}${index}`, {concurrency: 4, preserveOrder: false}));
	t.deepEqual(result.sort(), ['a0', 'b1', 'c2', 'd3']);
});

test('pMapIterable - `preserveOrder: false` never runs more mappers at once than the concurrency limit', async t => {
	const measurePeak = async limit => {
		let running = 0;
		let peak = 0;

		const result = await collectAsyncIterable(pMapIterable(Array.from({length: 20}, (_, index) => index), async value => {
			running++;
			peak = Math.max(peak, running);
			await delay(randomInt(0, 5));
			running--;
			return value;
		}, {concurrency: limit, preserveOrder: false}));

		t.deepEqual(result.sort((a, b) => a - b), Array.from({length: 20}, (_, index) => index));
		return peak;
	};

	t.is(await measurePeak(1), 1);
	t.is(await measurePeak(2), 2);
	t.is(await measurePeak(4), 4);
});

test('pMapIterable - `preserveOrder: false` with `concurrency: 1` keeps the input order', async t => {
	const result = await collectAsyncIterable(pMapIterable([30, 0, 20, 10], async value => {
		await delay(value);
		return value;
	}, {concurrency: 1, preserveOrder: false}));

	t.deepEqual(result, [30, 0, 20, 10]);
});

test('pMapIterable - `preserveOrder: false` yields a completed result before a synchronous source error', async t => {
	function * source() {
		yield 0;
		throw new Error('source failed');
	}

	const iterator = pMapIterable(source(), value => value, {concurrency: 1, backpressure: 2, preserveOrder: false})[Symbol.asyncIterator]();

	t.deepEqual(await iterator.next(), {done: false, value: 0});
	await t.throwsAsync(iterator.next(), {message: 'source failed'});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
});

test('pMapIterable - `preserveOrder: false` throws a source error while an earlier element is pending', async t => {
	const {mapper} = gatedMapper();

	async function * source() {
		yield 0;
		throw new Error('source failed');
	}

	const iterator = pMapIterable(source(), mapper, {concurrency: 2, preserveOrder: false})[Symbol.asyncIterator]();
	await t.throwsAsync(iterator.next(), {message: 'source failed'});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
});

test('pMapIterable - `preserveOrder: false` yields the results that settled before a mapper throws', async t => {
	const {mapper, release} = gatedMapper();

	const iterator = pMapIterable([0, 1, 2], async value => {
		await mapper(value);

		if (value === 2) {
			throw new Error('foo');
		}

		return value;
	}, {concurrency: 3, preserveOrder: false})[Symbol.asyncIterator]();

	const first = iterator.next();
	await drainEventLoop();

	release(1);
	t.deepEqual(await first, {done: false, value: 1});

	release(2);
	await t.throwsAsync(iterator.next(), {message: 'foo'});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
});

test('pMapIterable - `preserveOrder: false` does not call the mapper for input that arrives after a mapper throws', async t => {
	const {mapper, release} = gatedMapper();
	let sourcePulls = 0;

	const source = {
		[Symbol.iterator]() {
			return {
				next() {
					return {done: false, value: sourcePulls++};
				},
			};
		},
	};

	const mapped = [];
	const iterator = pMapIterable(source, value => {
		mapped.push(value);

		if (value === 1) {
			throw new Error('foo');
		}

		return mapper(value);
	}, {concurrency: 2, preserveOrder: false})[Symbol.asyncIterator]();

	await t.throwsAsync(iterator.next(), {message: 'foo'});
	const sourcePullsAfterError = sourcePulls;

	// Freeing the held worker must not start another pull or mapper.
	release(0);
	await drainEventLoop();

	t.deepEqual(mapped, [0, 1]);
	t.is(sourcePulls, sourcePullsAfterError);
});

test.serial('pMapIterable - `preserveOrder: false` has no unhandled rejection when several mappers throw', async t => {
	const unhandledRejections = [];
	const onUnhandledRejection = error => {
		unhandledRejections.push(error);
	};

	process.on('unhandledRejection', onUnhandledRejection);

	try {
		await t.throwsAsync(collectAsyncIterable(pMapIterable([0, 1, 2], async value => {
			await delay(value);
			throw new Error(`foo${value}`);
		}, {concurrency: 3, preserveOrder: false})), {message: 'foo0'});

		// Give the other mappers time to reject.
		await delay(50);
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	t.deepEqual(unhandledRejections, []);
});

test('pMapIterable - `preserveOrder: false` stops at once when `return()` is called while an earlier element is pending', async t => {
	const {mapper, release} = gatedMapper();
	let sourcePulls = 0;
	let isSourceClosed = false;

	const source = {
		[Symbol.iterator]() {
			return {
				next() {
					return {done: false, value: sourcePulls++};
				},
				return() {
					isSourceClosed = true;
					return {done: true};
				},
			};
		},
	};

	const mapped = [];
	const iterator = pMapIterable(source, value => {
		mapped.push(value);
		return value === 0 ? mapper(value) : value;
	}, {concurrency: 2, preserveOrder: false})[Symbol.asyncIterator]();

	t.deepEqual(await iterator.next(), {done: false, value: 1});

	// The first element is still held, and stopping must not wait for it.
	t.deepEqual(await iterator.return(), {done: true, value: undefined});
	t.true(isSourceClosed);

	const mappedAfterReturn = mapped.length;
	const sourcePullsAfterReturn = sourcePulls;
	release(0);
	await drainEventLoop();

	t.is(mapped.length, mappedAfterReturn);
	t.is(sourcePulls, sourcePullsAfterReturn);
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
});

test('pMapIterable - `preserveOrder: false` reads as far ahead as with `preserveOrder`', async t => {
	const startedCount = async preserveOrder => {
		let started = 0;
		const iterator = pMapIterable(Array.from({length: 20}, (_, index) => index), async value => {
			started++;
			return value;
		}, {concurrency: 1, backpressure: 3, preserveOrder})[Symbol.asyncIterator]();

		await iterator.next();
		await drainEventLoop();
		await iterator.return();
		return started;
	};

	const ordered = await startedCount(true);
	const unordered = await startedCount(false);

	// One result taken, plus `backpressure` results waiting for the consumer.
	t.is(ordered, 4);
	t.is(unordered, ordered);
});

test('pMapIterable - `preserveOrder: false` with an empty input or only skipped results', async t => {
	t.deepEqual(await collectAsyncIterable(pMapIterable([], async value => value, {preserveOrder: false})), []);
	t.deepEqual(await collectAsyncIterable(pMapIterable([1, 2, 3], async () => pMapSkip, {concurrency: 2, preserveOrder: false})), []);
});

test('pMapIterable - `preserveOrder: false` yields falsy results', async t => {
	const values = [undefined, null, 0, false, ''];
	const result = await collectAsyncIterable(pMapIterable(values.keys(), async index => values[index], {concurrency: 2, preserveOrder: false}));
	t.is(result.length, values.length);

	for (const value of values) {
		t.true(result.includes(value));
	}
});

test('pMapIterable - `preserveOrder: false` yields every result exactly once under random timing', async t => {
	const length = 300;
	const input = Array.from({length}, (_, index) => index);

	const result = await collectAsyncIterable(pMapIterable(input, async value => {
		await delay(randomInt(0, 5));
		return value % 7 === 0 ? pMapSkip : value;
	}, {concurrency: 8, backpressure: 16, preserveOrder: false}));

	t.deepEqual(result.sort((a, b) => a - b), input.filter(value => value % 7 !== 0));
});

test('pMapIterable - `preserveOrder: false` gives each iteration its own state', async t => {
	const input = Array.from({length: 20}, (_, index) => index);
	const iterable = pMapIterable(input, async value => {
		await delay(randomInt(0, 5));
		return value;
	}, {concurrency: 4, preserveOrder: false});

	const [first, second] = await Promise.all([collectAsyncIterable(iterable), collectAsyncIterable(iterable)]);
	t.deepEqual(first.sort((a, b) => a - b), input);
	t.deepEqual(second.sort((a, b) => a - b), input);
});

test('pMapIterable - `preserveOrder: false` stages can be chained', async t => {
	const input = Array.from({length: 20}, (_, index) => index);

	const doubled = pMapIterable(input, async value => {
		await delay(randomInt(0, 5));
		return value * 2;
	}, {concurrency: 4, preserveOrder: false});

	const result = await collectAsyncIterable(pMapIterable(doubled, async value => {
		await delay(randomInt(0, 5));
		return value + 1;
	}, {concurrency: 4, preserveOrder: false}));

	t.deepEqual(result.sort((a, b) => a - b), input.map(value => (value * 2) + 1));
});

test('pMapIterable - the iterator it hands out can be consumed with `for await`', async t => {
	const iterator = pMapIterable([1, 2, 3], async value => value * 2, {concurrency: 2})[Symbol.asyncIterator]();
	const values = [];
	for await (const value of iterator) {
		values.push(value);
	}

	t.deepEqual(values, [2, 4, 6]);
});

// Composing two `pMapIterable` stages, which is how a pipeline is built. The second stage has to
// see the first stage's output in order, whatever concurrency each runs at.
test('pMapIterable - two chained stages keep the input order', async t => {
	const first = pMapIterable([0, 1, 2, 3, 4], async value => {
		await delay(value % 3);
		return value * 2;
	}, {concurrency: 3, backpressure: 4});

	const streamed = [];
	for await (const value of pMapIterable(first, async item => {
		await delay(item % 4);
		return item + 1;
	}, {concurrency: 2, backpressure: 3})) {
		streamed.push(value);
	}

	t.deepEqual(streamed, [1, 3, 5, 7, 9]);
});

test('pMapIterable - two consumers of the same result over a re-iterable source', async t => {
	const mapped = pMapIterable([1, 2, 3], async value => value * 2);

	const collect = async () => {
		const values = [];
		for await (const value of mapped) {
			values.push(value);
		}

		return values;
	};

	t.deepEqual(await Promise.all([collect(), collect()]), [[2, 4, 6], [2, 4, 6]]);
});

test('pMap - a long input does not build up a deep call stack', async t => {
	const input = Array.from({length: 20_000}, (_, index) => index);
	const result = await pMap(input, async value => value, {concurrency: 1});
	t.is(result.length, 20_000);
	t.is(result.at(-1), 19_999);
});

test('pMap - an input element that resolves to `pMapSkip` is still passed to the mapper', async t => {
	let mapperSawSkip = false;
	const result = await pMap([Promise.resolve(pMapSkip)], async value => {
		mapperSawSkip = value === pMapSkip;
		return 'kept';
	});
	t.true(mapperSawSkip);
	t.deepEqual(result, ['kept']);
});

test('pMapIterable - pMapSkip', async t => {
	t.deepEqual(await collectAsyncIterable(pMapIterable([
		1,
		pMapSkip,
		2,
	], async value => value)), [1, 2]);
});

// `return()` has to take effect as soon as it is called. The generator is suspended on the
// `next()` the consumer never awaited, so its `finally` does not run until that settles, and
// without this the whole source is pulled and mapped in the meantime.
test('pMapIterable - stops pulling input when `return()` is called while a `next()` is pending', async t => {
	let mapperCalls = 0;
	let sourcePulls = 0;
	let index = 0;

	// An endless source and no backpressure limit, so a stop that is missed keeps pulling and
	// mapping instead of running into a limit.
	const source = {
		[Symbol.iterator]() {
			return {
				next() {
					sourcePulls++;
					return {done: false, value: index++};
				},
			};
		},
	};

	const iterator = pMapIterable(source, async value => {
		mapperCalls++;
		// The first element is slow, so the generator is still waiting on it.
		await delay(value === 0 ? 60 : 0);
		return value;
	}, {concurrency: 2, backpressure: Number.POSITIVE_INFINITY})[Symbol.asyncIterator]();

	const pending = iterator.next();
	await delay(1);

	// Started but not awaited: the point is what happens while the generator is still suspended on
	// the pending `next()`, which is the window the stop has to cover.
	const returned = iterator.return();
	await delay(30);
	const mapperCallsAfterReturn = mapperCalls;
	const sourcePullsAfterReturn = sourcePulls;

	await returned;
	pending.catch(() => {});
	await delay(120);

	// Work was in flight, and nothing more is started or pulled.
	t.true(mapperCallsAfterReturn > 0);
	t.is(mapperCalls, mapperCallsAfterReturn);
	t.is(sourcePulls, sourcePullsAfterReturn);
});

// The same window again, this time for cleanup: a short-circuited pull must not make the generator
// think the source ran out, or the source is never closed.
// Same as the `return()` case, but the consumer signals the stop with `throw()`.
test('pMapIterable - stops pulling input when `throw()` is called while a `next()` is pending', async t => {
	let mapperCalls = 0;
	let sourcePulls = 0;
	let index = 0;

	// An endless source and no backpressure limit, so a stop that is missed keeps pulling and
	// mapping instead of running into a limit.
	const source = {
		[Symbol.iterator]() {
			return {
				next() {
					sourcePulls++;
					return {done: false, value: index++};
				},
			};
		},
	};

	const iterator = pMapIterable(source, async value => {
		mapperCalls++;
		// The first element is slow, so the generator is suspended on it when `throw()` lands.
		await delay(value === 0 ? 60 : 0);
		return value;
	}, {concurrency: 2, backpressure: Number.POSITIVE_INFINITY})[Symbol.asyncIterator]();

	const pending = iterator.next();
	await delay(1);

	// Started but not awaited: the point is what happens while the generator is still suspended on
	// the pending `next()`, which is the window the stop has to cover.
	const thrown = iterator.throw(new Error('injected'));
	await delay(30);
	const mapperCallsAfterThrow = mapperCalls;
	const sourcePullsAfterThrow = sourcePulls;

	await t.throwsAsync(thrown, {message: 'injected'});
	pending.catch(() => {});
	await delay(120);

	// Work was in flight, and nothing more is started or pulled.
	t.true(mapperCallsAfterThrow > 0);
	t.is(mapperCalls, mapperCallsAfterThrow);
	t.is(sourcePulls, sourcePullsAfterThrow);
});

test('pMapIterable - closes the source when `return()` is called while a `next()` is pending', async t => {
	let returnCallCount = 0;
	let index = 0;

	const iterable = {
		[Symbol.iterator]() {
			return {
				next: () => (index < 10 ? {done: false, value: index++} : {done: true}),
				return() {
					returnCallCount++;
					return {done: true, value: undefined};
				},
			};
		},
	};

	const iterator = pMapIterable(iterable, async value => {
		// The first element is slow, so the generator is suspended on it when `return()` lands.
		await delay(value === 0 ? 60 : 0);
		return value;
	}, {concurrency: 2, backpressure: 4})[Symbol.asyncIterator]();

	const pending = iterator.next();
	await delay(1);
	await iterator.return();
	pending.catch(() => {});
	await delay(20);

	t.is(returnCallCount, 1);
});

test('pMapIterable - stops pulling input after `return()` is called', async t => {
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	let mapperCalls = 0;

	const iterator = pMapIterable(Array.from({length: 100}, (_, index) => index), async value => {
		mapperCalls++;

		if (value > 0) {
			await gate;
			return pMapSkip;
		}

		return value;
	}, {concurrency: 2, backpressure: 2})[Symbol.asyncIterator]();

	t.deepEqual(await iterator.next(), {value: 0, done: false});
	t.deepEqual(await iterator.return(), {value: undefined, done: true});

	// Some elements were already in flight when the consumer stopped. How many is a matter of how
	// far the pipeline read ahead, so only the growth after the stop is asserted.
	t.true(mapperCalls > 1);
	const mapperCallsAfterReturn = mapperCalls;

	release();
	await delay(50);

	t.is(mapperCalls, mapperCallsAfterReturn);
	t.deepEqual(await iterator.next(), {value: undefined, done: true});
});

test('pMapIterable - stops pulling input after the consumer throws', async t => {
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	let mapperCalls = 0;

	async function * source() {
		for (let index = 0; index < 100; index++) {
			yield index;
		}
	}

	const iterable = pMapIterable(source(), async value => {
		mapperCalls++;

		if (value > 0) {
			await gate;
			return pMapSkip;
		}

		return value;
	}, {concurrency: 2, backpressure: 2});

	await t.throwsAsync(async () => {
		for await (const value of iterable) { // eslint-disable-line no-unreachable-loop
			throw new Error(`consumer error ${value}`);
		}
	}, {message: 'consumer error 0'});

	// Some elements were already in flight when the consumer stopped. How many is a matter of how
	// far the pipeline read ahead, so only the growth after the throw is asserted.
	t.true(mapperCalls > 1);
	const mapperCallsAfterThrow = mapperCalls;

	release();
	await delay(50);

	t.is(mapperCalls, mapperCallsAfterThrow);
});

test('pMapIterable - in-flight mappers still settle after the consumer breaks', async t => {
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	const started = [];
	const settled = [];

	async function * source() {
		for (let index = 0; index < 100; index++) {
			yield index;
		}
	}

	const iterable = pMapIterable(source(), async value => {
		started.push(value);

		if (value > 0) {
			await gate;
		}

		settled.push(value);
		return value;
	}, {concurrency: 3, backpressure: 3});

	for await (const value of iterable) { // eslint-disable-line no-unreachable-loop
		t.is(value, 0);
		break;
	}

	// Only the first element got that far before the consumer stopped.
	t.deepEqual(settled, [0]);
	const startedAfterBreak = [...started];
	t.true(startedAfterBreak.length > 1);

	release();
	await delay(50);

	// Everything that was in flight ran to completion, and nothing new was started.
	t.deepEqual(settled, startedAfterBreak);
	t.deepEqual(started, startedAfterBreak);
});

test('pMapIterable - does not call the mapper for input that arrives after the consumer breaks', async t => {
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	const mappedValues = [];

	async function * source() {
		yield 0;
		await gate;
		yield 1;
		yield 2;
	}

	for await (const value of pMapIterable(source(), async value => { // eslint-disable-line no-unreachable-loop
		mappedValues.push(value);
		return value;
	}, {concurrency: 2})) {
		t.is(value, 0);
		break;
	}

	release();
	await delay(50);

	t.deepEqual(mappedValues, [0]);
});

test('pMapIterable - does not call the mapper for promise input that settles after the consumer breaks', async t => {
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	const mappedValues = [];
	const input = [0, gate.then(() => 1), gate.then(() => 2)];

	for await (const value of pMapIterable(input, async value => { // eslint-disable-line no-unreachable-loop
		mappedValues.push(value);
		return value;
	}, {concurrency: 3})) {
		t.is(value, 0);
		break;
	}

	release();
	await delay(50);

	t.deepEqual(mappedValues, [0]);
});

test('pMapIterable - does not call the mapper for input that arrives after a mapper throws', async t => {
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	const mappedValues = [];

	async function * source() {
		yield 0;
		await gate;
		yield 1;
	}

	await t.throwsAsync(collectAsyncIterable(pMapIterable(source(), async value => {
		mappedValues.push(value);
		throw new Error(`mapper error ${value}`);
	}, {concurrency: 2})), {message: 'mapper error 0'});

	release();
	await delay(50);

	t.deepEqual(mappedValues, [0]);
});

test('pMapIterable - does not call the mapper for input that arrives after `return()` is called', async t => {
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	const mappedValues = [];

	async function * source() {
		yield 0;
		await gate;
		yield 1;
	}

	const iterator = pMapIterable(source(), async value => {
		mappedValues.push(value);
		return value;
	}, {concurrency: 2})[Symbol.asyncIterator]();

	t.deepEqual(await iterator.next(), {value: 0, done: false});
	t.deepEqual(await iterator.return(), {value: undefined, done: true});

	release();
	await delay(50);

	t.deepEqual(mappedValues, [0]);
});

// Like a loop, the results before an error still come first, so the pending earlier input is still mapped.
test('pMapIterable - maps pending earlier input when a later mapper throws, and yields it before the error', async t => {
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	const mappedValues = [];
	const values = [];
	const input = [gate.then(() => 0), 1];

	const promise = t.throwsAsync((async () => {
		for await (const value of pMapIterable(input, async value => {
			mappedValues.push(value);

			if (value === 1) {
				throw new Error('mapper error 1');
			}

			return value;
		}, {concurrency: 2})) {
			values.push(value);
		}
	})());

	await delay(10);
	t.deepEqual(mappedValues, [1]);

	release();
	const error = await promise;
	t.is(error.message, 'mapper error 1');
	t.deepEqual(mappedValues, [1, 0]);
	t.deepEqual(values, [0]);
});

test('pMapIterable - the first error in input order wins, even when a later one settles first', async t => {
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	const promise = t.throwsAsync(collectAsyncIterable(pMapIterable([gate.then(() => 0), 1], async value => {
		throw new Error(`mapper error ${value}`);
	}, {concurrency: 2})));

	await delay(10);
	release();
	const error = await promise;
	t.is(error.message, 'mapper error 0');
});

test('pMapIterable - does not leave a gap for pending earlier input when a later mapper throws', async t => {
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	const values = [];

	await t.throwsAsync((async () => {
		for await (const value of pMapIterable([0, gate.then(() => 1), 2, 3], async value => {
			if (value === 3) {
				setTimeout(release);
				throw new Error('mapper error 3');
			}

			return value;
		})) {
			values.push(value);
		}
	})(), {message: 'mapper error 3'});

	t.deepEqual(values, [0, 1, 2]);
});

test('pMapIterable - a mapper error stops pulling and mapping past it, but still maps the pending earlier input', async t => {
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	let pulls = 0;
	const source = {
		[Symbol.iterator]() {
			return {
				next() {
					const pullIndex = pulls++;
					return {done: false, value: pullIndex === 0 || pullIndex === 2 ? gate.then(() => pullIndex) : pullIndex};
				},
			};
		},
	};

	const mappedValues = [];

	await t.throwsAsync(collectAsyncIterable(pMapIterable(source, async value => {
		mappedValues.push(value);

		if (value === 1) {
			setTimeout(release);
			throw new Error('mapper error 1');
		}

		return value;
	}, {concurrency: 3, backpressure: 10})), {message: 'mapper error 1'});

	t.deepEqual(mappedValues, [1, 0]);
	t.is(pulls, 3);
});

test('pMapIterable - with `preserveOrder: false`, a mapper error drops pending input while the consumer is busy', async t => {
	let releaseElement;
	const elementGate = new Promise(resolve => {
		releaseElement = resolve;
	});

	let releaseConsumer;
	const consumerGate = new Promise(resolve => {
		releaseConsumer = resolve;
	});

	const mappedValues = [];

	await t.throwsAsync((async () => {
		for await (const value of pMapIterable(['a', elementGate.then(() => 'pending'), 'throw'], async value => {
			mappedValues.push(value);

			if (value === 'throw') {
				// Throw only after the consumer got the first result, so it is busy when the error settles.
				await delay(0);
				setTimeout(releaseElement);
				throw new Error('mapper error');
			}

			return value;
		}, {preserveOrder: false})) {
			t.is(value, 'a');

			// Stay busy until the pending input has arrived, so only the error can keep it from being mapped.
			setTimeout(releaseConsumer, 20);
			await consumerGate;
		}
	})(), {message: 'mapper error'});

	t.deepEqual(mappedValues, ['a', 'throw']);
});

test('pMapIterable - yields pending earlier input before a source error, and does not pull again', async t => {
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	let pulls = 0;
	const source = {
		[Symbol.iterator]() {
			return {
				next() {
					pulls++;

					if (pulls === 1) {
						return {done: false, value: gate.then(() => 0)};
					}

					setTimeout(release);
					throw new Error('source error');
				},
			};
		},
	};

	const values = [];

	await t.throwsAsync((async () => {
		for await (const value of pMapIterable(source, async value => value, {concurrency: 3})) {
			values.push(value);
		}
	})(), {message: 'source error'});

	t.deepEqual(values, [0]);
	t.is(pulls, 2);
});

test('pMapIterable - closes the source iterator when the consumer breaks', async t => {
	let isSourceClosed = false;

	async function * source() {
		try {
			for (let index = 0; index < 100; index++) {
				yield index;
			}
		} finally {
			isSourceClosed = true;
		}
	}

	for await (const value of pMapIterable(source(), async value => value, {concurrency: 2})) { // eslint-disable-line no-unreachable-loop
		t.is(value, 0);
		break;
	}

	await delay(10);
	t.true(isSourceClosed);
});

test('pMapIterable - closes the source iterator when the consumer throws', async t => {
	let isSourceClosed = false;

	async function * source() {
		try {
			for (let index = 0; index < 100; index++) {
				yield index;
			}
		} finally {
			isSourceClosed = true;
		}
	}

	await t.throwsAsync(async () => {
		for await (const value of pMapIterable(source(), async value => value, {concurrency: 2})) { // eslint-disable-line no-unreachable-loop
			throw new Error(`consumer error ${value}`);
		}
	}, {message: 'consumer error 0'});

	await delay(10);
	t.true(isSourceClosed);
});

// `Symbol.asyncDispose` is what `await using` calls. Older Node.js versions have the symbol, but async generators do not have the method.
const hasAsyncDispose = Symbol.asyncDispose !== undefined && typeof (async function * () {})()[Symbol.asyncDispose] === 'function'; // eslint-disable-line no-use-extend-native/no-use-extend-native

(hasAsyncDispose ? test : test.skip)('pMapIterable - closes the source iterator when disposed', async t => {
	let isSourceClosed = false;

	async function * source() {
		try {
			for (let index = 0; index < 100; index++) {
				yield index;
			}
		} finally {
			isSourceClosed = true;
		}
	}

	const iterator = pMapIterable(source(), async value => value, {concurrency: 2})[Symbol.asyncIterator]();
	t.deepEqual(await iterator.next(), {done: false, value: 0});
	await iterator[Symbol.asyncDispose](); // eslint-disable-line no-use-extend-native/no-use-extend-native
	t.deepEqual(await iterator.next(), {done: true, value: undefined});

	await delay(10);
	t.true(isSourceClosed);
});

// A mapper error frees up a spawn slot while the consumer is still working through buffered
// results, so the source has to be closed even though nothing else is in flight.
test('pMapIterable - closes the source when a mapper throws while buffered results remain', async t => {
	let returnCallCount = 0;
	let index = 0;

	const iterable = {
		[Symbol.iterator]() {
			return {
				next: () => (index < 20 ? {done: false, value: index++} : {done: true}),
				return() {
					returnCallCount++;
					return {done: true, value: undefined};
				},
			};
		},
	};

	await t.throwsAsync((async () => {
		for await (const value of pMapIterable(iterable, async item => {
			await delay(item === 1 ? 40 : 1);
			if (item === 2) {
				throw new Error('mapper error');
			}

			return item;
		}, {concurrency: 3, backpressure: 3})) {
			t.true(Number.isInteger(value));
		}
	})(), {message: 'mapper error'});

	await delay(20);
	t.is(returnCallCount, 1);
});

test('pMapIterable - closes the source iterator when the mapper throws', async t => {
	let isSourceClosed = false;

	async function * source() {
		try {
			for (let index = 0; index < 100; index++) {
				yield index;
			}
		} finally {
			isSourceClosed = true;
		}
	}

	await t.throwsAsync(collectAsyncIterable(pMapIterable(source(), async value => {
		if (value === 1) {
			throw new Error('mapper error');
		}

		return value;
	}, {concurrency: 2})), {message: 'mapper error'});

	await delay(10);
	t.true(isSourceClosed);
});

test('pMapIterable - closes a sync source iterator when `return()` is called', async t => {
	let returnCallCount = 0;

	const iterable = {
		[Symbol.iterator]() {
			let index = 0;
			return {
				next: () => ({done: false, value: index++}),
				return() {
					returnCallCount++;
					return {done: true, value: undefined};
				},
			};
		},
	};

	const iterator = pMapIterable(iterable, async value => value, {concurrency: 2})[Symbol.asyncIterator]();
	t.deepEqual(await iterator.next(), {value: 0, done: false});
	t.deepEqual(await iterator.return(), {value: undefined, done: true});
	t.is(returnCallCount, 1);
});

test('pMapIterable - does not close the source iterator before it is exhausted', async t => {
	let isSourceClosed = false;
	let isSourceExhausted = false;

	async function * source() {
		try {
			yield 1;
			yield 2;
			isSourceExhausted = true;
		} finally {
			isSourceClosed = true;
		}
	}

	t.deepEqual(await collectAsyncIterable(pMapIterable(source(), async value => value, {concurrency: 1})), [1, 2]);
	t.true(isSourceExhausted);
	t.true(isSourceClosed);
});

test.serial('pMapIterable - a source `return()` that rejects does not affect the consumer', async t => {
	const iterable = {
		[Symbol.asyncIterator]() {
			let index = 0;
			return {
				async next() {
					return {done: false, value: index++};
				},
				async return() {
					throw new Error('return failed');
				},
			};
		},
	};

	const unhandledRejections = [];
	const onUnhandledRejection = error => {
		unhandledRejections.push(error);
	};

	process.on('unhandledRejection', onUnhandledRejection);

	try {
		for await (const value of pMapIterable(iterable, async value => value, {concurrency: 2})) { // eslint-disable-line no-unreachable-loop
			t.is(value, 0);
			break;
		}

		await delay(50);
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	t.deepEqual(unhandledRejections, []);
});

test('pMapIterable - a source blocked in `next()` does not block the consumer from stopping', async t => {
	async function * source() {
		yield 0;
		await new Promise(() => {}); // Never settles
	}

	// Getting here at all is the assertion: the source is stuck in `next()` forever, and AVA
	// fails the test if the loop does not finish. A wall-clock bound on top of that only
	// measures how busy the machine is.
	for await (const value of pMapIterable(source(), async value => value, {concurrency: 2})) { // eslint-disable-line no-unreachable-loop
		t.is(value, 0);
		break;
	}
});

test('closes the source iterator when a mapper rejects', async t => {
	let isSourceClosed = false;

	async function * source() {
		try {
			for (let index = 0; index < 100; index++) {
				yield index;
			}
		} finally {
			isSourceClosed = true;
		}
	}

	await t.throwsAsync(pMap(source(), async value => {
		if (value === 1) {
			throw new Error('mapper error');
		}

		await delay(10);
		return value;
	}, {concurrency: 2}), {message: 'mapper error'});

	await delay(10);
	t.true(isSourceClosed);
});

test('closes the source iterator when aborted', async t => {
	let returnCallCount = 0;

	const iterable = {
		[Symbol.iterator]() {
			let index = 0;
			return {
				next: () => ({done: false, value: index++}),
				return() {
					returnCallCount++;
					return {done: true, value: undefined};
				},
			};
		},
	};

	const abortController = new AbortController();

	setTimeout(() => {
		abortController.abort();
	}, 50);

	await t.throwsAsync(pMap(iterable, () => delay(1000), {concurrency: 2, signal: abortController.signal}), {name: 'AbortError'});
	t.is(returnCallCount, 1);
});

test('does not close the source iterator when it completes', async t => {
	let returnCallCount = 0;

	const iterable = {
		[Symbol.iterator]() {
			let index = 0;
			return {
				next: () => ({done: index === 3, value: index++}),
				return() {
					returnCallCount++;
					return {done: true, value: undefined};
				},
			};
		},
	};

	t.deepEqual(await pMap(iterable, async value => value, {concurrency: 2}), [0, 1, 2]);
	t.is(returnCallCount, 0);

	await t.throwsAsync(pMap(iterable, async () => {
		throw new Error('mapper error');
	}, {concurrency: 2, stopOnError: false}), {instanceOf: AggregateError});
	t.is(returnCallCount, 0);
});

test.serial('a source `return()` that rejects does not affect the `pMap` rejection', async t => {
	const iterable = {
		[Symbol.asyncIterator]() {
			let index = 0;
			return {
				async next() {
					return {done: false, value: index++};
				},
				async return() {
					throw new Error('return failed');
				},
			};
		},
	};

	const unhandledRejections = [];
	const onUnhandledRejection = error => {
		unhandledRejections.push(error);
	};

	process.on('unhandledRejection', onUnhandledRejection);

	try {
		await t.throwsAsync(pMap(iterable, async () => {
			throw new Error('mapper error');
		}, {concurrency: 2}), {message: 'mapper error'});

		await delay(50);
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	t.deepEqual(unhandledRejections, []);
});

test('pMapIterable - does not call `return()` on an exhausted source iterator', async t => {
	let returnCallCount = 0;

	const iterable = {
		[Symbol.iterator]() {
			let index = 0;
			return {
				next: () => ({done: index === 3, value: index++}),
				return() {
					returnCallCount++;
					return {done: true, value: undefined};
				},
			};
		},
	};

	t.deepEqual(await collectAsyncIterable(pMapIterable(iterable, async value => value, {concurrency: 2})), [0, 1, 2]);
	t.is(returnCallCount, 0);
});

// A source like a queue may block in `next()` after reporting `done`, so pulling again would hang. `for await` never pulls after `done`.
function exhaustibleSource(count) {
	let index = 0;
	let isExhausted = false;

	return {
		nextCallsAfterDone: 0,
		[Symbol.asyncIterator]() {
			return {
				next: async () => {
					if (isExhausted) {
						this.nextCallsAfterDone++;
						return {done: true, value: undefined};
					}

					if (index < count) {
						return {done: false, value: index++};
					}

					isExhausted = true;
					return {done: true, value: undefined};
				},
			};
		},
	};
}

test('does not call `next()` on an exhausted source iterator', async t => {
	const source = exhaustibleSource(3);

	t.deepEqual(await pMap(source, async value => {
		await delay(10);
		return value;
	}, {concurrency: 2}), [0, 1, 2]);
	t.is(source.nextCallsAfterDone, 0);
});

// The `done` from an async source is only known once the pull settles, which is a microtask or two
// after a worker asks for its next item. The two slow mappers here come back long after the `done`
// has been delivered, which is the window where a pull would otherwise slip past. Without the
// puller remembering `done` this asks the source for two more items every time.
test('pMap - does not pull again once a slow async source has reported `done`', async t => {
	const hop = async (value, count) => {
		for (let step = 0; step < count; step++) {
			// eslint-disable-next-line no-await-in-loop
			value = await Promise.resolve().then(() => value);
		}

		return value;
	};

	let index = 0;
	let sawDone = false;
	let callsAfterDone = 0;

	const source = {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					if (index >= 3) {
						if (sawDone) {
							callsAfterDone++;
						}

						sawDone = true;
						// Report `done` a couple of microtask hops late.
						return hop({done: true, value: undefined}, 2);
					}

					return {done: false, value: index++};
				},
			};
		},
	};

	// The first mapper finishes straight away and asks for the `done`. The other two take far
	// longer, so their follow-up pull lands in the window.
	const mapperHops = [0, 20, 20];
	await pMap(source, async value => hop(value, mapperHops[value]), {concurrency: 3});

	t.is(callsAfterDone, 0);
});

test('asyncIterator - does not call `next()` on an exhausted source iterator with stopOnError: false', async t => {
	const source = exhaustibleSource(3);

	await t.throwsAsync(pMap(source, async value => {
		await delay(10);
		throw new Error(`mapper error ${value}`);
	}, {concurrency: 2, stopOnError: false}), {instanceOf: AggregateError});
	t.is(source.nextCallsAfterDone, 0);
});

test('pMapIterable - does not call `next()` on an exhausted source iterator', async t => {
	const source = exhaustibleSource(3);

	t.deepEqual(await collectAsyncIterable(pMapIterable(source, async value => {
		await delay(10);
		return value;
	}, {concurrency: 2, backpressure: 4})), [0, 1, 2]);
	await delay(10);
	t.is(source.nextCallsAfterDone, 0);
});

test('does not call `next()` on an exhausted sync source iterator', async t => {
	let nextCallsAfterDone = 0;

	const source = {
		[Symbol.iterator]() {
			let index = 0;
			return {
				next() {
					if (index > 3) {
						nextCallsAfterDone++;
					}

					return {done: index === 3, value: index++};
				},
			};
		},
	};

	t.deepEqual(await pMap(source, async value => {
		await delay(10);
		return value;
	}), [0, 1, 2]);
	t.is(nextCallsAfterDone, 0);
});

test('pMapIterable - does not call `next()` on an exhausted source iterator when mappers skip', async t => {
	const source = exhaustibleSource(4);

	t.deepEqual(await collectAsyncIterable(pMapIterable(source, async value => {
		await delay(10);
		return value % 2 === 0 ? pMapSkip : value;
	}, {concurrency: 2, backpressure: 4})), [1, 3]);
	await delay(10);
	t.is(source.nextCallsAfterDone, 0);
});

// An endless source that counts its pulls and its `return()` calls.
function countingSource({isAsync = false} = {}) {
	const source = {
		pulls: 0,
		returnCalls: 0,
		[isAsync ? Symbol.asyncIterator : Symbol.iterator]() {
			return {
				next() {
					const result = {done: false, value: source.pulls++};
					return isAsync ? Promise.resolve(result) : result;
				},
				return() {
					source.returnCalls++;
					const result = {done: true, value: undefined};
					return isAsync ? Promise.resolve(result) : result;
				},
			};
		},
	};

	return source;
}

test('pMapStop - resolves with the results before the stop', async t => {
	const result = await pMap([1, 2, 3, 4, 5, 6], async value => {
		await delay(10);
		return value === 4 ? pMapStop : value;
	}, {concurrency: 2});

	t.deepEqual(result, [1, 2, 3]);
	t.is(result.length, Object.keys(result).length);
});

test('pMapStop - drops the later results that finished first, and waits for the earlier ones', async t => {
	const result = await pMap([1, 2, 3, 4, 5], async value => {
		await delay(value === 1 ? 50 : 10);
		return value === 3 ? pMapStop : value;
	});

	t.deepEqual(result, [1, 2]);
	t.is(result.length, Object.keys(result).length);
});

test('pMapStop - at the first element', async t => {
	t.deepEqual(await pMap([1, 2, 3], async value => (value === 1 ? pMapStop : value)), []);
});

for (const stopOnError of [true, false]) {
	test.serial(`pMapStop - handles a discarded input rejection with stopOnError: ${stopOnError}`, async t => {
		t.timeout(1000);

		let rejectLaterElement;
		const laterElement = new Promise((resolve, reject) => {
			rejectLaterElement = reject;
		});

		const mappedValues = [];
		const unhandledRejections = [];
		const onUnhandledRejection = error => {
			unhandledRejections.push(error);
		};

		process.on('unhandledRejection', onUnhandledRejection);

		try {
			t.deepEqual(await pMap([0, laterElement], value => {
				mappedValues.push(value);
				return pMapStop;
			}, {concurrency: 2, stopOnError}), []);

			// The stop must settle before the discarded input does.
			rejectLaterElement(new Error('after the stop'));
			await delay(0);
		} finally {
			process.off('unhandledRejection', onUnhandledRejection);
		}

		t.deepEqual(mappedValues, [0]);
		t.deepEqual(unhandledRejections, []);
	});
}

test('pMapStop - at the last element', async t => {
	t.deepEqual(await pMap([1, 2, 3, pMapStop], async value => value), [1, 2, 3]);
});

test('pMapStop - does not wait for the mappers of later elements', async t => {
	let isSlowMapperDone = false;

	const result = await pMap([1, 2, 3], async value => {
		if (value === 3) {
			await delay(100);
			isSlowMapperDone = true;
			return value;
		}

		return value === 2 ? pMapStop : value;
	});

	t.deepEqual(result, [1]);
	t.false(isSlowMapperDone);
});

test('pMapStop - the lowest index wins, whatever order the stops settle in', async t => {
	const result = await pMap([1, 2, 3, 4, 5], async value => {
		if (value === 2) {
			await delay(50);
			return pMapStop;
		}

		return value === 4 ? pMapStop : value;
	});

	t.deepEqual(result, [1]);
});

test('pMapStop - an error before the stop rejects', async t => {
	await t.throwsAsync(pMap([1, 2, 3], async value => {
		if (value === 1) {
			await delay(20);
			throw new Error('before');
		}

		return value === 2 ? pMapStop : value;
	}), {message: 'before'});
});

test('pMapStop - an error after the stop is ignored', async t => {
	let releaseFirstElement;
	const firstElementGate = new Promise(resolve => {
		releaseFirstElement = resolve;
	});

	let releaseError;
	const errorGate = new Promise(resolve => {
		releaseError = resolve;
	});

	// The stop lands while the first element is still running, and the error lands after the stop.
	t.deepEqual(await pMap([1, 2, 3], async value => {
		if (value === 1) {
			await firstElementGate;
			return value;
		}

		if (value === 2) {
			// Let every element be pulled first.
			await delay(5);
			setTimeout(releaseError);
			return pMapStop;
		}

		await errorGate;
		setTimeout(releaseFirstElement);
		throw new Error('after');
	}), [1]);
});

test('pMapStop - `stopOnError: false` collects only the errors before the stop', async t => {
	const error = await t.throwsAsync(pMap([1, 2, 3, 4], async value => {
		if (value === 1) {
			throw new Error('before');
		}

		if (value === 4) {
			throw new Error('after');
		}

		if (value === 3) {
			// The later error settles first, before the stop is known.
			await delay(10);
			return pMapStop;
		}

		return value;
	}, {stopOnError: false}), {instanceOf: AggregateError});

	t.deepEqual(error.errors.map(({message}) => message), ['before']);
});

test('pMapStop - ends an endless sync source with the default concurrency', async t => {
	const source = countingSource();

	t.deepEqual(await pMap(source, async value => (value === 3 ? pMapStop : value)), [0, 1, 2]);

	const {pulls} = source;
	t.true(pulls < 20, `pulled ${pulls} items`);
	t.is(source.returnCalls, 1);

	await delay(20);
	t.is(source.pulls, pulls);
});

test('pMapStop - stops pulling from an async source and closes it', async t => {
	const source = countingSource({isAsync: true});

	// The second element finishes after the stop while the first one is still running, so its worker would pull again.
	t.deepEqual(await pMap(source, async value => {
		if (value !== 2) {
			await delay([50, 20][value]);
		}

		return value === 2 ? pMapStop : value;
	}, {concurrency: 3}), [0, 1]);

	t.is(source.pulls, 3);
	t.is(source.returnCalls, 1);

	await delay(30);
	t.is(source.pulls, 3);
});

test('pMapStop - does not map a later element that resolves after the stop', async t => {
	const mappedValues = [];

	let releaseLaterElement;
	const laterElement = new Promise(resolve => {
		releaseLaterElement = resolve;
	});

	let releaseFirstElement;
	const firstElement = new Promise(resolve => {
		releaseFirstElement = resolve;
	});

	const result = await pMap([firstElement, 2, laterElement], async value => {
		mappedValues.push(value);

		if (value === 2) {
			// Let every element be pulled first.
			await delay(5);

			// Resolve the later element only after the stop, and the first one only after that, so the result cannot settle before the later element is seen.
			setTimeout(() => {
				releaseLaterElement(3);
				setTimeout(() => {
					releaseFirstElement(1);
				});
			});
			return pMapStop;
		}

		return value;
	});

	t.deepEqual(result, [1]);
	t.deepEqual(mappedValues, [2, 1]);
});

test('pMapStop - with `pMapSkip` before it', async t => {
	t.deepEqual(await pMap([1, pMapSkip, 3, pMapStop, 5], async value => value), [1, 3]);
});

test('pMapStop - a mapper that returns a promise of `pMapStop`', async t => {
	t.deepEqual(await pMap([1, 2, 3], value => (value === 2 ? Promise.resolve(pMapStop) : value)), [1]);
});

test('pMapStop - an input element that resolves to `pMapStop` is still passed to the mapper', async t => {
	const result = await pMap([Promise.resolve(pMapStop), 2], async value => (value === pMapStop ? 'kept' : value));
	t.deepEqual(result, ['kept', 2]);
});

test('pMapStop - from a synchronous mapper that uses the index', async t => {
	t.deepEqual(await pMap(['a', 'b', 'c', 'd'], (value, index) => (index === 2 ? pMapStop : `${value}${index}`)), ['a0', 'b1']);
});

test('pMapStop - does not close a source that is already done', async t => {
	let returnCalls = 0;

	const source = {
		[Symbol.iterator]() {
			const iterator = [1, 2, 3][Symbol.iterator]();

			return {
				next: () => iterator.next(),
				return() {
					returnCalls++;
					return {done: true};
				},
			};
		},
	};

	t.deepEqual(await pMap(source, async value => {
		if (value === 3) {
			await delay(10);
			return pMapStop;
		}

		return value;
	}), [1, 2]);

	t.is(returnCalls, 0);
});

test('pMapStop - closes the source once when several elements stop', async t => {
	const source = countingSource();

	t.deepEqual(await pMap(source, async value => {
		if (value === 1) {
			await delay(20);
			return pMapStop;
		}

		return value === 3 ? pMapStop : value;
	}, {concurrency: 4}), [0]);

	t.is(source.returnCalls, 1);
});

test('pMapStop - a stop after a rejection does not close the source again', async t => {
	const source = countingSource();

	await t.throwsAsync(pMap(source, async value => {
		if (value === 0) {
			await delay(10);
			throw new Error('before');
		}

		await delay(30);
		return pMapStop;
	}, {concurrency: 2}), {message: 'before'});

	await delay(40);
	t.is(source.returnCalls, 1);
});

test('pMapStop - aborting while an earlier element is still running rejects and closes the source once', async t => {
	const source = countingSource();
	const abortController = new AbortController();

	let releaseFirstElement;
	const firstElementGate = new Promise(resolve => {
		releaseFirstElement = resolve;
	});

	const promise = pMap(source, async value => {
		if (value === 0) {
			await firstElementGate;
			return value;
		}

		return value === 1 ? pMapStop : value;
	}, {concurrency: 2, signal: abortController.signal});

	await delay(10);
	t.is(source.returnCalls, 0);
	abortController.abort(new Error('aborted'));

	await t.throwsAsync(promise, {message: 'aborted'});
	t.is(source.returnCalls, 1);
	t.is(abortListenerCount(abortController.signal), 0);

	// The first element finishing after the abort must not close the source again.
	releaseFirstElement();
	await delay(10);
	t.is(source.returnCalls, 1);
});

// A source whose `return()` settles its pending `next()` calls with `done`, like `events.on()` does. A stop must not close it while an earlier pull is still pending, or that element is lost.
test('pMapStop - waits for an earlier pull that settles after the stop before it closes the source', async t => {
	const pendingPulls = new Set();
	let pullCount = 0;
	let releaseSecondPull;

	const source = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					const pullIndex = pullCount++;

					// The second pull stays pending until the stop has happened, so it settles out of call order.
					if (pullIndex !== 1) {
						return Promise.resolve({done: false, value: pullIndex});
					}

					return new Promise(resolve => {
						pendingPulls.add(resolve);

						releaseSecondPull = () => {
							if (pendingPulls.delete(resolve)) {
								resolve({done: false, value: pullIndex});
							}
						};
					});
				},
				async return() {
					for (const resolve of pendingPulls) {
						resolve({done: true});
					}

					pendingPulls.clear();
					return {done: true};
				},
			};
		},
	};

	t.deepEqual(await pMap(source, async value => {
		if (value === 2) {
			setTimeout(releaseSecondPull, 10);
			return pMapStop;
		}

		return value;
	}, {concurrency: 3}), [0, 1]);
});

test('pMapIterable - pMapStop ends the stream after the earlier results', async t => {
	const result = await collectAsyncIterable(pMapIterable([1, 2, 3, 4, 5], async value => {
		await delay(value === 1 ? 30 : 0);
		return value === 3 ? pMapStop : value;
	}));

	t.deepEqual(result, [1, 2]);
});

test('pMapIterable - pMapStop with `preserveOrder: false` ends the stream after the results that were ready before it', async t => {
	// The mappers of the first and the last element never finish, so the stream cannot wait for them.
	const result = await collectAsyncIterable(pMapIterable([1, 2, 3, 4], async value => {
		if (value === 1 || value === 4) {
			await new Promise(() => {});
		}

		if (value === 3) {
			await delay(10);
			return pMapStop;
		}

		return value;
	}, {preserveOrder: false}));

	t.deepEqual(result, [2]);
});

test('pMapIterable - pMapStop stops pulling and closes the source', async t => {
	const source = countingSource();

	// The consumer is still waiting on the first element after the stop, so the worker that stopped is free to spawn again.
	t.deepEqual(await collectAsyncIterable(pMapIterable(source, async value => {
		if (value === 0) {
			await delay(30);
		}

		return value === 1 ? pMapStop : value;
	}, {concurrency: 2, backpressure: 10})), [0]);

	t.is(source.pulls, 2);
	t.is(source.returnCalls, 1);

	await delay(30);
	t.is(source.pulls, 2);
});

// The consumer is still waiting on the first element when the stop happens, so the stop itself has to keep the later element from being mapped, without dropping the earlier one.
test('pMapIterable - pMapStop maps an earlier element that resolves after the stop, but not a later one', async t => {
	const mappedValues = [];

	const result = await collectAsyncIterable(pMapIterable([delay(50).then(() => 1), 2, delay(20).then(() => 3)], async value => {
		mappedValues.push(value);
		return value === 2 ? pMapStop : value;
	}));

	t.deepEqual(result, [1]);
	t.deepEqual(mappedValues, [2, 1]);
});

test('pMapIterable - pMapStop agrees with pMap', async t => {
	const input = [1, 2, pMapSkip, 4, pMapStop, 6, 7];
	const mapper = async value => {
		await delay(randomInt(0, 10));
		return value;
	};

	const expected = [1, 2, 4];
	t.deepEqual(await pMap(input, mapper, {concurrency: 3}), expected);
	t.deepEqual(await collectAsyncIterable(pMapIterable(input, mapper, {concurrency: 3})), expected);
});

test('pMapIterable - pMapStop ignores an error after the stop, and keeps an earlier element that is still pending', async t => {
	const result = await collectAsyncIterable(pMapIterable([delay(50).then(() => 1), 2, 3], async value => {
		if (value === 3) {
			await delay(5);
			throw new Error('after');
		}

		return value === 2 ? pMapStop : value;
	}));

	t.deepEqual(result, [1]);
});

test('pMapIterable - pMapStop ignores an input element that rejects after the stop', async t => {
	const result = await collectAsyncIterable(pMapIterable([delay(50).then(() => 1), 2, delay(20).then(() => {
		throw new Error('after');
	})], async value => (value === 2 ? pMapStop : value)));

	t.deepEqual(result, [1]);
});

test('pMapIterable - pMapStop with `preserveOrder: false` stops pulling and closes the source', async t => {
	const source = countingSource();

	t.deepEqual(await collectAsyncIterable(pMapIterable(source, async value => {
		if (value === 0) {
			await delay(30);
		}

		return value === 1 ? pMapStop : value;
	}, {concurrency: 2, backpressure: 10, preserveOrder: false})), []);

	t.is(source.pulls, 2);
	t.is(source.returnCalls, 1);

	await delay(40);
	t.is(source.pulls, 2);
});

test('pMapIterable - pMapStop with `preserveOrder: false` stops pulling while the consumer is busy', async t => {
	const source = countingSource();
	const values = [];

	for await (const value of pMapIterable(source, async value => {
		await delay(value === 0 ? 0 : 10);
		return value === 1 ? pMapStop : value;
	}, {concurrency: 1, backpressure: 10, preserveOrder: false})) {
		values.push(value);
		await delay(50);
	}

	t.deepEqual(values, [0]);
	t.is(source.pulls, 2);
	t.is(source.returnCalls, 1);
});

test('pMapIterable - pMapStop stops pulling from an async source and closes it', async t => {
	const source = countingSource({isAsync: true});

	t.deepEqual(await collectAsyncIterable(pMapIterable(source, async value => {
		if (value === 0) {
			await delay(30);
		}

		return value === 1 ? pMapStop : value;
	}, {concurrency: 2, backpressure: 10})), [0]);

	t.is(source.pulls, 2);
	t.is(source.returnCalls, 1);

	await delay(30);
	t.is(source.pulls, 2);
});

test('pMapIterable - pMapStop, the lowest index wins when a later stop settles last', async t => {
	const mappedValues = [];

	let releaseLaterStop;
	const laterStopGate = new Promise(resolve => {
		releaseLaterStop = resolve;
	});

	let releasePendingElements;
	const pendingElements = new Promise(resolve => {
		releasePendingElements = resolve;
	});

	const result = await collectAsyncIterable(pMapIterable([pendingElements.then(() => 0), 1, pendingElements.then(() => 2), 3], async value => {
		mappedValues.push(value);

		if (value === 1) {
			// Let every element be pulled first.
			await delay(5);
			setTimeout(releaseLaterStop);
			return pMapStop;
		}

		if (value === 3) {
			await laterStopGate;

			// The pending elements resolve only once both stops have landed.
			setTimeout(releasePendingElements);
			return pMapStop;
		}

		return value;
	}));

	t.deepEqual(result, [0]);
	t.deepEqual(mappedValues, [1, 3, 0]);
});

test('pMapIterable - pMapStop ignores an error from a later element, even when it lands before the stop', async t => {
	const mappedValues = [];

	let releaseStop;
	const stopGate = new Promise(resolve => {
		releaseStop = resolve;
	});

	let releaseFirstElement;
	const firstElement = new Promise(resolve => {
		releaseFirstElement = resolve;
	});

	const result = await collectAsyncIterable(pMapIterable([firstElement, 2, 3], async value => {
		mappedValues.push(value);

		if (value === 1) {
			return value;
		}

		if (value === 2) {
			await stopGate;
			setTimeout(() => {
				releaseFirstElement(1);
			});
			return pMapStop;
		}

		// Let every element be pulled first.
		await delay(5);
		setTimeout(releaseStop);
		throw new Error('after');
	}));

	// Like a loop, which would stop before it ever reached the error, and the error does not drop the first element.
	t.deepEqual(result, [1]);
	t.deepEqual(mappedValues, [2, 3, 1]);
});

test('pMapIterable - pMapStop with `preserveOrder: false` does not throw an error that settled after the stop', async t => {
	let releaseStop;
	const stopGate = new Promise(resolve => {
		releaseStop = resolve;
	});

	let releaseError;
	const errorGate = new Promise(resolve => {
		releaseError = resolve;
	});

	let markErrorSettled;
	const errorSettled = new Promise(resolve => {
		markErrorSettled = resolve;
	});

	const values = [];

	for await (const value of pMapIterable([0, 1, 2], async value => {
		if (value === 0) {
			setTimeout(releaseStop);
			return 'a';
		}

		if (value === 1) {
			await errorGate;
			setTimeout(markErrorSettled);
			throw new Error('after the stop');
		}

		await stopGate;
		setTimeout(releaseError);
		return pMapStop;
	}, {preserveOrder: false})) {
		values.push(value);

		// A slow consumer, so the error settles before the consumer reaches the stop.
		await errorSettled;
	}

	t.deepEqual(values, ['a']);
});

test('pMapStop - an error from a later element that lands before the stop rejects', async t => {
	let releaseStop;
	const stopGate = new Promise(resolve => {
		releaseStop = resolve;
	});

	await t.throwsAsync(pMap([1, 2, 3], async value => {
		if (value === 2) {
			await stopGate;
			return pMapStop;
		}

		if (value === 3) {
			setTimeout(releaseStop);
			throw new Error('later');
		}

		return value;
	}), {message: 'later'});
});
