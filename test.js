import process from 'node:process';
import {Readable} from 'node:stream';
import vm from 'node:vm';
import {getEventListeners} from 'node:events';
import test from 'ava';
import delay from 'delay';
import timeSpan from 'time-span';
import randomInt from 'random-int';
import assertInRange from './assert-in-range.js';
import pMap, {pMapIterable, pMapSettled, pMapKeyed, pMapSettledKeyed, pMapSkip, pMapStop} from './index.js';

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

// https://github.com/sindresorhus/p-map/issues/78
test('pMapIterable - reads the next element while the mappers run when `backpressure` allows it', async t => {
	for (const {backpressure, expectedPulls} of [
		// Everything in flight already fills `backpressure`, so nothing is read ahead.
		{backpressure: undefined, expectedPulls: 2},
		// A pull does not hold a mapper slot, so up to `concurrency` elements are read ahead.
		{backpressure: 10, expectedPulls: 4},
		// Without a `backpressure` limit, the read-ahead while the mappers run is still capped at `concurrency`.
		{backpressure: Number.POSITIVE_INFINITY, expectedPulls: 4},
	]) {
		const source = countingSource();
		const {mapper, release} = gatedMapper();
		const started = [];

		const iterator = pMapIterable(source, value => {
			started.push(value);
			return mapper(value);
		}, {concurrency: 2, backpressure})[Symbol.asyncIterator]();

		const first = iterator.next();
		await drainEventLoop(); // eslint-disable-line no-await-in-loop

		t.deepEqual(started, [0, 1]);
		t.is(source.pulls, expectedPulls);

		release(0);
		t.deepEqual(await first, {done: false, value: 0}); // eslint-disable-line no-await-in-loop
		await drainEventLoop(); // eslint-disable-line no-await-in-loop

		// The freed mapper slot goes to the element that was read ahead, if there is one.
		t.deepEqual(started, [0, 1, 2]);

		await iterator.return(); // eslint-disable-line no-await-in-loop
	}
});

test('pMapIterable - read-ahead never overlaps more `next()` calls than `concurrency`', async t => {
	for (const backpressure of [2, 5, Number.POSITIVE_INFINITY]) {
		let pending = 0;
		let peak = 0;
		let index = 0;
		const source = {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						pending++;
						peak = Math.max(peak, pending);
						await delay(1);
						pending--;
						return index < 10 ? {done: false, value: index++} : {done: true, value: undefined};
					},
				};
			},
		};

		// eslint-disable-next-line no-await-in-loop
		t.deepEqual(await collectAsyncIterable(pMapIterable(source, async value => {
			await delay(2);
			return value;
		}, {concurrency: 2, backpressure})), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

		t.true(peak <= 2, `${peak} overlapping \`next()\` calls with \`backpressure: ${backpressure}\``);
	}
});

// https://github.com/sindresorhus/p-map/issues/78
// The issue's pipeline: a slow source and three slow stages. Each stage reads its next element while it maps the current one, so the run takes about as long as the source plus one pass through the stages, instead of reading and mapping one after the other.
test.serial('pMapIterable - a chain of stages overlaps reading and mapping', async t => {
	async function * source() {
		for (let index = 0; index < 8; index++) {
			await delay(50); // eslint-disable-line no-await-in-loop
			yield index;
		}
	}

	const stage = iterable => pMapIterable(iterable, async value => {
		await delay(50);
		return value;
	}, {concurrency: 1, backpressure: 2});

	const end = timeSpan();
	t.deepEqual(await collectAsyncIterable(stage(stage(stage(source())))), [0, 1, 2, 3, 4, 5, 6, 7]);

	// About 550 ms with the overlap (8 elements from the source, plus 3 stages for the last one), and about 900 ms without it.
	assertInRange(t, end(), {start: 500, end: 850});
});

test('pMapIterable - `backpressure` caps the elements read ahead together with the running mappers', async t => {
	for (const preserveOrder of [true, false]) {
		const source = countingSource();
		const {mapper, release} = gatedMapper();
		const started = [];

		const iterator = pMapIterable(source, value => {
			started.push(value);
			return mapper(value);
		}, {concurrency: 2, backpressure: 3, preserveOrder})[Symbol.asyncIterator]();

		const first = iterator.next();
		await drainEventLoop(); // eslint-disable-line no-await-in-loop

		// Two running mappers and one element waiting for a mapper fill `backpressure`, although `concurrency` allows two waiting elements.
		t.deepEqual(started, [0, 1]);
		t.is(source.pulls, 3);

		release(0);
		t.deepEqual(await first, {done: false, value: 0}); // eslint-disable-line no-await-in-loop
		await drainEventLoop(); // eslint-disable-line no-await-in-loop

		// The waiting element got the freed mapper slot, and taking the result freed one `backpressure` slot, so one more element is read.
		t.deepEqual(started, [0, 1, 2]);
		t.is(source.pulls, 4);

		await iterator.return(); // eslint-disable-line no-await-in-loop
	}
});

test('pMapIterable - does not map the elements waiting for a mapper when `return()` is called', async t => {
	const source = countingSource();
	const {mapper, release} = gatedMapper();
	const started = [];

	const iterator = pMapIterable(source, value => {
		started.push(value);
		return mapper(value);
	}, {concurrency: 2, backpressure: 10})[Symbol.asyncIterator]();

	const first = iterator.next();
	await drainEventLoop();

	// Two running mappers, and two elements read ahead that wait for a mapper.
	t.deepEqual(started, [0, 1]);
	t.is(source.pulls, 4);

	const returned = iterator.return();
	release(0);
	release(1);

	t.deepEqual(await first, {done: false, value: 0});
	t.deepEqual(await returned, {done: true, value: undefined});
	await drainEventLoop();

	// The freed mapper slots went to the waiting elements, which were dropped instead of mapped.
	t.deepEqual(started, [0, 1]);
	t.is(source.pulls, 4);
	t.is(source.returnCalls, 1);
});

test('pMapIterable - pMapStop does not map the later elements waiting for a mapper', async t => {
	const source = countingSource();
	const {mapper, release} = gatedMapper();
	const started = [];

	const iterator = pMapIterable(source, async value => {
		started.push(value);
		const result = await mapper(value);
		return result === 1 ? pMapStop : result;
	}, {concurrency: 2, backpressure: 10})[Symbol.asyncIterator]();

	const first = iterator.next();
	await drainEventLoop();

	t.deepEqual(started, [0, 1]);
	t.is(source.pulls, 4);

	release(1);
	await drainEventLoop();

	// The freed mapper slot went to the elements after the stop, which were dropped instead of mapped.
	t.deepEqual(started, [0, 1]);

	release(0);
	t.deepEqual(await first, {done: false, value: 0});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
	t.is(source.pulls, 4);
	t.is(source.returnCalls, 1);
});

// The first element resolves last, so it waits for a mapper behind a later one. The throwing mapper must still hand its slot over, or the first element is never mapped and the consumer hangs.
test('pMapIterable - a mapper that throws hands its slot to an earlier element waiting for a mapper', async t => {
	let resolveFirstElement;
	const firstElement = new Promise(resolve => {
		resolveFirstElement = resolve;
	});

	const {mapper, release} = gatedMapper();
	const started = [];

	const iterator = pMapIterable([firstElement, 1, 2, 3, 4, 5], async value => {
		started.push(value);
		const result = await mapper(value);

		if (result === 1) {
			throw new Error('mapper error 1');
		}

		return result;
	}, {concurrency: 2, backpressure: 10})[Symbol.asyncIterator]();

	const first = iterator.next();
	await drainEventLoop();

	// The second and third elements took the mapper slots, and the fourth waits for one.
	t.deepEqual(started, [1, 2]);

	resolveFirstElement(0);
	await drainEventLoop();

	// The fourth element is dropped, as it comes after the error, and the first element gets the slot after it.
	release(1);
	await drainEventLoop();
	t.deepEqual(started, [1, 2, 0]);

	release(0);
	t.deepEqual(await first, {done: false, value: 0});
	await t.throwsAsync(iterator.next(), {message: 'mapper error 1'});

	release(2);
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

	// No read-ahead, as a `backpressure` above `concurrency` would read the throwing element while the first one is still mapped, and the error would then come first.
	const iterator = pMapIterable(source(), value => value, {concurrency: 1, preserveOrder: false})[Symbol.asyncIterator]();

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
	// The fourth element was read ahead when the second one started mapping, but it is never mapped.
	t.is(pulls, 4);
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

	// The stop at the second element, plus the `concurrency` elements read ahead while the mappers ran.
	t.is(source.pulls, 4);
	t.is(source.returnCalls, 1);

	await delay(30);
	t.is(source.pulls, 4);
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

	// The stop at the second element, plus the `concurrency` elements read ahead while the mappers ran.
	t.is(source.pulls, 4);
	t.is(source.returnCalls, 1);

	await delay(40);
	t.is(source.pulls, 4);
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
	// The stop at the second element, plus the one element read ahead while it was mapped.
	t.is(source.pulls, 3);
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

	// The stop at the second element, plus the `concurrency` elements read ahead while the mappers ran.
	t.is(source.pulls, 4);
	t.is(source.returnCalls, 1);

	await delay(30);
	t.is(source.pulls, 4);
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

//
// pMapSettled tests
//

const fulfilled = value => ({status: 'fulfilled', value});
const rejected = reason => ({status: 'rejected', reason});

test('pMapSettled - settles every element in input order', async t => {
	const error = new Error('two');
	const results = await pMapSettled([1, 2, 3, 4], async value => {
		// Finish in the reverse of input order.
		await delay(40 - (value * 10));

		if (value === 2) {
			throw error;
		}

		return value * 10;
	}, {concurrency: 4});

	t.deepEqual(results, [fulfilled(10), rejected(error), fulfilled(30), fulfilled(40)]);
});

test('pMapSettled - matches `Promise.allSettled` for the same input', async t => {
	const createInput = () => {
		const rejection = Promise.reject(new Error('input'));
		return [1, rejection, delay(10, {value: 3}), Promise.resolve(4)];
	};

	t.deepEqual(await pMapSettled(createInput(), value => value), await Promise.allSettled(createInput()));
});

test('pMapSettled - an element that rejects is settled without calling the mapper', async t => {
	const error = new Error('input');
	const mappedValues = [];

	const results = await pMapSettled([1, Promise.reject(error), 3], value => {
		mappedValues.push(value);
		return value;
	}, {concurrency: 3});

	t.deepEqual(results, [fulfilled(1), rejected(error), fulfilled(3)]);
	t.deepEqual(mappedValues, [1, 3]);
});

test('pMapSettled - respects concurrency', async t => {
	let running = 0;
	let maxRunning = 0;

	const results = await pMapSettled([1, 2, 3, 4, 5, 6], async value => {
		running++;
		maxRunning = Math.max(maxRunning, running);
		await delay(10);
		running--;

		if (value % 2 === 0) {
			throw new Error(`${value}`);
		}

		return value;
	}, {concurrency: 2});

	t.is(maxRunning, 2);
	t.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled', 'rejected', 'fulfilled', 'rejected']);
});

test('pMapSettled - keeps a mapper error that is `undefined`', async t => {
	// Thrown through a variable so the intent is not a bare `throw undefined`.
	const thrown = undefined;

	t.deepEqual(await pMapSettled([1], async () => {
		throw thrown;
	}), [rejected(thrown)]);
});

test('pMapSettled - leaves out `pMapSkip` results', async t => {
	const error = new Error('three');

	const results = await pMapSettled([1, 2, 3, 4], async value => {
		if (value === 2) {
			return pMapSkip;
		}

		if (value === 3) {
			throw error;
		}

		return value;
	});

	t.deepEqual(results, [fulfilled(1), rejected(error), fulfilled(4)]);
});

test('pMapSettled - a fulfilled result can hold a value that looks like a settled result', async t => {
	t.deepEqual(await pMapSettled([1], () => rejected('not really')), [fulfilled(rejected('not really'))]);
});

test('pMapSettled - `pMapStop` resolves with the results before the stop', async t => {
	const error = new Error('two');

	const results = await pMapSettled([1, 2, 3, 4, 5], async value => {
		await delay(value === 1 ? 30 : 10);

		if (value === 1) {
			return value;
		}

		if (value === 2) {
			throw error;
		}

		return pMapStop;
	}, {concurrency: 2});

	t.deepEqual(results, [fulfilled(1), rejected(error)]);
});

test('pMapSettled - an error after `pMapStop` does not change the results', async t => {
	const results = await pMapSettled([1, 2, 3], async value => {
		if (value === 2) {
			await delay(10);
			return pMapStop;
		}

		if (value === 3) {
			await delay(30);
			throw new Error('after the stop');
		}

		return value;
	});

	// Wait for the mapper after the stop to throw.
	await delay(50);

	t.deepEqual(results, [fulfilled(1)]);
});

test('pMapSettled - works with an async iterable', async t => {
	const results = await pMapSettled(new AsyncTestData(errorInput1), mapper, {concurrency: 2});

	t.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected', 'rejected']);
	t.deepEqual(results.slice(0, 2), [fulfilled(20), fulfilled(30)]);
	t.is(results[2].reason.message, 'foo');
	t.is(results[3].reason.message, 'bar');
});

test('pMapSettled - rejects when the source iterator throws', async t => {
	await t.throwsAsync(pMapSettled(new ThrowingIterator(5, 2), async value => {
		throw new Error(`mapper ${value}`);
	}, {concurrency: 1}), {message: 'throwing on index 2'});
});

test('pMapSettled - rejects when the signal aborts', async t => {
	const abortController = new AbortController();

	setTimeout(() => {
		abortController.abort();
	}, 10);

	await t.throwsAsync(pMapSettled([1, 2], async value => {
		await delay(100);
		throw new Error(`${value}`);
	}, {signal: abortController.signal}), {name: 'AbortError'});
});

test('pMapSettled - validates the arguments', async t => {
	await t.throwsAsync(pMapSettled(undefined, value => value), {instanceOf: TypeError});
	await t.throwsAsync(pMapSettled([], undefined), {instanceOf: TypeError});
	await t.throwsAsync(pMapSettled([], value => value, {concurrency: 0}), {instanceOf: TypeError});
});

test('pMapSettled - ignores `stopOnError: false`', async t => {
	const error = new Error('one');

	const results = await pMapSettled([1, 2], async value => {
		if (value === 1) {
			throw error;
		}

		return value;
	}, {stopOnError: false});

	t.deepEqual(results, [rejected(error), fulfilled(2)]);
});

test('pMapSettled - empty input', async t => {
	t.deepEqual(await pMapSettled([], value => value), []);
});

//
// pMapKeyed and pMapSettledKeyed tests
//

test('pMapKeyed - maps each value with its key into a null-prototype object', async t => {
	const result = await pMapKeyed({a: 1, b: Promise.resolve(2)}, async (value, key) => `${key}${value}`);

	t.is(Object.getPrototypeOf(result), null);
	t.deepEqual(result, {a: 'a1', b: 'b2'});
});

test('pMapKeyed - uses the own enumerable string and symbol keys, in property order', async t => {
	const symbol = Symbol('symbol');
	const input = Object.create({inherited: 'inherited'});
	input.b = 'b';
	input.a = 'a';
	input[2] = 'two';
	input[1] = 'one';
	input[symbol] = 'symbol';
	Object.defineProperty(input, 'hidden', {value: 'hidden', enumerable: false});

	const mappedKeys = [];
	const result = await pMapKeyed(input, (value, key) => {
		mappedKeys.push(key);
		return value;
	}, {concurrency: 1});

	t.deepEqual(Reflect.ownKeys(result), ['1', '2', 'b', 'a', symbol]);
	t.deepEqual(mappedKeys, ['1', '2', 'b', 'a', symbol]);
	t.deepEqual(result, {1: 'one', 2: 'two', b: 'b', a: 'a', [symbol]: 'symbol'});
});

test('pMapKeyed - checks and reads each key in turn, like `Promise.allKeyed`', async t => {
	const traps = [];
	const input = new Proxy({x: 1, y: 2}, {
		ownKeys(target) {
			traps.push('ownKeys');
			return Reflect.ownKeys(target);
		},
		getOwnPropertyDescriptor(target, key) {
			traps.push(`getOwnPropertyDescriptor ${key}`);
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
		get(target, key, receiver) {
			traps.push(`get ${key}`);
			return Reflect.get(target, key, receiver);
		},
	});

	t.deepEqual(await pMapKeyed(input, value => value), {x: 1, y: 2});
	t.deepEqual(traps, ['ownKeys', 'getOwnPropertyDescriptor x', 'get x', 'getOwnPropertyDescriptor y', 'get y']);
});

test('pMapKeyed - a key like `__proto__` is an own property of the result', async t => {
	const input = JSON.parse('{"__proto__": 1, "toString": 2}');
	const result = await pMapKeyed(input, value => value * 10);

	t.deepEqual(Object.keys(result), ['__proto__', 'toString']);
	t.is(result.__proto__, 10); // eslint-disable-line no-proto
	t.is(result.toString, 20);
});

test('pMapKeyed - rejects on a mapper error', async t => {
	await t.throwsAsync(pMapKeyed({a: 1, b: 2}, async (value, key) => {
		if (key === 'b') {
			throw new Error('b');
		}

		return value;
	}), {message: 'b'});
});

test('pMapKeyed - rejects on a value that rejects, without calling the mapper for it', async t => {
	const mappedKeys = [];

	await t.throwsAsync(pMapKeyed({a: 1, b: Promise.reject(new Error('b'))}, (value, key) => {
		mappedKeys.push(key);
		return value;
	}), {message: 'b'});

	t.deepEqual(mappedKeys, ['a']);
});

test('pMapKeyed - collects the errors in key order with stopOnError: false', async t => {
	const error = await t.throwsAsync(pMapKeyed({a: 1, b: 2, c: 3}, async (value, key) => {
		// Finish in the reverse of key order.
		await delay(30 - (value * 10));

		if (key !== 'b') {
			throw new Error(key);
		}

		return value;
	}, {stopOnError: false}), {instanceOf: AggregateError});

	t.deepEqual(error.errors.map(error => error.message), ['a', 'c']);
});

test('pMapKeyed - collects a value that rejects with stopOnError: false', async t => {
	const mappedKeys = [];

	const error = await t.throwsAsync(pMapKeyed({a: 1, b: Promise.reject(new Error('b')), c: 3}, (value, key) => {
		mappedKeys.push(key);
		return value;
	}, {stopOnError: false}), {instanceOf: AggregateError});

	t.deepEqual(error.errors.map(error => error.message), ['b']);
	t.deepEqual(mappedKeys, ['a', 'c']);
});

test.serial('pMapKeyed - a value that rejects before a mapper slot reaches it is not an unhandled rejection', async t => {
	const unhandledRejections = [];
	const onUnhandledRejection = error => {
		unhandledRejections.push(error);
	};

	process.on('unhandledRejection', onUnhandledRejection);

	try {
		await t.throwsAsync(pMapKeyed({slow: delay(50), fails: Promise.reject(new Error('fails'))}, value => value, {concurrency: 1}), {message: 'fails'});

		const result = await pMapSettledKeyed({slow: delay(50), fails: Promise.reject(new Error('fails'))}, value => value, {concurrency: 1});
		t.is(result.fails.reason.message, 'fails');

		const mapResult = await pMapSettledKeyed(new Map([['slow', delay(50)], ['fails', Promise.reject(new Error('fails'))]]), value => value, {concurrency: 1});
		t.is(mapResult.get('fails').reason.message, 'fails');

		// A value keeps its handler when reading a later value throws.
		await t.throwsAsync(pMapKeyed({
			fails: Promise.reject(new Error('fails')),
			get later() {
				throw new Error('getter');
			},
		}, value => value), {message: 'getter'});

		// Every value gets its handler before an argument error rejects.
		await t.throwsAsync(pMapKeyed({fails: Promise.reject(new Error('fails'))}, undefined), {message: 'Mapper function is required'});
		await t.throwsAsync(pMapKeyed({fails: Promise.reject(new Error('fails'))}, value => value, {concurrency: 0}), {instanceOf: TypeError});

		await drainEventLoop();
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	t.deepEqual(unhandledRejections, []);
});

test('pMapKeyed - `pMapSkip` leaves out the key', async t => {
	const result = await pMapKeyed({a: 1, b: 2, c: 3}, value => (value === 2 ? pMapSkip : value));
	t.deepEqual(result, {a: 1, c: 3});
});

test('pMapKeyed - `pMapStop` keeps the keys before it, and ignores an error from a later key', async t => {
	const result = await pMapKeyed({a: 1, b: 2, c: 3, d: 4}, async (value, key) => {
		if (key === 'a') {
			await delay(30);
			return value;
		}

		if (key === 'c') {
			await delay(10);
			return pMapStop;
		}

		if (key === 'd') {
			await delay(20);
			throw new Error('after the stop');
		}

		return value;
	});

	t.deepEqual(result, {a: 1, b: 2});
});

test('pMapKeyed - rejects when the signal aborts', async t => {
	const abortController = new AbortController();

	setTimeout(() => {
		abortController.abort();
	}, 10);

	await t.throwsAsync(pMapKeyed({a: delay(100)}, value => value, {signal: abortController.signal}), {name: 'AbortError'});
});

test('pMapKeyed - skips a key that a getter deletes before it is reached, like `Promise.allKeyed`', async t => {
	const input = {
		get a() {
			delete input.b;
			return 1;
		},
		b: 2,
	};

	t.deepEqual(await pMapKeyed(input, value => value), {a: 1});
});

test('pMapKeyed - rejects when reading a value throws', async t => {
	await t.throwsAsync(pMapKeyed({
		get a() {
			throw new Error('getter');
		},
	}, value => value), {message: 'getter'});
});

test('pMapKeyed - validates the arguments', async t => {
	for (const input of [null, undefined, 1, 'abc', Symbol('input')]) {
		// eslint-disable-next-line no-await-in-loop
		await t.throwsAsync(pMapKeyed(input, value => value), {instanceOf: TypeError, message: /Expected `input` to be an object/});
	}

	await t.throwsAsync(pMapKeyed({}, undefined), {instanceOf: TypeError, message: 'Mapper function is required'});
	await t.throwsAsync(pMapKeyed({}, value => value, {concurrency: 0}), {instanceOf: TypeError});
	await t.throwsAsync(pMapSettledKeyed(null, value => value), {instanceOf: TypeError, message: 'Expected `input` to be an object, got (null)'});
	await t.throwsAsync(pMapSettledKeyed({a: 1}, undefined), {instanceOf: TypeError, message: 'Mapper function is required'});

	// The input is checked first, then the mapper, then the options.
	await t.throwsAsync(pMapKeyed(null, undefined, {concurrency: 0}), {instanceOf: TypeError, message: /Expected `input` to be an object/});
	await t.throwsAsync(pMapKeyed({}, undefined, {concurrency: 0}), {instanceOf: TypeError, message: 'Mapper function is required'});
	await t.throwsAsync(pMapSettledKeyed(new Map(), undefined, {concurrency: 0}), {instanceOf: TypeError, message: 'Mapper function is required'});
});

test('pMapKeyed - accepts any object, like `Promise.allKeyed`', async t => {
	t.deepEqual(await pMapKeyed(['x', 'y'], value => value), {0: 'x', 1: 'y'});
	t.deepEqual(await pMapKeyed(Object.assign(() => {}, {a: 1}), value => value), {a: 1});

	// A `Set` keeps its values outside of its properties, so it has no keys.
	t.deepEqual(await pMapKeyed(new Set([1]), value => value), {});
});

test('pMapKeyed - maps a `Map` into a `Map` with the same keys, in the same order', async t => {
	const objectKey = {};
	const mappedKeys = [];

	const result = await pMapKeyed(new Map([
		['b', Promise.resolve(1)],
		[objectKey, 2],
		[3, 3],
		['skip', 4],
	]), async (value, key) => {
		mappedKeys.push(key);
		await delay(10 - value);
		return key === 'skip' ? pMapSkip : value * 10;
	});

	t.deepEqual(result, new Map([['b', 10], [objectKey, 20], [3, 30]]));
	t.deepEqual(mappedKeys, ['b', objectKey, 3, 'skip']);
});

test('pMapKeyed - uses the entries of a `Map`, not its properties', async t => {
	const map = new Map([['a', 1]]);
	map.property = 2;

	t.deepEqual(await pMapKeyed(map, value => value), new Map([['a', 1]]));
});

test('pMapKeyed - reads a `Map` up front, so a later change does not affect the result', async t => {
	const map = new Map([['a', 1], ['b', 2]]);
	const promise = pMapKeyed(map, async value => {
		await delay(10);
		return value;
	}, {concurrency: 1});

	map.set('c', 3);
	map.delete('b');

	t.deepEqual(await promise, new Map([['a', 1], ['b', 2]]));
});

test('pMapKeyed - `pMapStop` keeps the keys of a `Map` before it', async t => {
	const result = await pMapKeyed(new Map([['a', 1], ['b', 2], ['c', 3]]), value => (value === 2 ? pMapStop : value));
	t.deepEqual(result, new Map([['a', 1]]));
});

test('pMapKeyed - empty `Map`', async t => {
	t.deepEqual(await pMapKeyed(new Map(), value => value), new Map());
});

test('pMapKeyed - empty object', async t => {
	const result = await pMapKeyed({}, value => value);

	t.is(Object.getPrototypeOf(result), null);
	t.deepEqual(Reflect.ownKeys(result), []);
});

test('pMapSettledKeyed - settles each key into a null-prototype object', async t => {
	const symbol = Symbol('symbol');
	const valueError = new Error('value');
	const mapperError = new Error('mapper');
	const mappedKeys = [];

	const result = await pMapSettledKeyed({
		a: 1,
		b: Promise.reject(valueError),
		c: 3,
		[symbol]: Promise.resolve(4),
	}, async (value, key) => {
		mappedKeys.push(key);

		if (key === 'c') {
			throw mapperError;
		}

		return value * 10;
	}, {concurrency: 1});

	t.is(Object.getPrototypeOf(result), null);
	t.deepEqual(Reflect.ownKeys(result), ['a', 'b', 'c', symbol]);
	t.deepEqual(result, {
		a: fulfilled(10),
		b: rejected(valueError),
		c: rejected(mapperError),
		[symbol]: fulfilled(40),
	});
	t.deepEqual(mappedKeys, ['a', 'c', symbol]);
});

test('pMapSettledKeyed - settles each key of a `Map` into a `Map`', async t => {
	const valueError = new Error('value');
	const mapperError = new Error('mapper');

	const result = await pMapSettledKeyed(new Map([
		['a', 1],
		['b', Promise.reject(valueError)],
		['c', 3],
	]), (value, key) => {
		if (key === 'c') {
			throw mapperError;
		}

		return value;
	}, {concurrency: 1});

	t.deepEqual(result, new Map([['a', fulfilled(1)], ['b', rejected(valueError)], ['c', rejected(mapperError)]]));
});

test('pMapSettledKeyed - keeps a mapper error that is `undefined`', async t => {
	// Thrown through a variable so the intent is not a bare `throw undefined`.
	const thrown = undefined;

	t.deepEqual(await pMapSettledKeyed({a: 1}, async () => {
		throw thrown;
	}), {a: rejected(thrown)});
});

test('pMapSettledKeyed - `pMapSkip` and `pMapStop`', async t => {
	const error = new Error('b');

	const result = await pMapSettledKeyed({a: 1, b: 2, c: 3, d: 4, e: 5}, (value, key) => {
		if (key === 'a') {
			return pMapSkip;
		}

		if (key === 'b') {
			throw error;
		}

		return key === 'd' ? pMapStop : value;
	}, {concurrency: 1});

	t.deepEqual(result, {b: rejected(error), c: fulfilled(3)});
});

//
// More pMap and pMapSettled tests
//

// A promise with its `resolve` and `reject` exposed, so the test decides when it settles.
function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolve_, reject_) => {
		resolve = resolve_;
		reject = reject_;
	});

	return {promise, resolve, reject};
}

// Resolve with `value` after `count` microtask hops. It orders work without timers, so the order is the same on every run.
async function afterMicrotasks(value, count) {
	for (let step = 0; step < count; step++) {
		await Promise.resolve(); // eslint-disable-line no-await-in-loop
	}

	return value;
}

// The reason a promise rejects with. `t.throwsAsync` only accepts an `Error`, so it cannot check a reason like a string or a symbol.
async function getRejectionReason(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}

	throw new Error('Expected the promise to reject');
}

