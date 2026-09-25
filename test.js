import process from 'node:process';
import {getEventListeners} from 'node:events';
import test from 'ava';
import delay from 'delay';
import timeSpan from 'time-span';
import randomInt from 'random-int';
import assertInRange from './assert-in-range.js';
import pMap, {pMapIterable, pMapSkip} from './index.js';

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

test('main', async t => {
	const end = timeSpan();
	t.deepEqual(await pMap(sharedInput, mapper), [10, 20, 30]);

	// We give it some leeway on both sides of the expected 300ms as the exact value depends on the machine and workload.
	assertInRange(t, end(), {start: 290, end: 430});
});

test('concurrency: 1', async t => {
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

test('handles empty iterable', async t => {
	t.deepEqual(await pMap([], mapper), []);
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

test('pMap - a source that resolves `done` before an earlier item does not drop that item', async t => {
	const source = outOfOrderSource(['a', 'b', 'c'], [50, 0, 0]);
	t.deepEqual(await pMap(source, value => value, {concurrency: 3}), ['a', 'b', 'c']);
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

test('asyncIterator - main', async t => {
	const end = timeSpan();
	t.deepEqual(await pMap(new AsyncTestData(sharedInput), mapper), [10, 20, 30]);

	// We give it some leeway on both sides of the expected 300ms as the exact value depends on the machine and workload.
	assertInRange(t, end(), {start: 290, end: 430});
});

test('asyncIterator - concurrency: 1', async t => {
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

test('asyncIterator - all mappers should run when concurrency is infinite, even after stop-on-error happened', async t => {
	const input = [1, async () => delay(300, {value: 2}), 3];
	const mappedValues = [];
	await t.throwsAsync(
		pMap(new AsyncTestData(input), async value => {
			if (typeof value === 'function') {
				value = await value();
			}

			mappedValues.push(value);
			if (value === 1) {
				await delay(100);
				throw new Error(`Oops! ${value}`);
			}
		}),
		{message: 'Oops! 1'},
	);
	await delay(500);
	t.deepEqual(mappedValues, [1, 3, 2]);
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

test('asyncIterator - get the correct exception after stop-on-error', async t => {
	const input = [1, async () => delay(200, {value: 2}), async () => delay(300, {value: 3})];
	const mappedValues = [];

	const task = pMap(new AsyncTestData(input), async value => {
		if (typeof value === 'function') {
			value = await value();
		}

		mappedValues.push(value);
		// Throw for each item - all should fail and we should get only the first
		await delay(100);
		throw new Error(`Oops! ${value}`);
	});
	await delay(500);
	await t.throwsAsync(task, {message: 'Oops! 1'});
	t.deepEqual(mappedValues, [1, 2, 3]);
});

test('incorrect input type', async t => {
	let mapperCalled = false;

	const task = pMap(123_456, async () => {
		mapperCalled = true;
		await delay(100);
	});
	await delay(500);
	await t.throwsAsync(task, {message: 'Expected `input` to be either an `Iterable` or `AsyncIterable`, got (number)'});
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

if (globalThis.AbortController !== undefined) {
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
		t.is(getEventListeners(abortController.signal, 'abort').length, 0);
	});
}

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

test('pMapIterable - concurrency: 1', async t => {
	const end = timeSpan();
	t.deepEqual(await collectAsyncIterable(pMapIterable(sharedInput, mapper, {concurrency: 1, backpressure: Number.POSITIVE_INFINITY})), [10, 20, 30]);

	// It could've only taken this much time if each were run in series
	assertInRange(t, end(), {start: 590, end: 760});
});

test('pMapIterable - concurrency: 2', async t => {
	const times = new Map();
	const end = timeSpan();

	t.deepEqual(await collectAsyncIterable(pMapIterable(longerSharedInput, value => {
		times.set(value[0], end());
		return mapper(value);
	}, {concurrency: 2, backpressure: Number.POSITIVE_INFINITY})), [10, 20, 30, 40, 50]);

	assertInRange(t, times.get(10), {start: 0, end: 50});
	assertInRange(t, times.get(20), {start: 0, end: 50});
	assertInRange(t, times.get(30), {start: 200, end: 250});
	assertInRange(t, times.get(40), {start: 300, end: 350});
	assertInRange(t, times.get(50), {start: 300, end: 350});
});

test('pMapIterable - backpressure', async t => {
	let currentValue;

	// Concurrency option is forced by an early check
	const asyncIterator = pMapIterable(longerSharedInput, async value => {
		currentValue = await mapper(value);
		return currentValue;
	}, {backpressure: 2, concurrency: 2})[Symbol.asyncIterator]();

	const {value: value1} = await asyncIterator.next();
	t.is(value1, 10);

	// If backpressure is not respected, than all items will be evaluated in this time
	await delay(600);

	t.is(currentValue, 30);

	const {value: value2} = await asyncIterator.next();
	t.is(value2, 20);

	await delay(100);

	t.is(currentValue, 40);
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

test('pMapIterable - a source whose `next()` settles out of order keeps input order', async t => {
	const source = outOfOrderSource(['a', 'b', 'c', 'd'], [50, 5, 40, 5]);
	t.deepEqual(await collectAsyncIterable(pMapIterable(source, (value, index) => `${value}${index}`, {concurrency: 4})), ['a0', 'b1', 'c2', 'd3']);
});

test('pMapIterable - the iterator it hands out can be consumed with `for await`', async t => {
	const iterator = pMapIterable([1, 2, 3], async value => value * 2, {concurrency: 2})[Symbol.asyncIterator]();
	const values = [];
	for await (const value of iterator) {
		values.push(value);
	}

	t.deepEqual(values, [2, 4, 6]);
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

test('pMapIterable - stops pulling input after the consumer breaks', async t => {
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

	const iterator = pMapIterable(source(), async value => {
		mapperCalls++;

		if (value > 0) {
			await gate;
			return pMapSkip;
		}

		return value;
	}, {concurrency: 2, backpressure: 2});

	for await (const value of iterator) { // eslint-disable-line no-unreachable-loop
		t.is(value, 0);
		break;
	}

	// Some elements were already in flight when the consumer stopped. How many is a matter of how
	// far the pipeline read ahead, so only the growth after the break is asserted.
	t.true(mapperCalls > 1);
	const mapperCallsAfterBreak = mapperCalls;

	release();
	await delay(50);

	t.is(mapperCalls, mapperCallsAfterBreak);
});

// `return()` has to take effect as soon as it is called. The generator is suspended on the
// `next()` the consumer never awaited, so its `finally` does not run until that settles, and
// without this the whole source is pulled and mapped in the meantime.
test('pMapIterable - stops pulling input when `return()` is called while a `next()` is pending', async t => {
	let mapperCalls = 0;
	let sourcePulls = 0;

	const source = [0, 1, 2, 3, 4];
	const iterable = {
		[Symbol.iterator]() {
			let index = 0;
			return {
				next() {
					sourcePulls++;
					return {done: false, value: source[index++]};
				},
			};
		},
	};

	const iterator = pMapIterable(iterable, async value => {
		mapperCalls++;
		// The first element is slow, so the generator is still waiting on it.
		await delay(value === 0 ? 60 : 0);
		return value;
	}, {concurrency: 2, backpressure: 4})[Symbol.asyncIterator]();

	const pending = iterator.next();
	await delay(1);
	await iterator.return();
	pending.catch(() => {});

	await delay(120);

	// Only the two elements that were already in flight.
	t.is(mapperCalls, 2);
	t.true(sourcePulls <= 3);
});

// The same window again, this time for cleanup: a short-circuited pull must not make the generator
// think the source ran out, or the source is never closed.
// Same as the `return()` case, but the consumer signals the stop with `throw()`.
test('pMapIterable - stops pulling input when `throw()` is called while a `next()` is pending', async t => {
	let mapperCalls = 0;

	const iterator = pMapIterable([0, 1, 2, 3, 4], async value => {
		mapperCalls++;
		// The first element is slow, so the generator is suspended on it when `throw()` lands.
		await delay(value === 0 ? 60 : 0);
		return value;
	}, {concurrency: 2, backpressure: 4})[Symbol.asyncIterator]();

	const pending = iterator.next();
	await delay(1);
	await t.throwsAsync(iterator.throw(new Error('injected')), {message: 'injected'});
	pending.catch(() => {});

	await delay(120);

	// Only the two elements that were already in flight.
	t.is(mapperCalls, 2);
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
	t.is(mapperCalls, 3);

	release();
	await delay(50);

	t.is(mapperCalls, 3);
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

test('pMapIterable - drops pending earlier input when a later mapper throws', async t => {
	let release;
	const gate = new Promise(resolve => {
		release = resolve;
	});

	const mappedValues = [];
	const input = [gate.then(() => 0), 1];

	const promise = t.throwsAsync(collectAsyncIterable(pMapIterable(input, async value => {
		mappedValues.push(value);
		throw new Error(`mapper error ${value}`);
	}, {concurrency: 2})));

	await delay(10);
	t.deepEqual(mappedValues, [1]);

	release();
	const error = await promise;
	t.is(error.message, 'mapper error 1');
	t.deepEqual(mappedValues, [1]);
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

	const end = timeSpan();

	for await (const value of pMapIterable(source(), async value => value, {concurrency: 2})) { // eslint-disable-line no-unreachable-loop
		t.is(value, 0);
		break;
	}

	t.true(end() < 100);
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