// A Park-Miller random number generator, so a seed always gives the same numbers. It returns an integer from 0 up to `limit`, not including `limit`.
function createSeededRandom(seed) {
	let state = seed;

	return limit => {
		state = (state * 16_807) % 2_147_483_647;
		return state % limit;
	};
}

// Run `callback` and collect the unhandled rejections it causes. Only for `test.serial`, as the handler is process-wide.
async function collectUnhandledRejections(callback) {
	const unhandledRejections = [];
	const onUnhandledRejection = reason => {
		unhandledRejections.push(reason);
	};

	process.on('unhandledRejection', onUnhandledRejection);

	try {
		await callback();
		await delay(10);
		await drainEventLoop();
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	return unhandledRejections;
}

test('pMap - with `concurrency: 1`, pulls the next element only after the previous mapper settles', async t => {
	const source = countingSource();
	const {mapper: gated, release} = gatedMapper();
	const started = [];

	const promise = pMap(source, value => {
		if (value === 3) {
			return pMapStop;
		}

		started.push(value);
		return gated(value);
	}, {concurrency: 1});

	await drainEventLoop();
	t.deepEqual(started, [0]);
	t.is(source.pulls, 1);

	release(0);
	await drainEventLoop();
	t.deepEqual(started, [0, 1]);
	t.is(source.pulls, 2);

	release(1);
	await drainEventLoop();
	t.deepEqual(started, [0, 1, 2]);
	t.is(source.pulls, 3);

	release(2);
	t.deepEqual(await promise, [0, 1, 2]);
	t.is(source.pulls, 4);
	t.is(source.returnCalls, 1);
});

test('pMap - a finite concurrency starts exactly that many mappers, and each freed slot starts the next element in input order', async t => {
	const source = countingSource();
	const {mapper: gated, release} = gatedMapper();
	const started = [];

	const promise = pMap(source, value => {
		if (value === 5) {
			return pMapStop;
		}

		started.push(value);
		return gated(value);
	}, {concurrency: 3});

	await drainEventLoop();
	t.deepEqual(started, [0, 1, 2]);
	t.is(source.pulls, 3);

	// The slots are freed out of input order, and the next element still goes to whichever slot is free.
	release(2);
	await drainEventLoop();
	t.deepEqual(started, [0, 1, 2, 3]);
	t.is(source.pulls, 4);

	release(0);
	await drainEventLoop();
	t.deepEqual(started, [0, 1, 2, 3, 4]);
	t.is(source.pulls, 5);

	// The freed slot pulls the element that stops, and nothing after it, although two slots are free by then.
	release(4);
	await drainEventLoop();
	t.is(source.pulls, 6);

	release(3);
	release(1);
	t.deepEqual(await promise, [0, 1, 2, 3, 4]);
	t.is(source.pulls, 6);
	t.is(source.returnCalls, 1);
});

test('pMap - an element that is still resolving holds its concurrency slot', async t => {
	const firstElement = createDeferred();
	let pulls = 0;

	function * source() {
		pulls++;
		yield firstElement.promise;
		pulls++;
		yield 'b';
		pulls++;
		yield 'c';
	}

	const mappedValues = [];
	const promise = pMap(source(), value => {
		mappedValues.push(value);
		return value.toUpperCase();
	}, {concurrency: 1});

	await drainEventLoop();
	t.deepEqual(mappedValues, []);
	t.is(pulls, 1);

	firstElement.resolve('a');
	t.deepEqual(await promise, ['A', 'B', 'C']);
	t.deepEqual(mappedValues, ['a', 'b', 'c']);
});

test('pMap - calls the mapper as each element resolves, with its input index', async t => {
	const elements = [createDeferred(), createDeferred(), createDeferred()];
	const calls = [];

	const promise = pMap(elements.map(element => element.promise), (value, index) => {
		calls.push([value, index]);
		return `${value}${index}`;
	});

	await drainEventLoop();
	t.deepEqual(calls, []);

	elements[2].resolve('c');
	await drainEventLoop();
	elements[0].resolve('a');
	await drainEventLoop();
	elements[1].resolve('b');

	t.deepEqual(await promise, ['a0', 'b1', 'c2']);
	t.deepEqual(calls, [['c', 2], ['a', 0], ['b', 1]]);
});

test('pMap - calls the mapper with only the element and its index', async t => {
	t.deepEqual(await pMap(['a', 'b'], (...arguments_) => arguments_), [['a', 0], ['b', 1]]);

	// The index is the second argument, so a function like `parseInt` reads it as the radix, as with `Array#map`.
	t.deepEqual(await pMap(['10', '10', '10'], Number.parseInt), ['10', '10', '10'].map(Number.parseInt)); // eslint-disable-line unicorn/no-array-callback-reference
});

test('pMap - with infinite concurrency, starts the mapper of every element of an async source before any of them settles', async t => {
	async function * source() {
		for (let index = 0; index < 5; index++) {
			yield index;
		}
	}

	const {mapper: gated, release} = gatedMapper();
	const started = [];

	const promise = pMap(source(), value => {
		started.push(value);
		return gated(value);
	});

	await drainEventLoop();
	t.deepEqual(started, [0, 1, 2, 3, 4]);

	for (const value of [4, 3, 2, 1, 0]) {
		release(value);
	}

	t.deepEqual(await promise, [0, 1, 2, 3, 4]);
});

test('pMap - `stopOnError: true` rejects with the first error in time, like `Promise.all`', async t => {
	const results = [createDeferred(), createDeferred(), createDeferred()];
	const promise = pMap([0, 1, 2], (value, index) => results[index].promise, {concurrency: 3});

	await drainEventLoop();

	const laterElementError = new Error('later element');
	results[2].reject(laterElementError);
	const error = await t.throwsAsync(promise);
	t.is(error, laterElementError);

	// The earlier element failing afterwards does not change the rejection.
	results[0].reject(new Error('earlier element'));
	results[1].resolve();
	await drainEventLoop();
});

test('pMap - after a rejection, a mapper that settles later does not pull more input, and the source is closed once', async t => {
	const source = countingSource();
	const results = new Map();

	const promise = pMap(source, value => {
		const result = createDeferred();
		results.set(value, result);
		return result.promise;
	}, {concurrency: 2});

	await drainEventLoop();
	t.is(source.pulls, 2);

	results.get(0).reject(new Error('first'));
	await t.throwsAsync(promise, {message: 'first'});
	t.is(source.returnCalls, 1);

	results.get(1).resolve(1);
	await drainEventLoop();
	t.is(source.pulls, 2);
	t.is(source.returnCalls, 1);
});

test('pMap - `stopOnError: false` reports element errors and mapper errors together, in input order', async t => {
	const element = createDeferred();
	const mapperGate = createDeferred();

	const promise = pMap([0, element.promise, 2, 3], async value => {
		if (value === 0) {
			await mapperGate.promise;
			throw new Error('mapper 0');
		}

		if (value === 3) {
			throw new Error('mapper 3');
		}

		return value;
	}, {concurrency: 4, stopOnError: false});

	// The errors settle in the order 3, 0, 1.
	await drainEventLoop();
	mapperGate.resolve();
	await drainEventLoop();
	element.reject(new Error('element 1'));

	const error = await t.throwsAsync(promise, {instanceOf: AggregateError});
	t.deepEqual(error.errors.map(({message}) => message), ['mapper 0', 'element 1', 'mapper 3']);
});

test('pMap - `stopOnError: false` with `concurrency: 1` still maps every element after an error', async t => {
	const mappedValues = [];

	const error = await t.throwsAsync(pMap([0, 1, 2, 3, 4], value => {
		mappedValues.push(value);

		if (value % 2 === 0) {
			throw new Error(`error ${value}`);
		}

		return value;
	}, {concurrency: 1, stopOnError: false}), {instanceOf: AggregateError});

	t.deepEqual(mappedValues, [0, 1, 2, 3, 4]);
	t.deepEqual(error.errors.map(({message}) => message), ['error 0', 'error 2', 'error 4']);
});

test('pMap - `stopOnError: false` with skips and a stop around the errors', async t => {
	// Not `async`, so the mapper can return a promise of `pMapSkip` and a rejected promise as they are.
	const mapper = value => {
		switch (value) {
			case 'skip promise': {
				return Promise.resolve(pMapSkip);
			}

			case 'skip': {
				return pMapSkip;
			}

			case 'stop': {
				return pMapStop;
			}

			case 'after the stop': {
				throw new Error('after the stop');
			}

			default: {
				return value.startsWith('error') ? Promise.reject(new Error(value)) : value;
			}
		}
	};

	const error = await t.throwsAsync(pMap(['skip promise', 'error 1', 'skip', 'error 3', 'value', 'stop', 'after the stop'], mapper, {stopOnError: false}), {instanceOf: AggregateError});
	t.deepEqual(error.errors.map(({message}) => message), ['error 1', 'error 3']);

	t.deepEqual(await pMap(['skip promise', 'a', 'skip', 'b', 'stop', 'after the stop'], mapper, {stopOnError: false}), ['a', 'b']);
});

test('pMap - throwing `pMapSkip` or `pMapStop` is an error, not a skip or a stop', async t => {
	for (const sentinel of [pMapSkip, pMapStop]) {
		const mappedValues = [];

		// eslint-disable-next-line no-await-in-loop
		const reason = await getRejectionReason(pMap([1, 2, 3], value => {
			mappedValues.push(value);

			if (value === 2) {
				throw sentinel;
			}

			return value;
		}, {concurrency: 1}));

		t.is(reason, sentinel);
		t.deepEqual(mappedValues, [1, 2]);
	}
});

test('pMap - rejects with a value that is not an `Error` as is', async t => {
	const reasons = ['text', 42, {code: 'E_CUSTOM'}, Symbol('reason'), undefined, null];

	for (const reason of reasons) {
		// eslint-disable-next-line no-await-in-loop
		t.is(await getRejectionReason(pMap([1], () => {
			throw reason;
		})), reason);

		// eslint-disable-next-line no-await-in-loop
		t.is(await getRejectionReason(pMap([1], () => Promise.reject(reason))), reason);

		// eslint-disable-next-line no-await-in-loop
		t.is(await getRejectionReason(pMap([Promise.reject(reason)], value => value)), reason);
	}

	const error = await t.throwsAsync(pMap(reasons, value => {
		throw value;
	}, {stopOnError: false}), {instanceOf: AggregateError});

	t.is(error.errors.length, reasons.length);

	for (const [index, reason] of reasons.entries()) {
		t.is(error.errors[index], reason);
	}
});

test('pMap - a mapper that throws synchronously rejects the promise, and `pMap` itself does not throw', async t => {
	const error = new Error('sync');
	let promise;

	t.notThrows(() => {
		promise = pMap([1, 2], value => {
			if (value === 1) {
				throw error;
			}

			return value;
		});
	});

	t.is(await t.throwsAsync(promise), error);
});

test('pMap - awaits a thenable element and a thenable mapper result', async t => {
	let thenCalls = 0;
	const createThenable = value => ({
		then(resolve) { // eslint-disable-line unicorn/no-thenable
			thenCalls++;
			setTimeout(() => {
				resolve(value);
			});
		},
	});

	t.deepEqual(await pMap([createThenable('a'), 'b'], value => createThenable(value.toUpperCase()), {concurrency: 1}), ['A', 'B']);
	t.is(thenCalls, 3);

	const brokenThenable = {
		then() { // eslint-disable-line unicorn/no-thenable
			throw new Error('then failed');
		},
	};

	await t.throwsAsync(pMap([brokenThenable], value => value), {message: 'then failed'});
	await t.throwsAsync(pMap([1], () => brokenThenable), {message: 'then failed'});
});

test('pMap - maps a sparse array into a dense array, with `undefined` for the holes', async t => {
	const sparse = [];
	sparse[0] = 'a';
	sparse[2] = 'c';
	sparse.length = 4;

	const indexes = [];
	const result = await pMap(sparse, (value, index) => {
		indexes.push(index);
		return value;
	}, {concurrency: 2});

	t.deepEqual(result, ['a', undefined, 'c', undefined]);
	t.is(Object.keys(result).length, 4);
	t.deepEqual(indexes, [0, 1, 2, 3]);
});

test('pMap - maps other built-in iterables', async t => {
	const identity = value => value;

	// A string is iterated by code point, so a character outside the Basic Multilingual Plane is one element.
	t.deepEqual(await pMap('a😀b', identity), ['a', '😀', 'b']);
	t.deepEqual(await pMap(new Uint8Array([1, 2, 255]), value => value + 1), [2, 3, 256]);
	t.deepEqual(await pMap(new Map([['a', 1], ['b', 2]]).keys(), identity), ['a', 'b']);
	t.deepEqual(await pMap(new Set(['x', 'y']).entries(), identity), [['x', 'x'], ['y', 'y']]);
	t.deepEqual(await pMap(['x', 'y'].entries(), identity, {concurrency: 1}), [[0, 'x'], [1, 'y']]);
});

test('pMap - ignores the return value of a generator, like `for...of`', async t => {
	function * syncSource() {
		yield 1;
		yield 2;
		return 3;
	}

	async function * asyncSource() {
		yield 1;
		yield 2;
		return 3;
	}

	t.deepEqual(await pMap(syncSource(), value => value * 10, {concurrency: 2}), [10, 20]);
	t.deepEqual(await pMap(asyncSource(), value => value * 10, {concurrency: 2}), [10, 20]);
	t.deepEqual(await pMapSettled(syncSource(), value => value * 10), [fulfilled(10), fulfilled(20)]);
});

test('pMap - maps an async source whose `next()` returns thenables that are not promises', async t => {
	let index = 0;

	const source = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					const result = index < 3 ? {done: false, value: index++} : {done: true, value: undefined};

					return {
						then(resolve) { // eslint-disable-line unicorn/no-thenable
							resolve(result);
						},
					};
				},
			};
		},
	};

	t.deepEqual(await pMap(source, value => value * 2, {concurrency: 2}), [0, 2, 4]);
});

test('pMap - rejects instead of hanging when the source `next()` returns something that is not an object', async t => {
	for (const result of [undefined, null]) {
		const source = {
			[Symbol.iterator]() {
				return {
					next: () => result,
				};
			},
		};

		// eslint-disable-next-line no-await-in-loop
		await t.throwsAsync(pMap(source, value => value), {instanceOf: TypeError});
	}
});

test('pMap - maps 100k elements with a sync mapper and the default concurrency', async t => {
	const length = 100_000;
	const result = await pMap(Array.from({length}, (_, index) => index), value => value * 2);

	t.is(result.length, length);
	t.is(result[12_345], 24_690);
	t.is(result.at(-1), (length - 1) * 2);
});

test('pMap - maps a 100k element sync generator where most results are skipped', async t => {
	function * source() {
		for (let index = 0; index < 100_000; index++) {
			yield index;
		}
	}

	const result = await pMap(source(), value => (value % 1000 === 0 ? value : pMapSkip), {concurrency: 3});
	t.deepEqual(result, Array.from({length: 100}, (_, index) => index * 1000));
});

test('pMap - an endless sync source with the default concurrency stops when the first mapper throws', async t => {
	const source = countingSource();

	await t.throwsAsync(pMap(source, value => {
		if (value === 0) {
			throw new Error('first');
		}

		return value;
	}), {message: 'first'});

	const {pulls} = source;
	t.true(pulls < 20, `pulled ${pulls} items`);
	t.is(source.returnCalls, 1);

	await drainEventLoop();
	t.is(source.pulls, pulls);
});

test('pMap - rejects invalid `concurrency` values with a message that names the value', async t => {
	const message = description => `Expected \`concurrency\` to be an integer from 1 and up or \`Infinity\`, got ${description}`;

	for (const [concurrency, description] of [
		[0, '`0` (number)'],
		[-1, '`-1` (number)'],
		[1.5, '`1.5` (number)'],
		[Number.NaN, '`NaN` (number)'],
		[Number.NEGATIVE_INFINITY, '`-Infinity` (number)'],
		[Number.MAX_SAFE_INTEGER + 1, '`9007199254740992` (number)'],
		['2', '`2` (string)'],
		[null, '`null` (object)'],
	]) {
		// eslint-disable-next-line no-await-in-loop
		await t.throwsAsync(pMap([1], value => value, {concurrency}), {instanceOf: TypeError, message: message(description)});
		// eslint-disable-next-line no-await-in-loop
		await t.throwsAsync(pMapSettled([1], value => value, {concurrency}), {instanceOf: TypeError, message: message(description)});
	}

	t.deepEqual(await pMap([1, 2], value => value, {concurrency: Number.MAX_SAFE_INTEGER}), [1, 2]);
	t.deepEqual(await pMap([1, 2], value => value, {concurrency: undefined}), [1, 2]);
});

test('pMap - invalid arguments reject instead of throwing, and do not start iterating the input', async t => {
	let iteratorCalls = 0;
	const input = {
		[Symbol.iterator]() {
			iteratorCalls++;
			return [1][Symbol.iterator]();
		},
	};

	for (const [mapper, options, message] of [
		[undefined, undefined, 'Mapper function is required'],
		['not a function', undefined, 'Mapper function is required'],
		[value => value, {concurrency: 0}, /concurrency/],
	]) {
		for (const method of [pMap, pMapSettled]) {
			let promise;
			t.notThrows(() => {
				promise = method(input, mapper, options);
			});

			t.true(promise instanceof Promise);
			// eslint-disable-next-line no-await-in-loop
			await t.throwsAsync(promise, {instanceOf: TypeError, message});
		}
	}

	t.is(iteratorCalls, 0);
});

test('pMap - an already aborted signal does not pull from the source or call the mapper', async t => {
	for (const method of [pMap, pMapSettled]) {
		const source = countingSource();
		let mapperCalls = 0;

		// eslint-disable-next-line no-await-in-loop
		await t.throwsAsync(method(source, () => {
			mapperCalls++;
		}, {signal: AbortSignal.abort()}), {name: 'AbortError'});

		t.is(source.pulls, 0);
		t.is(mapperCalls, 0);
	}
});

test('pMap - rejects with an abort reason that is not an `Error` as is', async t => {
	const reason = {code: 'CANCELED'};
	const abortController = new AbortController();
	const never = () => new Promise(() => {});

	const runs = [pMap([1, 2], never, {signal: abortController.signal}), pMapSettled([1, 2], never, {signal: abortController.signal})];
	await drainEventLoop();
	abortController.abort(reason);

	for (const run of runs) {
		// eslint-disable-next-line no-await-in-loop
		t.is(await getRejectionReason(run), reason);
	}

	t.is(await getRejectionReason(pMap([1], value => value, {signal: AbortSignal.abort('already')})), 'already');
});

test('pMap - a mapper that aborts the signal stops the run at once', async t => {
	const abortController = new AbortController();
	const source = countingSource();
	const mappedValues = [];

	await t.throwsAsync(pMap(source, value => {
		mappedValues.push(value);

		if (value === 2) {
			abortController.abort(new Error('found it'));
		}

		return value;
	}, {concurrency: 1, signal: abortController.signal}), {message: 'found it'});

	await drainEventLoop();
	t.deepEqual(mappedValues, [0, 1, 2]);
	t.is(source.pulls, 3);
	t.is(source.returnCalls, 1);
});

test('pMap - one signal shared by concurrent runs aborts all of them with the same reason', async t => {
	const abortController = new AbortController();
	const {signal} = abortController;
	const reason = new Error('shutdown');
	const never = () => new Promise(() => {});

	const runs = [
		pMap([1], never, {signal}),
		pMapSettled([1], never, {signal}),
		pMap([1, 2], never, {concurrency: 1, signal}),
	];

	await drainEventLoop();
	t.is(abortListenerCount(signal), 3);

	abortController.abort(reason);

	for (const run of runs) {
		// eslint-disable-next-line no-await-in-loop
		t.is(await getRejectionReason(run), reason);
	}

	t.is(abortListenerCount(signal), 0);
});

test('pMap - sequential runs that share a signal never leave an abort listener behind, whichever way they settle', async t => {
	const {signal} = new AbortController();

	const runs = [
		() => pMap([1, 2], value => value, {signal}),
		() => pMap([1, pMapSkip], value => value, {signal}),
		() => pMap([1, 2, 3], value => (value === 2 ? pMapStop : value), {signal}),
		() => pMapSettled([1], () => {
			throw new Error('settled');
		}, {signal}),
		() => pMap([1], () => {
			throw new Error('rejected');
		}, {signal}),
		() => pMap([1, 2], () => {
			throw new Error('aggregate');
		}, {signal, stopOnError: false}),
		() => pMap(new ThrowingIterator(5, 1), value => value, {signal}),
	];

	for (let round = 0; round < 3; round++) {
		for (const run of runs) {
			const promise = run();
			t.is(abortListenerCount(signal), 1);
			await promise.catch(() => {}); // eslint-disable-line no-await-in-loop
			t.is(abortListenerCount(signal), 0);
		}
	}
});

test('pMap - rejects when an `AbortSignal.timeout()` fires', async t => {
	await t.throwsAsync(pMap([1, 2], () => delay(500), {signal: AbortSignal.timeout(20)}), {name: 'TimeoutError'});
});

test.serial('pMap - elements and mappers that reject after the run has rejected are not unhandled rejections', async t => {
	const unhandledRejections = await collectUnhandledRejections(async () => {
		// Rejected by an abort while the elements are still pending.
		const abortedElements = [createDeferred(), createDeferred()];
		const abortController = new AbortController();
		const abortedRun = pMap(abortedElements.map(element => element.promise), value => value, {signal: abortController.signal});
		await drainEventLoop();
		abortController.abort();
		await t.throwsAsync(abortedRun, {name: 'AbortError'});

		for (const element of abortedElements) {
			element.reject(new Error('element after the abort'));
		}

		// Rejected by a mapper error while other elements and mappers are still pending.
		const pendingElement = createDeferred();
		const pendingMapper = createDeferred();
		const firstMapperGate = createDeferred();
		const failedRun = pMap([0, 1, pendingElement.promise], async value => {
			if (value === 0) {
				await firstMapperGate.promise;
				throw new Error('first');
			}

			return pendingMapper.promise;
		});

		// Every element is reached before the first mapper throws.
		await drainEventLoop();
		firstMapperGate.resolve();
		await t.throwsAsync(failedRun, {message: 'first'});
		pendingElement.reject(new Error('element after the error'));
		pendingMapper.reject(new Error('mapper after the error'));
	});

	t.deepEqual(unhandledRejections, []);
});

test('pMap - maps a Node.js readable stream, and destroys it when a mapper throws', async t => {
	t.deepEqual(await pMap(Readable.from(['a', 'b', 'c']), async value => value.toUpperCase(), {concurrency: 2}), ['A', 'B', 'C']);

	const stream = Readable.from(['a', 'b', 'c', 'd']);
	await t.throwsAsync(pMap(stream, value => {
		if (value === 'b') {
			throw new Error('mapper');
		}

		return value;
	}, {concurrency: 1}), {message: 'mapper'});

	await drainEventLoop();
	t.true(stream.destroyed);
});

test('pMapSettled - throwing `pMapSkip` or `pMapStop`, or an element that rejects with one, gives a rejected result', async t => {
	const skip = pMapSkip;
	const stop = pMapStop;
	const mappedValues = [];

	const results = await pMapSettled([1, 2, Promise.reject(stop), 4], value => {
		mappedValues.push(value);

		if (value === 1) {
			throw skip;
		}

		if (value === 2) {
			throw stop;
		}

		return value;
	});

	t.deepEqual(results, [rejected(pMapSkip), rejected(pMapStop), rejected(pMapStop), fulfilled(4)]);
	t.deepEqual(mappedValues, [1, 2, 4]);
});

test('pMapSettled - keeps reasons that are not an `Error` as they are, from the mapper and from the input', async t => {
	const reasonObject = {code: 'E_OBJECT'};
	const reasons = ['text', 0, reasonObject, null];

	const results = await pMapSettled([...reasons, Promise.reject(reasonObject)], value => {
		throw value;
	});

	t.deepEqual(results, [...reasons, reasonObject].map(reason => rejected(reason)));
	t.is(results[2].reason, reasonObject);
	t.is(results[4].reason, reasonObject);
});

test('pMapSettled - a sync throw and a rejected promise from the mapper both give a rejected result, and the run goes on', async t => {
	const syncError = new Error('sync');
	const asyncError = new Error('async');

	const results = await pMapSettled([0, 1, 2], value => {
		if (value === 0) {
			throw syncError;
		}

		if (value === 1) {
			return Promise.reject(asyncError);
		}

		return value;
	}, {concurrency: 1});

	t.deepEqual(results, [rejected(syncError), rejected(asyncError), fulfilled(2)]);
});

test('pMapSettled - settles thenable elements and thenable mapper results', async t => {
	const thenableError = new Error('thenable');
	const resolvingThenable = value => ({
		then(resolve) { // eslint-disable-line unicorn/no-thenable
			resolve(value);
		},
	});
	const rejectingThenable = {
		then(resolve, reject) { // eslint-disable-line unicorn/no-thenable
			reject(thenableError);
		},
	};

	const results = await pMapSettled([resolvingThenable(1), rejectingThenable, 3, 4], value => (value === 3 ? rejectingThenable : resolvingThenable(value * 10)), {concurrency: 2});
	t.deepEqual(results, [fulfilled(10), rejected(thenableError), rejected(thenableError), fulfilled(40)]);
});

test('pMapSettled - reads the source to its end, and does not close it, when every mapper fails', async t => {
	let returnCalls = 0;
	let nextCalls = 0;

	const source = {
		[Symbol.iterator]() {
			let index = 0;
			return {
				next() {
					nextCalls++;
					return {done: index === 4, value: index++};
				},
				return() {
					returnCalls++;
					return {done: true, value: undefined};
				},
			};
		},
	};

	const results = await pMapSettled(source, value => {
		throw new Error(`error ${value}`);
	}, {concurrency: 2});

	t.deepEqual(results.map(result => result.reason.message), ['error 0', 'error 1', 'error 2', 'error 3']);
	t.is(nextCalls, 5);
	t.is(returnCalls, 0);
});

test('pMapSettled - `pMapStop` stops pulling, and closes the source once', async t => {
	const source = countingSource();
	const error = new Error('one');

	const results = await pMapSettled(source, value => {
		if (value === 1) {
			throw error;
		}

		return value === 3 ? pMapStop : value;
	}, {concurrency: 1});

	t.deepEqual(results, [fulfilled(0), rejected(error), fulfilled(2)]);
	t.is(source.pulls, 4);
	t.is(source.returnCalls, 1);

	await drainEventLoop();
	t.is(source.pulls, 4);
});

test('pMapSettled - rejects when an async source rejects, even after rejected results', async t => {
	const mappedValues = [];

	async function * source() {
		yield 1;
		yield 2;
		throw new Error('source failed');
	}

	await t.throwsAsync(pMapSettled(source(), value => {
		mappedValues.push(value);
		throw new Error('mapper');
	}, {concurrency: 1}), {message: 'source failed'});

	t.deepEqual(mappedValues, [1, 2]);
});

test('pMapSettled - settles 100k elements with the default concurrency', async t => {
	const length = 100_000;
	const error = new Error('every 10000th');

	const results = await pMapSettled(Array.from({length}, (_, index) => index), value => {
		if (value % 10_000 === 0) {
			throw error;
		}

		return value;
	});

	t.is(results.length, length);
	t.deepEqual(results[0], rejected(error));
	t.deepEqual(results[1], fulfilled(1));
	t.deepEqual(results.at(-1), fulfilled(length - 1));
	t.is(results.filter(result => result.status === 'rejected').length, 10);
});

// Random plans for the element and the mapper of each position, from a seed, so a failure always reproduces. The timing comes from microtask hops, not timers, so it is the same on every run.
function createRandomPlans(seed) {
	const random = createSeededRandom(seed);
	const kinds = ['value', 'promise', 'rejectedElement', 'mapperThrows', 'mapperRejects', 'thenable'];

	return Array.from({length: 1 + random(30)}, (_, index) => ({
		kind: kinds[random(kinds.length)],
		reason: random(4) === 0 ? `reason ${index}` : new Error(`reason ${index}`),
		elementHops: random(6),
		mapperHops: random(6),
		pullHops: random(6),
	}));
}

// Create each element only when it is pulled, as an element that rejects before it is reached is a documented unhandled rejection.
function createRandomPlanElement(plans, index) {
	const plan = plans[index];

	if (plan.kind === 'rejectedElement') {
		return afterMicrotasks(undefined, plan.elementHops).then(() => {
			throw plan.reason;
		});
	}

	return plan.kind === 'promise' ? afterMicrotasks(index, plan.elementHops) : index;
}

function * randomPlansSource(plans) {
	for (const index of plans.keys()) {
		yield createRandomPlanElement(plans, index);
	}
}

// An async source whose `next()` calls settle out of call order, after a random number of microtask hops each.
function randomPlansAsyncSource(plans) {
	let pullIndex = 0;

	return {
		[Symbol.asyncIterator]() {
			return {
				next() {
					const index = pullIndex++;

					if (index >= plans.length) {
						return Promise.resolve({done: true, value: undefined});
					}

					return afterMicrotasks(undefined, plans[index].pullHops).then(() => ({done: false, value: createRandomPlanElement(plans, index)}));
				},
			};
		},
	};
}

// Not `async`, so a mapper can throw synchronously as well as return a promise that rejects later.
function createRandomPlansMapper(plans) {
	return (value, index) => {
		const plan = plans[index];

		if (value !== index) {
			throw new Error(`The mapper got ${value} for index ${index}`);
		}

		if (plan.kind === 'mapperThrows') {
			throw plan.reason;
		}

		const result = afterMicrotasks(value * 2, plan.mapperHops);

		if (plan.kind === 'mapperRejects') {
			return result.then(() => {
				throw plan.reason;
			});
		}

		if (plan.kind === 'thenable') {
			return {
				then(resolve) { // eslint-disable-line unicorn/no-thenable
					result.then(resolve);
				},
			};
		}

		return result;
	};
}

const settleRandomPlansNatively = plans => {
	const mapper = createRandomPlansMapper(plans);
	return Promise.allSettled(Array.from(randomPlansSource(plans), (element, index) => Promise.resolve(element).then(value => mapper(value, index))));
};

const randomPlanSeeds = [1, 7, 42, 1337, 2024, 65_535, 123_456_789];
const randomPlanConcurrencies = [1, 2, 3, 7, Number.POSITIVE_INFINITY];

test('pMapSettled - matches `Promise.allSettled` for random inputs and concurrencies', async t => {
	for (const seed of randomPlanSeeds) {
		const plans = createRandomPlans(seed);
		const expected = await settleRandomPlansNatively(plans); // eslint-disable-line no-await-in-loop
		const expectedReasons = expected.map(result => result.reason);

		for (const concurrency of randomPlanConcurrencies) {
			for (const source of [randomPlansSource(plans), randomPlansAsyncSource(plans)]) {
				const message = `seed ${seed}, concurrency ${concurrency}`;
				const results = await pMapSettled(source, createRandomPlansMapper(plans), {concurrency}); // eslint-disable-line no-await-in-loop
				t.deepEqual(results, expected, message);

				// The same reason objects, not only equal ones.
				t.true(results.every((result, index) => result.reason === expectedReasons[index]), message);
			}
		}
	}
});

test('pMap - with `stopOnError: false`, agrees with `Promise.allSettled` for random inputs and concurrencies', async t => {
	for (const seed of randomPlanSeeds) {
		const plans = createRandomPlans(seed);
		const expected = await settleRandomPlansNatively(plans); // eslint-disable-line no-await-in-loop
		const expectedReasons = expected.filter(result => result.status === 'rejected').map(result => result.reason);

		for (const concurrency of randomPlanConcurrencies) {
			for (const source of [randomPlansSource(plans), randomPlansAsyncSource(plans)]) {
				const message = `seed ${seed}, concurrency ${concurrency}`;
				const promise = pMap(source, createRandomPlansMapper(plans), {concurrency, stopOnError: false});

				if (expectedReasons.length === 0) {
					t.deepEqual(await promise, expected.map(result => result.value), message); // eslint-disable-line no-await-in-loop
					continue;
				}

				const error = await t.throwsAsync(promise, {instanceOf: AggregateError}, message); // eslint-disable-line no-await-in-loop
				t.is(error.errors.length, expectedReasons.length, message);

				for (const [index, reason] of expectedReasons.entries()) {
					t.is(error.errors[index], reason, message);
				}
			}
		}
	}
});

//
// More pMapIterable tests
//

// An async source whose `next()` calls each wait for the test to settle them, through `source.pulls[n]`, so the test sees exactly when each element is read.
function manualSource() {
	const source = {
		pulls: [],
		returnCalls: 0,
		[Symbol.asyncIterator]() {
			return {
				next() {
					const pull = createDeferred();
					source.pulls.push(pull);
					return pull.promise;
				},
				return() {
					source.returnCalls++;
					return Promise.resolve({done: true, value: undefined});
				},
			};
		},
	};

	return source;
}

function * range(length) {
	for (let index = 0; index < length; index++) {
		yield index;
	}
}

test('pMapIterable - does not open or read the input until the first `next()`', async t => {
	let openCount = 0;
	let pulls = 0;

	const input = {
		[Symbol.iterator]() {
			openCount++;
			let index = 0;
			return {
				next() {
					pulls++;
					return index < 3 ? {done: false, value: index++} : {done: true, value: undefined};
				},
			};
		},
	};

	const iterator = pMapIterable(input, async value => value, {concurrency: 2})[Symbol.asyncIterator]();
	await drainEventLoop();

	t.is(openCount, 0);
	t.is(pulls, 0);

	t.deepEqual(await iterator.next(), {done: false, value: 0});
	t.is(openCount, 1);
	t.deepEqual(await collectAsyncIterable(iterator), [1, 2]);
});

test('pMapIterable - `return()` before the first `next()` never opens the input', async t => {
	let openCount = 0;
	let mapperCalls = 0;

	const input = {
		[Symbol.iterator]() {
			openCount++;
			return [1, 2, 3][Symbol.iterator]();
		},
	};

	const iterator = pMapIterable(input, value => {
		mapperCalls++;
		return value;
	})[Symbol.asyncIterator]();

	t.deepEqual(await iterator.return('early'), {done: true, value: 'early'});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
	await drainEventLoop();

	t.is(openCount, 0);
	t.is(mapperCalls, 0);
});

test('pMapIterable - `throw()` before the first `next()` rejects without opening the input', async t => {
	let openCount = 0;

	const input = {
		[Symbol.iterator]() {
			openCount++;
			return [1, 2, 3][Symbol.iterator]();
		},
	};

	const iterator = pMapIterable(input, value => value)[Symbol.asyncIterator]();

	await t.throwsAsync(iterator.throw(new Error('early')), {message: 'early'});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
	t.is(openCount, 0);
});

test('pMapIterable - an input whose iterator method throws rejects the first `next()`', async t => {
	let mapperCalls = 0;

	const input = {
		[Symbol.asyncIterator]() {
			throw new Error('cannot open');
		},
	};

	const iterator = pMapIterable(input, value => {
		mapperCalls++;
		return value;
	})[Symbol.asyncIterator]();

	await t.throwsAsync(iterator.next(), {message: 'cannot open'});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
	t.is(mapperCalls, 0);
});

test('pMapIterable - each `[Symbol.asyncIterator]()` call is an independent iteration with its own source iterator', async t => {
	let openCount = 0;

	const input = {
		[Symbol.iterator]() {
			openCount++;
			return [1, 2, 3][Symbol.iterator]();
		},
	};

	const iterable = pMapIterable(input, async value => value * 10, {concurrency: 1});
	const first = iterable[Symbol.asyncIterator]();
	const second = iterable[Symbol.asyncIterator]();
	t.not(first, second);

	// Stopping the first iteration early leaves the second one untouched.
	t.deepEqual(await first.next(), {done: false, value: 10});
	t.deepEqual(await first.return(), {done: true, value: undefined});
	t.deepEqual(await collectAsyncIterable(second), [10, 20, 30]);

	// And the iterable can be iterated again afterwards.
	t.deepEqual(await collectAsyncIterable(iterable), [10, 20, 30]);
	t.is(openCount, 3);
});

test('pMapIterable - a one-shot source is shared by every iteration of the result', async t => {
	function * source() {
		yield 1;
		yield 2;
		yield 3;
		yield 4;
	}

	let mapperCalls = 0;
	const mapper = async value => {
		mapperCalls++;
		return value;
	};

	// A generator object is its own iterator, so a second iteration continues where the first one left the generator.
	const exhausted = pMapIterable(source(), mapper, {concurrency: 1});
	t.deepEqual(await collectAsyncIterable(exhausted), [1, 2, 3, 4]);
	t.deepEqual(await collectAsyncIterable(exhausted), []);
	t.is(mapperCalls, 4);

	// Breaking out of the first iteration closes the generator, so nothing is left for the second one, even though the generator had more elements.
	const closed = pMapIterable(source(), mapper, {concurrency: 1});
	for await (const value of closed) { // eslint-disable-line no-unreachable-loop
		t.is(value, 1);
		break;
	}

	t.deepEqual(await collectAsyncIterable(closed), []);
});

test('pMapIterable - concurrent `next()` calls settle in call order with `preserveOrder`', async t => {
	const {mapper, release} = gatedMapper();
	const iterator = pMapIterable([0, 1, 2], mapper, {concurrency: 3})[Symbol.asyncIterator]();

	const settleOrder = [];
	const results = [iterator.next(), iterator.next(), iterator.next(), iterator.next()].map(async (promise, callIndex) => {
		const result = await promise;
		settleOrder.push(callIndex);
		return result;
	});

	await drainEventLoop();
	release(2);
	release(1);
	await drainEventLoop();

	// The later results are ready, but every call waits for the first element.
	t.deepEqual(settleOrder, []);

	release(0);
	t.deepEqual(await Promise.all(results), [
		{done: false, value: 0},
		{done: false, value: 1},
		{done: false, value: 2},
		{done: true, value: undefined},
	]);
	t.deepEqual(settleOrder, [0, 1, 2, 3]);
});

test('pMapIterable - concurrent `next()` calls with `preserveOrder: false` get the results in the order they settle', async t => {
	const {mapper, release} = gatedMapper();
	const iterator = pMapIterable(['a', 'b', 'c'], mapper, {concurrency: 3, preserveOrder: false})[Symbol.asyncIterator]();

	const results = [iterator.next(), iterator.next(), iterator.next(), iterator.next()];
	await drainEventLoop();

	release('b');
	t.deepEqual(await results[0], {done: false, value: 'b'});

	release('c');
	t.deepEqual(await results[1], {done: false, value: 'c'});

	release('a');
	t.deepEqual(await results[2], {done: false, value: 'a'});
	t.deepEqual(await results[3], {done: true, value: undefined});
});

test('pMapIterable - many concurrent `next()` calls do not read past `backpressure`', async t => {
	for (const preserveOrder of [true, false]) {
		const source = countingSource();
		const {mapper, release} = gatedMapper();
		const started = [];

		const iterator = pMapIterable(source, value => {
			started.push(value);
			return mapper(value);
		}, {concurrency: 2, backpressure: 2, preserveOrder})[Symbol.asyncIterator]();

		const results = Array.from({length: 10}, () => iterator.next());
		await drainEventLoop(); // eslint-disable-line no-await-in-loop

		// Ten requests for a result, but the stream still holds only `backpressure` elements.
		t.deepEqual(started, [0, 1]);
		t.is(source.pulls, 2);

		release(0);
		t.deepEqual(await results[0], {done: false, value: 0}); // eslint-disable-line no-await-in-loop
		await drainEventLoop(); // eslint-disable-line no-await-in-loop

		t.deepEqual(started, [0, 1, 2]);
		t.is(source.pulls, 3);

		const returned = iterator.return();
		release(1);
		release(2);
		await Promise.all([...results, returned]); // eslint-disable-line no-await-in-loop
		t.is(source.returnCalls, 1);
	}
});

test('pMapIterable - `return()` twice closes the source once, and passes its value through', async t => {
	const source = countingSource();
	const iterator = pMapIterable(source, async value => value, {concurrency: 2})[Symbol.asyncIterator]();

	t.deepEqual(await iterator.next(), {done: false, value: 0});
	t.deepEqual(await iterator.return('first'), {done: true, value: 'first'});
	t.deepEqual(await iterator.return('second'), {done: true, value: 'second'});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
	t.is(source.returnCalls, 1);
});

test('pMapIterable - `throw()` after a result closes the source once and stops all work', async t => {
	const source = countingSource();
	let mapperCalls = 0;

	const iterator = pMapIterable(source, async value => {
		mapperCalls++;
		return value;
	}, {concurrency: 2, backpressure: 4})[Symbol.asyncIterator]();

	t.deepEqual(await iterator.next(), {done: false, value: 0});
	await drainEventLoop();

	const error = new Error('consumer error');
	t.is(await t.throwsAsync(iterator.throw(error)), error);
	t.is(source.returnCalls, 1);

	const pullsAfterThrow = source.pulls;
	const mapperCallsAfterThrow = mapperCalls;
	await drainEventLoop();

	t.deepEqual(await iterator.next(), {done: true, value: undefined});
	t.is(source.pulls, pullsAfterThrow);
	t.is(mapperCalls, mapperCallsAfterThrow);
	t.is(source.returnCalls, 1);
});

// The same as for `return()`: the generator is suspended on the pending `next()`, so `throw()` has to stop the work before the generator gets to run its `finally`.
test('pMapIterable - `throw()` while a `next()` is pending does not map the elements waiting for a mapper', async t => {
	const source = countingSource();
	const {mapper, release} = gatedMapper();
	const started = [];

	const iterator = pMapIterable(source, value => {
		started.push(value);
		return mapper(value);
	}, {concurrency: 2, backpressure: 10})[Symbol.asyncIterator]();

	const pending = iterator.next();
	await drainEventLoop();

	// Two running mappers, and two elements read ahead that wait for a mapper.
	t.deepEqual(started, [0, 1]);
	t.is(source.pulls, 4);

	const error = new Error('consumer error');
	const thrown = iterator.throw(error);
	release(1);
	await drainEventLoop();

	// The freed mapper slot went to a waiting element, which was dropped instead of mapped, and nothing more was read.
	t.deepEqual(started, [0, 1]);
	t.is(source.pulls, 4);

	release(0);
	t.deepEqual(await pending, {done: false, value: 0});
	t.is(await t.throwsAsync(thrown), error);
	t.is(source.returnCalls, 1);
});

test('pMapIterable - with `preserveOrder: false`, a mapper error stops new work at once, while the consumer is busy', async t => {
	const source = countingSource();
	const {mapper, release} = gatedMapper();
	const started = [];

	const iterator = pMapIterable(source, async value => {
		started.push(value);
		await mapper(value);

		if (value === 1) {
			throw new Error('mapper error 1');
		}

		return value;
	}, {concurrency: 2, backpressure: 10, preserveOrder: false})[Symbol.asyncIterator]();

	const first = iterator.next();
	await drainEventLoop();
	t.deepEqual(started, [0, 1]);

	release(0);
	t.deepEqual(await first, {done: false, value: 0});
	await drainEventLoop();

	// The consumer holds the first result, and a waiting element took the freed mapper slot.
	t.deepEqual(started, [0, 1, 2]);
	const pullsBeforeError = source.pulls;

	// The error settles while nobody is asking for a result.
	release(1);
	await drainEventLoop();

	// The freed mapper slot is not used, and nothing more is read.
	t.deepEqual(started, [0, 1, 2]);
	t.is(source.pulls, pullsBeforeError);

	await t.throwsAsync(iterator.next(), {message: 'mapper error 1'});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
	t.is(source.returnCalls, 1);
	release(2);
});

// The readme's example: with `concurrency: 1`, `backpressure: 2` overlaps reading each element with mapping the one before it.
test('pMapIterable - with `concurrency: 1` and `backpressure: 2`, reading the next element overlaps the running mapper', async t => {
	const source = manualSource();
	const {mapper, release} = gatedMapper();
	const started = [];

	const iterator = pMapIterable(source, value => {
		started.push(value);
		return mapper(value);
	}, {concurrency: 1, backpressure: 2})[Symbol.asyncIterator]();

	const first = iterator.next();
	await drainEventLoop();
	t.is(source.pulls.length, 1);

	source.pulls[0].resolve({done: false, value: 0});
	await drainEventLoop();

	// The first element is being mapped, and the second one is read at the same time.
	t.deepEqual(started, [0]);
	t.is(source.pulls.length, 2);

	source.pulls[1].resolve({done: false, value: 1});
	await drainEventLoop();

	// The second element waits for the mapper, and that fills `backpressure`, so nothing more is read.
	t.deepEqual(started, [0]);
	t.is(source.pulls.length, 2);

	release(0);
	t.deepEqual(await first, {done: false, value: 0});
	await drainEventLoop();

	// The waiting element got the mapper, and the third element is read while it is mapped.
	t.deepEqual(started, [0, 1]);
	t.is(source.pulls.length, 3);

	source.pulls[2].resolve({done: true, value: undefined});
	release(1);
	t.deepEqual(await iterator.next(), {done: false, value: 1});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
	t.is(source.pulls.length, 3);
	t.is(source.returnCalls, 0);
});

test('pMapIterable - with `concurrency: 1`, at most one element waits for the mapper, whatever the `backpressure`', async t => {
	for (const {backpressure, pullsWhileMapping, pullsAfterFirstResult} of [
		// No read-ahead: the next element is read only once the consumer takes the result.
		{backpressure: 1, pullsWhileMapping: 1, pullsAfterFirstResult: 2},
		{backpressure: 2, pullsWhileMapping: 2, pullsAfterFirstResult: 3},
		{backpressure: 3, pullsWhileMapping: 2, pullsAfterFirstResult: 3},
		{backpressure: Number.POSITIVE_INFINITY, pullsWhileMapping: 2, pullsAfterFirstResult: 3},
	]) {
		const source = countingSource();
		const {mapper, release} = gatedMapper();
		const started = [];

		const iterator = pMapIterable(source, value => {
			started.push(value);
			return mapper(value);
		}, {concurrency: 1, backpressure})[Symbol.asyncIterator]();

		const first = iterator.next();
		await drainEventLoop(); // eslint-disable-line no-await-in-loop

		t.deepEqual(started, [0]);
		t.is(source.pulls, pullsWhileMapping, `backpressure: ${backpressure}`);

		release(0);
		t.deepEqual(await first, {done: false, value: 0}); // eslint-disable-line no-await-in-loop
		await drainEventLoop(); // eslint-disable-line no-await-in-loop

		t.deepEqual(started, [0, 1]);
		t.is(source.pulls, pullsAfterFirstResult, `backpressure: ${backpressure}`);

		const returned = iterator.return();
		release(1);
		await returned; // eslint-disable-line no-await-in-loop
	}
});

test('pMapIterable - `backpressure` counts each element until the consumer takes its result', async t => {
	for (const preserveOrder of [true, false]) {
		const source = countingSource();
		let mapperCalls = 0;

		const iterator = pMapIterable(source, async value => {
			mapperCalls++;
			return value;
		}, {concurrency: 2, backpressure: 5, preserveOrder})[Symbol.asyncIterator]();

		t.deepEqual(await iterator.next(), {done: false, value: 0}); // eslint-disable-line no-await-in-loop
		await drainEventLoop(); // eslint-disable-line no-await-in-loop

		// The result taken, plus `backpressure` results waiting for the consumer.
		t.is(source.pulls, 6);
		t.is(mapperCalls, 6);

		// The waiting results do not start any more work while the consumer is idle.
		await drainEventLoop(); // eslint-disable-line no-await-in-loop
		t.is(source.pulls, 6);
		t.is(mapperCalls, 6);

		// Each result the consumer takes lets exactly one more element in.
		for (let step = 1; step <= 3; step++) {
			t.deepEqual(await iterator.next(), {done: false, value: step}); // eslint-disable-line no-await-in-loop
			await drainEventLoop(); // eslint-disable-line no-await-in-loop
			t.is(source.pulls, 6 + step);
			t.is(mapperCalls, 6 + step);
		}

		await iterator.return(); // eslint-disable-line no-await-in-loop
	}
});

test('pMapIterable - `backpressure: Infinity` lets the results pile up while the consumer is idle', async t => {
	let mapperCalls = 0;

	const iterator = pMapIterable(range(20), async value => {
		mapperCalls++;
		return value;
	}, {concurrency: 1, backpressure: Number.POSITIVE_INFINITY})[Symbol.asyncIterator]();

	t.deepEqual(await iterator.next(), {done: false, value: 0});
	await drainEventLoop();

	// Only one mapper at a time, but nothing stops the mapping from running ahead of the consumer.
	t.is(mapperCalls, 20);
	t.deepEqual(await collectAsyncIterable(iterator), Array.from({length: 19}, (_, index) => index + 1));
});

test('pMapIterable - with `preserveOrder`, a slow first element holds back the mapping once `backpressure` is full', async t => {
	const {mapper, release} = gatedMapper();
	const started = [];

	const iterator = pMapIterable(range(10), value => {
		started.push(value);
		return value === 0 ? mapper(value) : value;
	}, {concurrency: 3, backpressure: 3})[Symbol.asyncIterator]();

	const first = iterator.next();
	await drainEventLoop();

	// The two results after the first one are ready, but they wait behind it and fill `backpressure`, although the consumer is waiting and mappers are free.
	t.deepEqual(started, [0, 1, 2]);

	release(0);
	t.deepEqual(await first, {done: false, value: 0});
	await drainEventLoop();
	t.deepEqual(started, [0, 1, 2, 3]);

	t.deepEqual(await collectAsyncIterable(iterator), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('pMapIterable - a skip-heavy stream never reads further ahead than `backpressure` allows', async t => {
	let pulls = 0;

	const source = {
		[Symbol.iterator]() {
			let index = 0;
			return {
				next() {
					pulls++;
					return index < 200 ? {done: false, value: index++} : {done: true, value: undefined};
				},
			};
		},
	};

	const values = [];
	const pullsAtEachValue = [];

	for await (const value of pMapIterable(source, async value => (value % 50 === 49 ? value : pMapSkip), {concurrency: 2, backpressure: 4})) {
		// Let everything that could start, start, while the consumer holds the result.
		await drainEventLoop();
		values.push(value);
		pullsAtEachValue.push(pulls);
	}

	t.deepEqual(values, [49, 99, 149, 199]);
	// The element yielded, plus the `backpressure` elements after it, and the last one also saw the `done`.
	t.deepEqual(pullsAtEachValue, [54, 104, 154, 201]);
});

test('pMapIterable - an element whose promise is still pending counts towards the read-ahead limit', async t => {
	const elements = Array.from({length: 6}, () => createDeferred());
	let pulls = 0;

	const source = {
		[Symbol.iterator]() {
			let index = 0;
			return {
				next() {
					pulls++;
					return index < elements.length ? {done: false, value: elements[index++].promise} : {done: true, value: undefined};
				},
			};
		},
	};

	const started = [];
	const iterator = pMapIterable(source, async value => {
		started.push(value);
		return value;
	}, {concurrency: 2, backpressure: 100})[Symbol.asyncIterator]();

	const first = iterator.next();
	await drainEventLoop();

	// Both elements are still being read, so although `backpressure` allows far more, nothing else is read.
	t.is(pulls, 2);
	t.deepEqual(started, []);

	elements[1].resolve(1);
	await drainEventLoop();

	// The second element is mapped, so one more element is read.
	t.deepEqual(started, [1]);
	t.is(pulls, 3);

	for (const [index, element] of elements.entries()) {
		element.resolve(index);
	}

	t.deepEqual(await first, {done: false, value: 0});
	t.deepEqual(await collectAsyncIterable(iterator), [1, 2, 3, 4, 5]);
});

test('pMapIterable - a sync source that throws on the Nth `next()` yields the earlier results, throws, and is not pulled again', async t => {
	for (const concurrency of [1, 2, 4, Number.POSITIVE_INFINITY]) {
		const iterable = new ThrowingIterator(10, 3);
		const values = [];

		// eslint-disable-next-line no-await-in-loop
		await t.throwsAsync(async () => {
			for await (const value of pMapIterable(iterable, async value => value, {concurrency})) {
				values.push(value);
			}
		}, {message: 'throwing on index 3'});

		t.deepEqual(values, [0, 1, 2], `concurrency: ${concurrency}`);
		t.is(iterable.index, 4, `concurrency: ${concurrency}`);
	}
});

test('pMapIterable - an async source that rejects on the Nth `next()` yields the earlier results, throws, and is not pulled again', async t => {
	for (const preserveOrder of [true, false]) {
		let pulls = 0;

		const source = {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						const index = pulls++;

						if (index === 2) {
							throw new Error('pull 2 failed');
						}

						return {done: false, value: index};
					},
				};
			},
		};

		const iterator = pMapIterable(source, async value => value * 10, {concurrency: 1, preserveOrder})[Symbol.asyncIterator]();

		t.deepEqual(await iterator.next(), {done: false, value: 0}); // eslint-disable-line no-await-in-loop
		t.deepEqual(await iterator.next(), {done: false, value: 10}); // eslint-disable-line no-await-in-loop
		await t.throwsAsync(iterator.next(), {message: 'pull 2 failed'}); // eslint-disable-line no-await-in-loop
		t.deepEqual(await iterator.next(), {done: true, value: undefined}); // eslint-disable-line no-await-in-loop

		await drainEventLoop(); // eslint-disable-line no-await-in-loop
		t.is(pulls, 3);
	}
});

test('pMapIterable - an input element that rejects is thrown at its position with `preserveOrder`, and when it settles without', async t => {
	for (const preserveOrder of [true, false]) {
		const element = createDeferred();
		const mappedValues = [];

		const iterator = pMapIterable([1, element.promise, 3], async value => {
			mappedValues.push(value);
			return value;
		}, {concurrency: 3, preserveOrder})[Symbol.asyncIterator]();

		t.deepEqual(await iterator.next(), {done: false, value: 1}); // eslint-disable-line no-await-in-loop

		// Without `preserveOrder`, the result after the pending element does not wait for it.
		if (!preserveOrder) {
			t.deepEqual(await iterator.next(), {done: false, value: 3}); // eslint-disable-line no-await-in-loop
		}

		const error = new Error('element failed');
		element.reject(error);

		t.is(await t.throwsAsync(iterator.next()), error); // eslint-disable-line no-await-in-loop
		t.deepEqual(await iterator.next(), {done: true, value: undefined}); // eslint-disable-line no-await-in-loop

		// The rejected element never reaches the mapper.
		t.deepEqual(mappedValues, [1, 3]);
	}
});

test('pMapIterable - a mapper error keeps its identity, also when it is not an `Error`', async t => {
	for (const preserveOrder of [true, false]) {
		for (const isAsync of [true, false]) {
			for (const thrown of [undefined, 'a string', {code: 42}, new Error('an error')]) {
				const throwingMapper = value => {
					if (value === 1) {
						throw thrown;
					}

					return value;
				};

				const iterator = pMapIterable([0, 1, 2], isAsync ? async value => throwingMapper(value) : throwingMapper, {concurrency: 1, preserveOrder})[Symbol.asyncIterator]();

				t.deepEqual(await iterator.next(), {done: false, value: 0}); // eslint-disable-line no-await-in-loop

				t.is(await getRejectionReason(iterator.next()), thrown); // eslint-disable-line no-await-in-loop
				t.deepEqual(await iterator.next(), {done: true, value: undefined}); // eslint-disable-line no-await-in-loop
			}
		}
	}
});

test('pMapIterable - `preserveOrder: false` yields the results that settled before an error, even when the consumer was not waiting', async t => {
	const {mapper, release} = gatedMapper();

	const iterator = pMapIterable([0, 1, 2, 3], async value => {
		await mapper(value);

		if (value === 2) {
			throw new Error('mapper error 2');
		}

		return value;
	}, {concurrency: 4, preserveOrder: false})[Symbol.asyncIterator]();

	const first = iterator.next();
	await drainEventLoop();

	release(1);
	t.deepEqual(await first, {done: false, value: 1});

	// Both settle while the consumer is not asking for anything.
	release(0);
	await drainEventLoop();
	release(2);
	await drainEventLoop();

	t.deepEqual(await iterator.next(), {done: false, value: 0});
	await t.throwsAsync(iterator.next(), {message: 'mapper error 2'});

	// The element still pending at the error is dropped.
	release(3);
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
});

test('pMapIterable - after a mapper error, the stream is done, the source is closed once, and nothing more is pulled', async t => {
	const source = countingSource();

	const iterator = pMapIterable(source, async value => {
		if (value === 2) {
			throw new Error('mapper error 2');
		}

		return value;
	}, {concurrency: 1})[Symbol.asyncIterator]();

	t.deepEqual(await iterator.next(), {done: false, value: 0});
	t.deepEqual(await iterator.next(), {done: false, value: 1});
	await t.throwsAsync(iterator.next(), {message: 'mapper error 2'});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});

	await drainEventLoop();
	t.is(source.pulls, 3);
	t.is(source.returnCalls, 1);
});

test('pMapIterable - a source `return()` that throws synchronously or never settles does not affect the consumer', async t => {
	const returnMethods = [
		() => {
			throw new Error('return failed');
		},
		() => new Promise(() => {}),
	];

	for (const returnMethod of returnMethods) {
		let returnCalls = 0;

		const source = {
			[Symbol.iterator]() {
				let index = 0;
				return {
					next: () => ({done: false, value: index++}),
					return() {
						returnCalls++;
						return returnMethod();
					},
				};
			},
		};

		for await (const value of pMapIterable(source, async value => value, {concurrency: 2})) { // eslint-disable-line no-unreachable-loop, no-await-in-loop
			t.is(value, 0);
			break;
		}

		t.is(returnCalls, 1);

		// The consumer still gets the mapper error, not the error from `return()`.
		// eslint-disable-next-line no-await-in-loop
		await t.throwsAsync(collectAsyncIterable(pMapIterable(source, async () => {
			throw new Error('mapper error');
		}, {concurrency: 2})), {message: 'mapper error'});

		t.is(returnCalls, 2);
	}
});

test('pMapIterable - does not close a source that already reported `done`, even when the consumer breaks on the last result', async t => {
	for (const preserveOrder of [true, false]) {
		let returnCalls = 0;

		const source = {
			[Symbol.iterator]() {
				let index = 0;
				return {
					next: () => (index < 3 ? {done: false, value: index++} : {done: true, value: undefined}),
					return() {
						returnCalls++;
						return {done: true, value: undefined};
					},
				};
			},
		};

		for await (const value of pMapIterable(source, async value => value, {concurrency: 1, preserveOrder})) { // eslint-disable-line no-await-in-loop
			if (value === 2) {
				// Let the pull after the last element report `done` before breaking.
				await drainEventLoop();
				break;
			}
		}

		t.is(returnCalls, 0);
	}
});

test.serial('pMapIterable - no unhandled rejection from mappers or input elements that reject after the consumer breaks', async t => {
	const unhandledRejections = await collectUnhandledRejections(async () => {
		for (const preserveOrder of [true, false]) {
			const element = createDeferred();
			const mapperGate = createDeferred();

			for await (const value of pMapIterable([0, 1, element.promise], async value => { // eslint-disable-line no-unreachable-loop, no-await-in-loop
				if (value === 1) {
					await mapperGate.promise;
					throw new Error('mapper error');
				}

				return value;
			}, {concurrency: 3, preserveOrder})) {
				t.is(value, 0);
				break;
			}

			element.reject(new Error('element error'));
			mapperGate.resolve();
			await delay(20); // eslint-disable-line no-await-in-loop
		}
	});

	t.deepEqual(unhandledRejections, []);
});

test('pMapIterable - pMapStop at the first element ends the stream without a result and closes the source once', async t => {
	for (const preserveOrder of [true, false]) {
		const source = countingSource();
		const mappedValues = [];

		// eslint-disable-next-line no-await-in-loop
		t.deepEqual(await collectAsyncIterable(pMapIterable(source, value => {
			mappedValues.push(value);
			return pMapStop;
		}, {concurrency: 1, preserveOrder})), []);

		await drainEventLoop(); // eslint-disable-line no-await-in-loop
		t.deepEqual(mappedValues, [0]);
		t.is(source.pulls, 1);
		t.is(source.returnCalls, 1);
	}
});

test('pMapIterable - pMapStop with `preserveOrder: false` still yields the results that settled before it while the consumer was not waiting', async t => {
	const {mapper, release} = gatedMapper();

	const iterator = pMapIterable([0, 1, 2, 3], async value => {
		await mapper(value);
		return value === 1 ? pMapStop : value;
	}, {concurrency: 4, preserveOrder: false})[Symbol.asyncIterator]();

	const first = iterator.next();
	await drainEventLoop();

	release(3);
	t.deepEqual(await first, {done: false, value: 3});

	// The consumer is not asking: one result settles before the stop, and one after it.
	release(2);
	await drainEventLoop();
	release(1);
	await drainEventLoop();
	release(0);
	await drainEventLoop();

	t.deepEqual(await iterator.next(), {done: false, value: 2});
	t.deepEqual(await iterator.next(), {done: true, value: undefined});
});

test('pMapIterable - pMapSkip and pMapStop together, in both orders', async t => {
	for (const preserveOrder of [true, false]) {
		const mappedValues = [];

		// eslint-disable-next-line no-await-in-loop
		const result = await collectAsyncIterable(pMapIterable([1, pMapSkip, 3, pMapStop, 5], async value => {
			mappedValues.push(value);
			return value;
		}, {concurrency: 1, preserveOrder}));

		t.deepEqual(result, [1, 3]);
		// Nothing after the stop is mapped.
		t.deepEqual(mappedValues, [1, pMapSkip, 3, pMapStop]);
	}
});

test('pMapIterable - the mapper `index` is the input position for an async source with read-ahead and skips', async t => {
	async function * source() {
		for (let index = 0; index < 10; index++) {
			yield `v${index}`;
		}
	}

	for (const preserveOrder of [true, false]) {
		const indexes = [];

		// eslint-disable-next-line no-await-in-loop
		const result = await collectAsyncIterable(pMapIterable(source(), async (value, index) => {
			indexes.push(index);

			// Finish out of order.
			for (let hop = 0; hop < 10 - index; hop++) {
				await Promise.resolve(); // eslint-disable-line no-await-in-loop
			}

			return index % 2 === 1 ? pMapSkip : [value, index];
		}, {concurrency: 3, backpressure: 6, preserveOrder}));

		t.deepEqual(indexes.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

		for (const [value, index] of result) {
			t.is(value, `v${index}`);
		}

		t.deepEqual(result.map(([, index]) => index).sort((a, b) => a - b), [0, 2, 4, 6, 8]);

		if (preserveOrder) {
			t.deepEqual(result.map(([, index]) => index), [0, 2, 4, 6, 8]);
		}
	}
});

test('pMapIterable - a long stream yields every result, with any `backpressure`', async t => {
	const length = 25_000;

	for (const options of [
		{concurrency: 1, backpressure: 1},
		{concurrency: 4, backpressure: 64},
		{concurrency: 1, backpressure: 1, preserveOrder: false},
		{concurrency: 4, backpressure: 64, preserveOrder: false},
	]) {
		let count = 0;
		let isInOrder = true;

		for await (const value of pMapIterable(range(length), value => value, options)) { // eslint-disable-line no-await-in-loop
			isInOrder &&= value === count;
			count++;
		}

		t.is(count, length);
		t.true(isInOrder, `${JSON.stringify(options)}`);
	}
});

test('pMapIterable - a long run of skipped results neither stalls nor overflows the stack', async t => {
	const length = 20_000;

	for (const preserveOrder of [true, false]) {
		// eslint-disable-next-line no-await-in-loop
		t.deepEqual(await collectAsyncIterable(pMapIterable(range(length), value => (value === length - 1 ? value : pMapSkip), {concurrency: 2, backpressure: 4, preserveOrder})), [length - 1]);
	}
});

test('pMapIterable - a long async source yields every result with `preserveOrder: false`', async t => {
	async function * source() {
		yield * range(20_000);
	}

	let count = 0;
	let sum = 0;

	for await (const value of pMapIterable(source(), async value => value, {concurrency: 4, backpressure: 8, preserveOrder: false})) {
		count++;
		sum += value;
	}

	t.is(count, 20_000);
	t.is(sum, (20_000 * 19_999) / 2);
});

test('pMapIterable - the `backpressure` validation message', t => {
	const message = (concurrency, backpressure, type) => `Expected \`backpressure\` to be an integer from \`concurrency\` (${concurrency}) and up or \`Infinity\`, got \`${backpressure}\` (${type})`;

	t.throws(() => pMapIterable([], () => {}, {backpressure: 0}), {instanceOf: TypeError, message: message('Infinity', '0', 'number')});
	t.throws(() => pMapIterable([], () => {}, {concurrency: 1, backpressure: 0}), {instanceOf: TypeError, message: message(1, '0', 'number')});
	t.throws(() => pMapIterable([], () => {}, {concurrency: 3, backpressure: '5'}), {instanceOf: TypeError, message: message(3, '5', 'string')});
	t.throws(() => pMapIterable([], () => {}, {concurrency: 1, backpressure: Number.NaN}), {instanceOf: TypeError, message: message(1, 'NaN', 'number')});
	t.throws(() => pMapIterable([], () => {}, {concurrency: 1, backpressure: Number.NEGATIVE_INFINITY}), {instanceOf: TypeError, message: message(1, '-Infinity', 'number')});
	t.throws(() => pMapIterable([], () => {}, {concurrency: 1, backpressure: Number.MAX_SAFE_INTEGER + 1}), {instanceOf: TypeError, message: message(1, '9007199254740992', 'number')});
	t.throws(() => pMapIterable([], () => {}, {concurrency: 4, backpressure: 3.5}), {instanceOf: TypeError, message: message(4, '3.5', 'number')});

	t.notThrows(() => pMapIterable([], () => {}, {concurrency: 1, backpressure: Number.MAX_SAFE_INTEGER}));
	// An explicit `undefined` is the default, `concurrency`.
	t.notThrows(() => pMapIterable([], () => {}, {concurrency: 3, backpressure: undefined}));
});

test('pMapIterable - checks the input, the mapper, and `concurrency` before `backpressure`', t => {
	t.throws(() => pMapIterable(123, () => {}, {concurrency: 2, backpressure: 1}), {message: 'Expected `input` to be either an `Iterable` or `AsyncIterable`, got (number)'});
	t.throws(() => pMapIterable([], 'not a function', {concurrency: 2, backpressure: 1}), {message: 'Mapper function is required'});
	t.throws(() => pMapIterable([], () => {}, {concurrency: 0, backpressure: 0}), {message: 'Expected `concurrency` to be an integer from 1 and up or `Infinity`, got `0` (number)'});
});

test('pMapIterable - breaking out of a chained stage closes the upstream stage and its source', async t => {
	const source = countingSource();
	let firstStageCalls = 0;
	let secondStageCalls = 0;

	const firstStage = pMapIterable(source, async value => {
		firstStageCalls++;
		return value * 2;
	}, {concurrency: 2, backpressure: 4});

	const secondStage = pMapIterable(firstStage, async value => {
		secondStageCalls++;
		return value + 1;
	}, {concurrency: 2, backpressure: 4});

	for await (const value of secondStage) { // eslint-disable-line no-unreachable-loop
		t.is(value, 1);
		break;
	}

	await drainEventLoop();
	t.is(source.returnCalls, 1);

	const counts = [source.pulls, firstStageCalls, secondStageCalls];
	await drainEventLoop();
	t.deepEqual([source.pulls, firstStageCalls, secondStageCalls], counts);
});

test('pMapIterable - an error in an upstream stage reaches the consumer after the earlier results', async t => {
	const firstStage = pMapIterable([0, 1, 2, 3, 4], async value => {
		if (value === 3) {
			throw new Error('first stage error 3');
		}

		return value;
	}, {concurrency: 2});

	const values = [];

	await t.throwsAsync(async () => {
		for await (const value of pMapIterable(firstStage, async value => value * 10, {concurrency: 2})) {
			values.push(value);
		}
	}, {message: 'first stage error 3'});

	t.deepEqual(values, [0, 10, 20]);
});

test('pMapIterable - a slow downstream stage keeps an upstream stage from reading ahead', async t => {
	const source = countingSource();
	const {mapper, release} = gatedMapper();

	const firstStage = pMapIterable(source, async value => value, {concurrency: 1, backpressure: 1});
	const iterator = pMapIterable(firstStage, mapper, {concurrency: 1, backpressure: 1})[Symbol.asyncIterator]();

	const first = iterator.next();
	await drainEventLoop();

	// The element the second stage maps, and the one result the first stage holds for it.
	t.is(source.pulls, 2);

	release(0);
	t.deepEqual(await first, {done: false, value: 0});
	await drainEventLoop();
	t.is(source.pulls, 3);

	const returned = iterator.return();
	release(1);
	await returned;
	await drainEventLoop();
	t.is(source.returnCalls, 1);
});

test('pMapIterable - a `pMap` that stops early closes the `pMapIterable` feeding it, and its source', async t => {
	const source = countingSource();
	let mapperCalls = 0;

	const stage = pMapIterable(source, async value => {
		mapperCalls++;
		return value;
	}, {concurrency: 2, backpressure: 4});

	t.deepEqual(await pMap(stage, value => (value === 3 ? pMapStop : value), {concurrency: 1}), [0, 1, 2]);

	await drainEventLoop();
	t.is(source.returnCalls, 1);

	const mapperCallsAfterStop = mapperCalls;
	await drainEventLoop();
	t.is(mapperCalls, mapperCallsAfterStop);
});

test('pMapIterable - awaits thenables, as input elements and as mapper results', async t => {
	// eslint-disable-next-line unicorn/no-thenable
	const thenable = value => ({then(resolve) {
		resolve(value);
	}});

	for (const preserveOrder of [true, false]) {
		// eslint-disable-next-line no-await-in-loop
		const result = await collectAsyncIterable(pMapIterable([thenable(1), 2, thenable(3)], value => (value === 2 ? thenable(pMapSkip) : thenable(value * 10)), {concurrency: 1, preserveOrder}));
		t.deepEqual(result, [10, 30]);
	}
});

test('pMapIterable - the return value of a source generator is neither mapped nor yielded', async t => {
	async function * asyncSource() {
		yield 1;
		return 'return value';
	}

	function * syncSource() {
		yield 1;
		return 'return value';
	}

	for (const source of [asyncSource, syncSource]) {
		const mappedValues = [];

		// eslint-disable-next-line no-await-in-loop
		t.deepEqual(await collectAsyncIterable(pMapIterable(source(), async value => {
			mappedValues.push(value);
			return value;
		}, {concurrency: 2})), [1]);

		t.deepEqual(mappedValues, [1]);
	}
});

//
// More pMapKeyed and pMapSettledKeyed tests
//

test('pMapKeyed - starts exactly `concurrency` mappers, and one more each time one finishes', async t => {
	const {mapper, release} = gatedMapper();
	const startedKeys = [];

	const promise = pMapKeyed({a: 'a', b: 'b', c: 'c', d: 'd', e: 'e'}, (value, key) => {
		startedKeys.push(key);
		return mapper(value);
	}, {concurrency: 2});

	await drainEventLoop();
	t.deepEqual(startedKeys, ['a', 'b']);

	release('b');
	await drainEventLoop();
	t.deepEqual(startedKeys, ['a', 'b', 'c']);

	release('a');
	await drainEventLoop();
	t.deepEqual(startedKeys, ['a', 'b', 'c', 'd']);

	release('d');
	await drainEventLoop();
	t.deepEqual(startedKeys, ['a', 'b', 'c', 'd', 'e']);

	release('c');
	release('e');

	const result = await promise;
	t.deepEqual(Object.keys(result), ['a', 'b', 'c', 'd', 'e']);
	t.deepEqual(result, {a: 'a', b: 'b', c: 'c', d: 'd', e: 'e'});
});

test('pMapKeyed - with concurrency 1, calls the mapper in key order, even when the values resolve in reverse order', async t => {
	const values = {a: createDeferred(), b: createDeferred(), c: createDeferred()};
	const mappedKeys = [];

	const promise = pMapKeyed({a: values.a.promise, b: values.b.promise, c: values.c.promise}, (value, key) => {
		mappedKeys.push(key);
		return value;
	}, {concurrency: 1});

	values.c.resolve('c');
	await drainEventLoop();
	values.b.resolve('b');
	await drainEventLoop();
	t.deepEqual(mappedKeys, []);

	values.a.resolve('a');

	t.deepEqual(await promise, {a: 'a', b: 'b', c: 'c'});
	t.deepEqual(mappedKeys, ['a', 'b', 'c']);
});

test('pMapKeyed - without a concurrency limit, a value that is still pending does not hold back the mappers of the later keys', async t => {
	const first = createDeferred();
	const mappedKeys = [];

	const promise = pMapKeyed({a: first.promise, b: 'b', c: 'c'}, (value, key) => {
		mappedKeys.push(key);
		return value;
	});

	await drainEventLoop();
	t.deepEqual(mappedKeys, ['b', 'c']);

	first.resolve('a');

	const result = await promise;
	t.deepEqual(mappedKeys, ['b', 'c', 'a']);
	t.deepEqual(Object.keys(result), ['a', 'b', 'c']);
});

test('pMapKeyed - calls the mapper with only the value and the key', async t => {
	const calls = [];
	const mapper = (...arguments_) => {
		calls.push(arguments_);
		return arguments_[0];
	};

	await pMapKeyed({a: 1}, mapper);
	await pMapKeyed(new Map([['b', 2]]), mapper);
	await pMapSettledKeyed({c: 3}, mapper);
	await pMapSettledKeyed(new Map([['d', 4]]), mapper);

	t.deepEqual(calls, [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]);
});

test('pMapKeyed - reads every value before it returns', async t => {
	const reads = [];
	const input = {
		get a() {
			reads.push('a');
			return 1;
		},
		get b() {
			reads.push('b');
			return 2;
		},
	};

	const promise = pMapKeyed(input, value => value, {concurrency: 1});
	t.deepEqual(reads, ['a', 'b']);

	const settledPromise = pMapSettledKeyed(input, value => value, {concurrency: 1});
	t.deepEqual(reads, ['a', 'b', 'a', 'b']);

	t.deepEqual(await promise, {a: 1, b: 2});
	t.deepEqual(await settledPromise, {a: fulfilled(1), b: fulfilled(2)});
});

test('pMapKeyed - a change to the input while the mappers run does not affect the result', async t => {
	const input = {a: 1, b: 2};

	const result = await pMapKeyed(input, (value, key) => {
		if (key === 'a') {
			input.a = 10;
			delete input.b;
			input.c = 3;
		}

		return value;
	}, {concurrency: 1});

	t.deepEqual(result, {a: 1, b: 2});
	t.deepEqual(input, {a: 10, c: 3});
});

test('pMapKeyed - gives an extensible result with writable, enumerable, and configurable properties, even for a frozen or sealed input', async t => {
	const result = await pMapKeyed(Object.freeze({a: 1}), value => value);

	t.true(Object.isExtensible(result));
	t.deepEqual(Object.getOwnPropertyDescriptor(result, 'a'), {value: 1, writable: true, enumerable: true, configurable: true});

	const settledResult = await pMapSettledKeyed(Object.seal({b: 2}), value => value);

	t.true(Object.isExtensible(settledResult));
	t.deepEqual(Object.getOwnPropertyDescriptor(settledResult, 'b'), {value: fulfilled(2), writable: true, enumerable: true, configurable: true});
});

test('pMapKeyed - gives a new object or `Map` on each call, never the input', async t => {
	const input = {a: 1};
	const first = await pMapKeyed(input, value => value);
	const second = await pMapKeyed(input, value => value);

	t.not(first, input);
	t.not(first, second);

	first.a = 2;
	t.is(second.a, 1);
	t.is(input.a, 1);

	const map = new Map([['a', 1]]);
	const mapResult = await pMapKeyed(map, value => value);

	t.not(mapResult, map);

	mapResult.set('b', 2);
	t.false(map.has('b'));
});

test('pMapKeyed - keys with special names keep their place, and the mapper gets them as strings', async t => {
	const input = JSON.parse('{"b": 1, "01": 2, "-1": 3, "4294967295": 4, "4294967294": 5, "": 6, "constructor": 7, "hasOwnProperty": 8, "10": 9}');
	const mappedKeys = [];

	const result = await pMapKeyed(input, (value, key) => {
		mappedKeys.push(key);
		return value * 10;
	}, {concurrency: 1});

	// Only the array indexes, up to 2 ** 32 - 2, come first, in ascending order. The other numeric-like keys stay in insertion order.
	const expectedKeys = ['10', '4294967294', 'b', '01', '-1', '4294967295', '', 'constructor', 'hasOwnProperty'];

	t.deepEqual(Reflect.ownKeys(result), expectedKeys);
	t.deepEqual(mappedKeys, expectedKeys);
	t.is(result[''], 60);
	t.is(result['01'], 20);
	t.is(result.constructor, 70);
	t.is(result.hasOwnProperty, 80);
});

test('pMapKeyed - a `then` key whose result is not a function is an ordinary key', async t => {
	// eslint-disable-next-line unicorn/no-thenable
	const result = await pMapKeyed({then: 1, a: 2}, value => value * 10);

	t.deepEqual(Reflect.ownKeys(result), ['then', 'a']);
	t.is(result.then, 10);
	t.is(result.a, 20);
});

test('pMapSettledKeyed - each settled result is a plain object, and a mapper result that looks like one is still wrapped', async t => {
	const error = new Error('b');
	const result = await pMapSettledKeyed({a: 1, b: Promise.reject(error)}, () => rejected('not really'));

	t.is(Object.getPrototypeOf(result), null);
	t.is(Object.getPrototypeOf(result.a), Object.prototype);
	t.is(Object.getPrototypeOf(result.b), Object.prototype);
	t.deepEqual(result.a, fulfilled(rejected('not really')));
	t.deepEqual(result.b, rejected(error));

	const mapResult = await pMapSettledKeyed(new Map([['a', 1]]), () => fulfilled('not really'));

	t.is(Object.getPrototypeOf(mapResult.get('a')), Object.prototype);
	t.deepEqual(mapResult.get('a'), fulfilled(fulfilled('not really')));
});

test('pMapKeyed - a value that is `pMapSkip` or `pMapStop` is passed to the mapper like any other value', async t => {
	const mappedValues = [];

	const result = await pMapKeyed({a: pMapSkip, b: Promise.resolve(pMapStop), c: 3}, value => {
		mappedValues.push(value);
		return typeof value;
	}, {concurrency: 1});

	t.deepEqual(result, {a: 'symbol', b: 'symbol', c: 'number'});
	t.deepEqual(mappedValues, [pMapSkip, pMapStop, 3]);

	// Returned as is, they skip and stop.
	t.deepEqual(await pMapKeyed({a: 1, b: pMapSkip, c: 3, d: pMapStop, e: 5}, value => value, {concurrency: 1}), {a: 1, c: 3});
});

test('pMapKeyed - a key that is `pMapSkip` or `pMapStop` is an ordinary key', async t => {
	const result = await pMapKeyed({[pMapSkip]: 1, [pMapStop]: 2}, value => value * 10);

	t.deepEqual(Reflect.ownKeys(result), [pMapSkip, pMapStop]);
	t.is(result[pMapSkip], 10);
	t.is(result[pMapStop], 20);

	const mapResult = await pMapKeyed(new Map([[pMapStop, 1], [pMapSkip, 2]]), value => value * 10);

	t.deepEqual([...mapResult], [[pMapStop, 10], [pMapSkip, 20]]);
});

test('pMapKeyed - a mapper result that is an entry, an array, or a `Map` is kept as the value', async t => {
	const map = new Map([['x', 1]]);

	const result = await pMapKeyed({a: 1, b: 2, c: 3}, (value, key) => {
		if (key === 'a') {
			return ['b', 'entry'];
		}

		if (key === 'b') {
			return [];
		}

		return map;
	});

	t.deepEqual(Reflect.ownKeys(result), ['a', 'b', 'c']);
	t.deepEqual(result.a, ['b', 'entry']);
	t.deepEqual(result.b, []);
	t.is(result.c, map);

	const mapResult = await pMapKeyed(new Map([['a', 1]]), () => ['z', 2]);
	t.deepEqual([...mapResult], [['a', ['z', 2]]]);
});

test('pMapKeyed - keeps a key whose mapper returns `undefined`', async t => {
	const result = await pMapKeyed({a: 1, b: 2}, () => undefined);

	t.deepEqual(Reflect.ownKeys(result), ['a', 'b']);
	t.is(result.a, undefined);

	const mapResult = await pMapKeyed(new Map([['a', 1]]), () => undefined);

	t.true(mapResult.has('a'));
	t.is(mapResult.size, 1);
});

test('pMapKeyed - skipping every key gives an empty null-prototype object or an empty `Map`', async t => {
	const result = await pMapKeyed({a: 1, b: 2}, () => pMapSkip);

	t.is(Object.getPrototypeOf(result), null);
	t.deepEqual(Reflect.ownKeys(result), []);

	const stoppedResult = await pMapKeyed({a: 1, b: 2}, () => pMapStop);
	t.deepEqual(Reflect.ownKeys(stoppedResult), []);

	const mapResult = await pMapKeyed(new Map([['a', 1]]), () => pMapSkip);

	t.true(mapResult instanceof Map);
	t.is(mapResult.size, 0);
});

test('pMapKeyed - a mapper that returns a promise of `pMapSkip` or a thenable of `pMapStop`', async t => {
	const result = await pMapKeyed({a: 1, b: 2, c: 3, d: 4}, value => {
		if (value === 2) {
			return Promise.resolve(pMapSkip);
		}

		if (value === 3) {
			return {
				then(resolve) { // eslint-disable-line unicorn/no-thenable
					resolve(pMapStop);
				},
			};
		}

		return value;
	}, {concurrency: 1});

	t.deepEqual(result, {a: 1});
});

test('pMapKeyed - a mapper that throws `pMapSkip` or `pMapStop` rejects, it does not skip or stop', async t => {
	const skipReason = await getRejectionReason(pMapKeyed({a: 1}, () => {
		throw pMapSkip;
	}));

	t.is(skipReason, pMapSkip);

	const stopReason = await getRejectionReason(pMapKeyed({a: 1}, async () => {
		throw pMapStop;
	}));

	t.is(stopReason, pMapStop);

	const result = await pMapSettledKeyed({a: pMapSkip, b: pMapStop}, value => {
		throw value;
	});

	t.deepEqual(result, {a: rejected(pMapSkip), b: rejected(pMapStop)});
});

test('pMapKeyed - a mapper that throws synchronously rejects the returned promise', async t => {
	const error = new Error('sync');
	let promise;

	t.notThrows(() => {
		promise = pMapKeyed({a: 1}, () => {
			throw error;
		});
	});

	await t.throwsAsync(promise, {is: error});
});

test('pMapKeyed - awaits a value through nested promises and thenables', async t => {
	const nested = {
		then(resolve) { // eslint-disable-line unicorn/no-thenable
			resolve(Promise.resolve({
				then(resolveInner) { // eslint-disable-line unicorn/no-thenable
					resolveInner('deep');
				},
			}));
		},
	};

	const mappedValues = [];

	const result = await pMapKeyed({a: nested}, value => {
		mappedValues.push(value);
		return value;
	});

	t.deepEqual(result, {a: 'deep'});
	t.deepEqual(mappedValues, ['deep']);
});

test('pMapKeyed - a value that is a thenable that throws rejects with the error, without calling the mapper for it', async t => {
	const error = new Error('then');
	const throwingThenable = {
		then() { // eslint-disable-line unicorn/no-thenable
			throw error;
		},
	};

	const throwingGetterThenable = {
		get then() { // eslint-disable-line unicorn/no-thenable
			throw error;
		},
	};

	const mappedKeys = [];
	const mapper = (value, key) => {
		mappedKeys.push(key);
		return value;
	};

	await t.throwsAsync(pMapKeyed({a: throwingThenable}, mapper), {is: error});
	await t.throwsAsync(pMapKeyed({b: throwingGetterThenable}, mapper), {is: error});
	t.deepEqual(mappedKeys, []);

	t.deepEqual(await pMapSettledKeyed({c: throwingThenable, d: throwingGetterThenable, e: 5}, mapper), {
		c: rejected(error),
		d: rejected(error),
		e: fulfilled(5),
	});
	t.deepEqual(mappedKeys, ['e']);
});

test('pMapKeyed - subscribes to a thenable value right away, before a mapper slot reaches it', async t => {
	const {mapper, release} = gatedMapper();
	let thenCallCount = 0;
	const thenable = {
		then(resolve) { // eslint-disable-line unicorn/no-thenable
			thenCallCount++;
			resolve('b');
		},
	};

	const promise = pMapKeyed({a: 'a', b: thenable}, mapper, {concurrency: 1});

	await drainEventLoop();
	t.is(thenCallCount, 1);

	release('a');
	await drainEventLoop();
	release('b');

	t.deepEqual(await promise, {a: 'a', b: 'b'});
	t.is(thenCallCount, 1);
});

test('pMapKeyed - stopOnError: false collects only the errors before a stop, in key order', async t => {
	const valueError = new Error('value');
	const mapperError = new Error('mapper');
	const firstGate = createDeferred();

	const promise = pMapKeyed({
		a: 'a',
		b: 'b',
		c: Promise.reject(valueError),
		d: 'd',
		e: 'e',
		f: Promise.reject(new Error('value after the stop')),
	}, async (value, key) => {
		if (key === 'a') {
			// Settles last, so the run has to wait for it although the stop and the later errors came first.
			await firstGate.promise;
			throw mapperError;
		}

		if (key === 'b') {
			return pMapSkip;
		}

		if (key === 'd') {
			return pMapStop;
		}

		throw new Error('mapper after the stop');
	}, {stopOnError: false});

	await drainEventLoop();
	firstGate.resolve();

	const error = await t.throwsAsync(promise, {instanceOf: AggregateError});
	t.is(error.errors.length, 2);
	t.is(error.errors[0], mapperError);
	t.is(error.errors[1], valueError);

	// Only errors after the stop, so it resolves.
	t.deepEqual(await pMapKeyed({a: 1, b: 2, c: Promise.reject(new Error('c'))}, value => (value === 2 ? pMapStop : value), {concurrency: 1, stopOnError: false}), {a: 1});
});

test('pMapKeyed - rejects with the first error to happen, not the first in key order, without waiting for the other mappers', async t => {
	const firstGate = createDeferred();
	let isFirstMapperDone = false;

	const promise = pMapKeyed({a: 'a', b: 'b'}, async value => {
		if (value === 'a') {
			await firstGate.promise;
			isFirstMapperDone = true;
			throw new Error('a');
		}

		throw new Error('b');
	});

	await t.throwsAsync(promise, {message: 'b'});
	t.false(isFirstMapperDone);

	firstGate.resolve();
	await drainEventLoop();
	t.true(isFirstMapperDone);
});

test('pMapKeyed - with concurrency 1, no mapper runs after a value of a `Map` rejects', async t => {
	const mappedKeys = [];

	await t.throwsAsync(pMapKeyed(new Map([['a', 1], ['b', Promise.reject(new Error('b'))], ['c', 3]]), (value, key) => {
		mappedKeys.push(key);
		return value;
	}, {concurrency: 1}), {message: 'b'});

	await drainEventLoop();
	t.deepEqual(mappedKeys, ['a']);
});

test('pMapKeyed - stopOnError: false collects the errors of a `Map` in key order', async t => {
	const objectKey = {};
	const valueError = new Error('value');
	const mapperError = new Error('mapper');
	const value = createDeferred();

	const promise = pMapKeyed(new Map([[objectKey, value.promise], ['b', 2], [3, 3]]), (value, key) => {
		if (key === 3) {
			throw mapperError;
		}

		return value;
	}, {stopOnError: false});

	// The mapper error happens first, the value of the first key rejects after it.
	await drainEventLoop();
	value.reject(valueError);

	const error = await t.throwsAsync(promise, {instanceOf: AggregateError});
	t.is(error.errors.length, 2);
	t.is(error.errors[0], valueError);
	t.is(error.errors[1], mapperError);
});

test('pMapKeyed - a `Map` subclass gives a plain `Map`', async t => {
	class CustomMap extends Map {}

	const result = await pMapKeyed(new CustomMap([['a', 1]]), value => value + 1);

	t.is(Object.getPrototypeOf(result), Map.prototype);
	t.deepEqual([...result], [['a', 2]]);

	const settledResult = await pMapSettledKeyed(new CustomMap([['a', 1]]), value => value);

	t.is(Object.getPrototypeOf(settledResult), Map.prototype);
	t.deepEqual([...settledResult], [['a', fulfilled(1)]]);
});

test('pMapKeyed - passes on each key of a `Map` as is, with `NaN`, `-0` as `0`, and a promise key that is not awaited', async t => {
	const promiseKey = Promise.resolve('not awaited');
	const mappedKeys = [];

	const result = await pMapKeyed(new Map([
		[Number.NaN, 'nan'],
		[-0, 'zero'],
		[promiseKey, 'promise'],
		[undefined, 'undefined'],
		['1', 'string'],
		[1, 'number'],
	]), (value, key) => {
		mappedKeys.push(key);
		return value;
	}, {concurrency: 1});

	t.true(Number.isNaN(mappedKeys[0]));
	t.true(Object.is(mappedKeys[1], 0));
	t.is(mappedKeys[2], promiseKey);
	t.is(mappedKeys[3], undefined);
	t.deepEqual(mappedKeys.slice(4), ['1', 1]);

	t.is(result.size, 6);
	t.is(result.get(Number.NaN), 'nan');
	t.is(result.get(0), 'zero');
	t.is(result.get(promiseKey), 'promise');
	t.is(result.get(undefined), 'undefined');
	t.is(result.get('1'), 'string');
	t.is(result.get(1), 'number');
});

test('pMapKeyed - a `Map` from another realm is used as an object', async t => {
	const map = vm.runInNewContext('new Map([["a", 1]])');
	map.property = 2;

	const result = await pMapKeyed(map, value => value * 10);

	t.false(result instanceof Map);
	t.is(Object.getPrototypeOf(result), null);
	t.deepEqual(Reflect.ownKeys(result), ['property']);
	t.is(result.property, 20);
});

test('pMapKeyed - an input that is a promise is not awaited, like `Promise.allKeyed`', async t => {
	let mapperCallCount = 0;

	const result = await pMapKeyed(Promise.resolve({a: 1}), value => {
		mapperCallCount++;
		return value;
	});

	t.is(Object.getPrototypeOf(result), null);
	t.deepEqual(Reflect.ownKeys(result), []);
	t.is(mapperCallCount, 0);
});

test('pMapKeyed - a string object, a typed array, and a sparse array give their own enumerable index keys', async t => {
	t.deepEqual(await pMapKeyed(new String('ab'), value => value), {0: 'a', 1: 'b'}); // eslint-disable-line no-new-wrappers, unicorn/new-for-builtins
	t.deepEqual(await pMapKeyed(new Uint8Array([5, 6]), value => value * 2), {0: 10, 1: 12});

	// eslint-disable-next-line no-sparse-arrays
	const sparseResult = await pMapKeyed([, 'b', , 'd'], value => value);
	t.deepEqual(Reflect.ownKeys(sparseResult), ['1', '3']);
});

test('pMapKeyed - a class instance gives its own fields, not its methods or accessors', async t => {
	class Example {
		field = 1;

		get accessor() {
			return 2;
		}

		method() {
			return 3;
		}
	}

	const result = await pMapKeyed(new Example(), value => value);

	t.deepEqual(Reflect.ownKeys(result), ['field']);
	t.is(result.field, 1);
});

test('pMapKeyed - an object with its own `Symbol.iterator` is mapped by its keys, not iterated', async t => {
	const input = {
		a: 1,
		* [Symbol.iterator]() {
			yield ['b', 2];
		},
	};

	const result = await pMapKeyed(input, value => typeof value);

	t.false(result instanceof Map);
	t.deepEqual(Reflect.ownKeys(result), ['a', Symbol.iterator]);
	t.is(result.a, 'number');
	t.is(result[Symbol.iterator], 'function');
});

test('pMapKeyed - puts the symbol keys after the string keys, even when a symbol was added first, and leaves out a non-enumerable symbol', async t => {
	const first = Symbol('first');
	const hidden = Symbol('hidden');
	const input = {[first]: 1, b: 2};
	input[1] = 3;
	Object.defineProperty(input, hidden, {value: 4, enumerable: false});

	const mappedKeys = [];

	const result = await pMapKeyed(input, (value, key) => {
		mappedKeys.push(key);
		return value;
	}, {concurrency: 1});

	t.deepEqual(Reflect.ownKeys(result), ['1', 'b', first]);
	t.deepEqual(mappedKeys, ['1', 'b', first]);
});

test('pMapKeyed - maps an object with many keys, in key order', async t => {
	const keyCount = 10_000;
	const input = {};

	for (let index = 0; index < keyCount; index++) {
		input[`key${index}`] = index;
	}

	for (const concurrency of [1, 7, Number.POSITIVE_INFINITY]) {
		// eslint-disable-next-line no-await-in-loop
		const result = await pMapKeyed(input, value => value * 2, {concurrency});
		const keys = Object.keys(result);

		t.is(keys.length, keyCount);
		t.true(keys.every((key, index) => key === `key${index}` && result[key] === index * 2));
	}

	const mapResult = await pMapKeyed(new Map(Object.entries(input)), async value => value * 2, {concurrency: 3});
	let index = 0;
	let isInOrder = mapResult.size === keyCount;

	for (const [key, value] of mapResult) {
		isInOrder &&= key === `key${index}` && value === index * 2;
		index++;
	}

	t.true(isInOrder);
});

test.serial('pMapKeyed - a proxy trap that throws rejects, and the values read before it keep their handlers', async t => {
	const mappedKeys = [];
	const mapper = (value, key) => {
		mappedKeys.push(key);
		return value;
	};

	const createInput = () => new Proxy({a: Promise.reject(new Error('a')), b: 2, c: 3}, {
		getOwnPropertyDescriptor(target, key) {
			if (key === 'b') {
				throw new Error('getOwnPropertyDescriptor');
			}

			return Reflect.getOwnPropertyDescriptor(target, key);
		},
	});

	const unhandledRejections = await collectUnhandledRejections(async () => {
		await t.throwsAsync(pMapKeyed(createInput(), mapper), {message: 'getOwnPropertyDescriptor'});
		await t.throwsAsync(pMapSettledKeyed(createInput(), mapper), {message: 'getOwnPropertyDescriptor'});

		await t.throwsAsync(pMapKeyed(new Proxy({a: 1}, {
			ownKeys() {
				throw new Error('ownKeys');
			},
		}), mapper), {message: 'ownKeys'});

		const {proxy, revoke} = Proxy.revocable({a: 1}, {});
		revoke();
		await t.throwsAsync(pMapSettledKeyed(proxy, mapper), {instanceOf: TypeError});
	});

	t.deepEqual(unhandledRejections, []);
	t.deepEqual(mappedKeys, []);
});

test.serial('pMapKeyed - an aborted signal still reads every value, never calls the mapper, and leaves no unhandled rejection', async t => {
	const reason = new Error('aborted');
	const signal = AbortSignal.abort(reason);
	const reads = [];
	let mapperCallCount = 0;

	const createInput = () => ({
		get a() {
			reads.push('a');
			return Promise.reject(new Error('a'));
		},
		get b() {
			reads.push('b');
			return 2;
		},
	});

	const mapper = value => {
		mapperCallCount++;
		return value;
	};

	const unhandledRejections = await collectUnhandledRejections(async () => {
		await t.throwsAsync(pMapKeyed(createInput(), mapper, {signal}), {is: reason});
		await t.throwsAsync(pMapSettledKeyed(createInput(), mapper, {signal}), {is: reason});
		await t.throwsAsync(pMapKeyed(new Map([['a', Promise.reject(new Error('map'))]]), mapper, {signal}), {is: reason});
	});

	t.deepEqual(reads, ['a', 'b', 'a', 'b']);
	t.is(mapperCallCount, 0);
	t.deepEqual(unhandledRejections, []);
});

for (const method of [pMapKeyed, pMapSettledKeyed]) {
	for (const useMap of [false, true]) {
		const inputType = useMap ? 'Map' : 'object';

		test(`${method.name} - does not map a pending ${inputType} value after abort`, async t => {
			const pendingValue = createDeferred();
			const abortController = new AbortController();
			const mappedKeys = [];
			const input = {a: pendingValue.promise, b: 'b'};

			const promise = method(useMap ? new Map(Object.entries(input)) : input, (value, key) => {
				mappedKeys.push(key);
				return value;
			}, {signal: abortController.signal});

			await drainEventLoop();
			t.deepEqual(mappedKeys, ['b']);

			const reason = new Error('aborted');
			abortController.abort(reason);
			await t.throwsAsync(promise, {is: reason});

			pendingValue.resolve('a');
			await drainEventLoop();
			t.deepEqual(mappedKeys, ['b']);
		});

		test(`${method.name} - does not map pending ${inputType} values after a stop, but still maps earlier values`, async t => {
			const earlierValue = createDeferred();
			const laterValue = createDeferred();
			const lastValue = createDeferred();
			const mappedKeys = [];
			const input = {a: earlierValue.promise, b: 'b', c: laterValue.promise, d: lastValue.promise};

			const promise = method(useMap ? new Map(Object.entries(input)) : input, (value, key) => {
				mappedKeys.push(key);
				return key === 'b' ? pMapStop : value;
			});

			await drainEventLoop();
			t.deepEqual(mappedKeys, ['b']);

			laterValue.resolve('c');
			await drainEventLoop();
			t.deepEqual(mappedKeys, ['b']);

			earlierValue.resolve('a');
			const result = await promise;
			const expected = {a: method === pMapSettledKeyed ? fulfilled('a') : 'a'};
			t.deepEqual(result, useMap ? new Map(Object.entries(expected)) : expected);
			t.deepEqual(mappedKeys, ['b', 'a']);

			lastValue.resolve('d');
			await drainEventLoop();
			t.deepEqual(mappedKeys, ['b', 'a']);
		});
	}
}

test('pMapKeyed - an abort while a mapper runs rejects with the reason, starts no more mappers, and removes the listener', async t => {
	const abortController = new AbortController();
	const {mapper, release} = gatedMapper();
	const startedKeys = [];

	const promise = pMapKeyed({a: 'a', b: 'b', c: 'c'}, (value, key) => {
		startedKeys.push(key);
		return mapper(value);
	}, {concurrency: 1, signal: abortController.signal});

	await drainEventLoop();
	t.is(abortListenerCount(abortController.signal), 1);

	const reason = new Error('stop');
	abortController.abort(reason);

	await t.throwsAsync(promise, {is: reason});
	t.is(abortListenerCount(abortController.signal), 0);

	release('a');
	await drainEventLoop();
	t.deepEqual(startedKeys, ['a']);
});

test('pMapSettledKeyed - an abort rejects even when the keys before it have already settled', async t => {
	const abortController = new AbortController();
	const {mapper, release} = gatedMapper();
	const settledKeys = [];

	const promise = pMapSettledKeyed({a: 'a', b: 'b'}, async (value, key) => {
		if (key === 'a') {
			settledKeys.push(key);
			throw new Error('a');
		}

		return mapper(value);
	}, {signal: abortController.signal});

	await drainEventLoop();
	t.deepEqual(settledKeys, ['a']);

	abortController.abort();

	await t.throwsAsync(promise, {name: 'AbortError'});
	release('b');
});

test('pMapSettledKeyed - ignores `stopOnError: false`', async t => {
	const error = new Error('a');

	const result = await pMapSettledKeyed({a: 1, b: 2}, (value, key) => {
		if (key === 'a') {
			throw error;
		}

		return value;
	}, {stopOnError: false});

	t.deepEqual(result, {a: rejected(error), b: fulfilled(2)});
});

test('pMapSettledKeyed - validates `concurrency`', async t => {
	for (const concurrency of [0, -1, 1.5, '2', Number.NaN]) {
		// eslint-disable-next-line no-await-in-loop
		await t.throwsAsync(pMapSettledKeyed({a: 1}, value => value, {concurrency}), {instanceOf: TypeError, message: /Expected `concurrency`/});
	}

	t.deepEqual(await pMapSettledKeyed({a: 1}, value => value, {concurrency: Number.POSITIVE_INFINITY}), {a: fulfilled(1)});
});

test('pMapSettledKeyed - starts exactly `concurrency` mappers, and a mapper that throws frees its slot', async t => {
	const gates = {a: createDeferred(), b: createDeferred(), c: createDeferred()};
	const startedKeys = [];
	const error = new Error('a');

	const promise = pMapSettledKeyed({a: 'a', b: 'b', c: 'c'}, async (value, key) => {
		startedKeys.push(key);
		await gates[key].promise;

		if (key === 'a') {
			throw error;
		}

		return value;
	}, {concurrency: 1});

	await drainEventLoop();
	t.deepEqual(startedKeys, ['a']);

	gates.a.resolve();
	await drainEventLoop();
	t.deepEqual(startedKeys, ['a', 'b']);

	gates.b.resolve();
	gates.c.resolve();

	t.deepEqual(await promise, {a: rejected(error), b: fulfilled('b'), c: fulfilled('c')});
});

test('pMapSettledKeyed - `pMapStop` waits for the keys before it, and drops the keys after it that settled first', async t => {
	const error = new Error('a');
	const firstGate = createDeferred();
	let isSettled = false;

	const promise = pMapSettledKeyed({a: 'a', b: 'b', c: 'c', d: Promise.reject(new Error('d'))}, async (value, key) => {
		if (key === 'a') {
			await firstGate.promise;
			throw error;
		}

		if (key === 'b') {
			return pMapStop;
		}

		return value;
	});

	promise.then(() => {
		isSettled = true;
	});

	await drainEventLoop();
	t.false(isSettled);

	firstGate.resolve();

	t.deepEqual(await promise, {a: rejected(error)});
});

test('pMapSettledKeyed - `pMapSkip` and `pMapStop` with a `Map`', async t => {
	const error = new Error('b');

	const result = await pMapSettledKeyed(new Map([
		['a', 1],
		['b', Promise.reject(error)],
		['c', 3],
		['d', 4],
		['e', Promise.reject(new Error('after the stop'))],
	]), (value, key) => {
		if (key === 'a') {
			return pMapSkip;
		}

		if (key === 'd') {
			return pMapStop;
		}

		return value;
	}, {concurrency: 1});

	t.deepEqual(result, new Map([['b', rejected(error)], ['c', fulfilled(3)]]));
});

test('pMapSettledKeyed - keeps a rejection reason that is not an error as is', async t => {
	const result = await pMapSettledKeyed({
		a: Promise.reject(undefined), // eslint-disable-line prefer-promise-reject-errors
		b: Promise.reject('reason'), // eslint-disable-line prefer-promise-reject-errors
		c: {
			then(resolve, reject) { // eslint-disable-line unicorn/no-thenable
				reject(0);
			},
		},
	}, value => value);

	t.deepEqual(result, {a: rejected(undefined), b: rejected('reason'), c: rejected(0)});
});

test('pMapSettledKeyed - empty input', async t => {
	let mapperCallCount = 0;
	const mapper = value => {
		mapperCallCount++;
		return value;
	};

	const result = await pMapSettledKeyed({}, mapper);
	t.is(Object.getPrototypeOf(result), null);
	t.deepEqual(Reflect.ownKeys(result), []);

	const mapResult = await pMapSettledKeyed(new Map(), mapper);
	t.true(mapResult instanceof Map);
	t.is(mapResult.size, 0);

	t.is(mapperCallCount, 0);
});

test('pMapSettledKeyed - matches `Promise.allSettled` for random inputs', async t => {
	const random = createSeededRandom(1337);

	for (let round = 0; round < 60; round++) {
		const kinds = Array.from({length: random(8)}, () => random(6));
		const errors = kinds.map((kind, index) => new Error(`${index}`));
		const concurrency = [1, 2, 3, Number.POSITIVE_INFINITY][random(4)];

		const createValue = (kind, index) => {
			switch (kind) {
				case 0: {
					return index;
				}

				case 1: {
					return Promise.resolve(index);
				}

				case 2: {
					return Promise.reject(errors[index]);
				}

				case 3: {
					return {
						then(resolve) { // eslint-disable-line unicorn/no-thenable
							resolve(index);
						},
					};
				}

				case 4: {
					return {
						then() { // eslint-disable-line unicorn/no-thenable
							throw errors[index];
						},
					};
				}

				default: {
					return Promise.resolve().then(() => {
						throw errors[index];
					});
				}
			}
		};

		const createEntries = () => kinds.map((kind, index) => [`key${index}`, createValue(kind, index)]);

		// eslint-disable-next-line no-await-in-loop
		const settled = await Promise.allSettled(createEntries().map(([, value]) => value));
		const expectedEntries = kinds.map((kind, index) => [`key${index}`, settled[index]]);

		// eslint-disable-next-line no-await-in-loop
		t.deepEqual(await pMapSettledKeyed(Object.fromEntries(createEntries()), value => value, {concurrency}), Object.fromEntries(expectedEntries));
		// eslint-disable-next-line no-await-in-loop
		t.deepEqual(await pMapSettledKeyed(new Map(createEntries()), value => value, {concurrency}), new Map(expectedEntries));

		// Without a rejection, `pMapKeyed` matches `Promise.all`.
		if (!kinds.some(kind => kind === 2 || kind >= 4)) {
			// eslint-disable-next-line no-await-in-loop
			const values = await Promise.all(createEntries().map(([, value]) => value));
			// eslint-disable-next-line no-await-in-loop
			t.deepEqual(await pMapKeyed(Object.fromEntries(createEntries()), value => value, {concurrency}), Object.fromEntries(kinds.map((kind, index) => [`key${index}`, values[index]])));
		}
	}
});

test('pMapIterable - a pull that rejects after the source reported `done` does not drop an element waiting for a mapper, without `preserveOrder`', async t => {
	const source = manualSource();
	const {mapper: gated, release} = gatedMapper();

	// Elements 0 to 2 hold every mapper slot until they are released.
	const valuesPromise = collectAsyncIterable(pMapIterable(source, value => (value < 3 ? gated(value) : value), {concurrency: 3, backpressure: Number.POSITIVE_INFINITY, preserveOrder: false}));

	for (let pullIndex = 0; pullIndex < 3; pullIndex++) {
		await drainEventLoop(); // eslint-disable-line no-await-in-loop
		source.pulls[pullIndex].resolve({done: false, value: pullIndex});
	}

	await drainEventLoop();
	t.is(source.pulls.length, 6);

	// Element 3 waits for a mapper slot, pull 4 ends the source, and pull 5, which started before the end was known, rejects after it.
	source.pulls[3].resolve({done: false, value: 3});
	await drainEventLoop();
	source.pulls[4].resolve({done: true, value: undefined});
	await drainEventLoop();
	source.pulls[5].reject(new Error('after the end'));
	await drainEventLoop();

	for (const value of [0, 1, 2]) {
		release(value);
	}

	// `done` is final, like in `for await`, so the rejection after it is dropped, and every element before it is still mapped.
	const values = await valuesPromise;
	t.deepEqual(values.sort(), [0, 1, 2, 3]);
});

test('pMapIterable - a pull that rejects in the same tick as, but after, the `done` of an earlier pull does not drop an element waiting for a mapper, without `preserveOrder`', async t => {
	const source = manualSource();
	const {mapper: gated, release} = gatedMapper();

	const valuesPromise = collectAsyncIterable(pMapIterable(source, value => (value < 3 ? gated(value) : value), {concurrency: 3, backpressure: Number.POSITIVE_INFINITY, preserveOrder: false}));

	for (let pullIndex = 0; pullIndex < 3; pullIndex++) {
		await drainEventLoop(); // eslint-disable-line no-await-in-loop
		source.pulls[pullIndex].resolve({done: false, value: pullIndex});
	}

	await drainEventLoop();
	source.pulls[3].resolve({done: false, value: 3});
	await drainEventLoop();

	// The worker of pull 5 handles its rejection before the slot of pull 5 is given back.
	source.pulls[4].resolve({done: true, value: undefined});
	source.pulls[5].reject(new Error('after the end'));
	await drainEventLoop();

	for (const value of [0, 1, 2]) {
		release(value);
	}

	const values = await valuesPromise;
	t.deepEqual(values.sort(), [0, 1, 2, 3]);
});

test('pMapIterable - a later `done` does not move the end of the source, so a pull that rejects between two `done` pulls is dropped, without `preserveOrder`', async t => {
	const source = manualSource();
	const {mapper: gated, release} = gatedMapper();

	// Elements 0 to 3 hold every mapper slot until they are released.
	const valuesPromise = collectAsyncIterable(pMapIterable(source, value => (value < 4 ? gated(value) : value), {concurrency: 4, backpressure: Number.POSITIVE_INFINITY, preserveOrder: false}));

	for (let pullIndex = 0; pullIndex < 4; pullIndex++) {
		await drainEventLoop(); // eslint-disable-line no-await-in-loop
		source.pulls[pullIndex].resolve({done: false, value: pullIndex});
	}

	await drainEventLoop();
	source.pulls[4].resolve({done: false, value: 4});
	await drainEventLoop();
	t.is(source.pulls.length, 8);

	// Element 4 waits for a mapper slot. Pull 5 ends the source, pull 7 reports `done` again, and pull 6, between them, rejects last.
	source.pulls[5].resolve({done: true, value: undefined});
	await drainEventLoop();
	source.pulls[7].resolve({done: true, value: undefined});
	await drainEventLoop();
	source.pulls[6].reject(new Error('after the end'));
	await drainEventLoop();

	for (const value of [0, 1, 2, 3]) {
		release(value);
	}

	const values = await valuesPromise;
	t.deepEqual(values.sort(), [0, 1, 2, 3, 4]);
});

test('pMapIterable - a pull that rejects before an earlier pull reports `done` still throws, without `preserveOrder`', async t => {
	const source = manualSource();
	const mapped = [];
	const {mapper: gated, release} = gatedMapper();

	const valuesPromise = collectAsyncIterable(pMapIterable(source, value => {
		mapped.push(value);
		return value < 3 ? gated(value) : value;
	}, {concurrency: 3, backpressure: Number.POSITIVE_INFINITY, preserveOrder: false}));

	for (let pullIndex = 0; pullIndex < 3; pullIndex++) {
		await drainEventLoop(); // eslint-disable-line no-await-in-loop
		source.pulls[pullIndex].resolve({done: false, value: pullIndex});
	}

	await drainEventLoop();
	source.pulls[3].resolve({done: false, value: 3});
	await drainEventLoop();

	// The rejection settles first, so it is delivered.
	source.pulls[5].reject(new Error('before the end'));
	source.pulls[4].resolve({done: true, value: undefined});

	await t.throwsAsync(valuesPromise, {message: 'before the end'});

	for (const value of [0, 1, 2]) {
		release(value);
	}

	await drainEventLoop();

	// Element 3 was waiting for a mapper, so it is dropped.
	t.deepEqual(mapped, [0, 1, 2]);
});

test('pMapIterable - a mapper error after the source reported `done` still stops an element waiting for a mapper, without `preserveOrder`', async t => {
	const source = manualSource();
	const mapped = [];
	const releases = new Map();

	const iterator = pMapIterable(source, value => {
		mapped.push(value);

		if (value >= 3) {
			return value;
		}

		return new Promise((resolve, reject) => {
			releases.set(value, {resolve, reject});
		});
	}, {concurrency: 3, backpressure: Number.POSITIVE_INFINITY, preserveOrder: false})[Symbol.asyncIterator]();

	const first = iterator.next();

	for (let pullIndex = 0; pullIndex < 3; pullIndex++) {
		await drainEventLoop(); // eslint-disable-line no-await-in-loop
		source.pulls[pullIndex].resolve({done: false, value: pullIndex});
	}

	await drainEventLoop();
	source.pulls[3].resolve({done: false, value: 3});
	await drainEventLoop();
	source.pulls[4].resolve({done: true, value: undefined});
	await drainEventLoop();

	// The mapper of element 2 rejects after the end. Its slot is not given back, so the error is delivered and element 3 is not mapped.
	releases.get(2).reject(new Error('mapper'));
	await drainEventLoop();
	t.deepEqual(mapped, [0, 1, 2]);

	releases.get(0).resolve(0);
	releases.get(1).resolve(1);
	await drainEventLoop();
	t.deepEqual(mapped, [0, 1, 2]);

	await t.throwsAsync(first, {message: 'mapper'});
});

test('pMapIterable - a pull that rejects after the source reported `done` is dropped and does not drop an element waiting for a mapper, with `preserveOrder`', async t => {
	const source = manualSource();
	const {mapper: gated, release} = gatedMapper();

	const valuesPromise = collectAsyncIterable(pMapIterable(source, value => (value < 3 ? gated(value) : value), {concurrency: 3, backpressure: Number.POSITIVE_INFINITY}));

	for (let pullIndex = 0; pullIndex < 3; pullIndex++) {
		await drainEventLoop(); // eslint-disable-line no-await-in-loop
		source.pulls[pullIndex].resolve({done: false, value: pullIndex});
	}

	await drainEventLoop();
	t.is(source.pulls.length, 6);

	source.pulls[3].resolve({done: false, value: 3});
	await drainEventLoop();
	source.pulls[4].resolve({done: true, value: undefined});
	await drainEventLoop();
	source.pulls[5].reject(new Error('after the end'));
	await drainEventLoop();

	for (const value of [0, 1, 2]) {
		release(value);
	}

	t.deepEqual(await valuesPromise, [0, 1, 2, 3]);
});
