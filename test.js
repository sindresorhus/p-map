import test from 'ava';
import delay from 'delay';
import inRange from 'in-range';
import timeSpan from 'time-span';
import randomInt from 'random-int';
import pMap, {pMapIterable, pMapSkip} from './index.js';

const sharedInput = [
	[async () => 10, 300],
	[20, 200],
	[30, 100],
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
	t.true(inRange(end(), {start: 290, end: 430}));
});

test('concurrency: 1', async t => {
	const end = timeSpan();
	t.deepEqual(await pMap(sharedInput, mapper, {concurrency: 1}), [10, 20, 30]);
	t.true(inRange(end(), {start: 590, end: 760}));
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
	t.true(inRange(end(), {start: 290, end: 430}));
});

test('asyncIterator - concurrency: 1', async t => {
	const end = timeSpan();
	t.deepEqual(await pMap(new AsyncTestData(sharedInput), mapper, {concurrency: 1}), [10, 20, 30]);
	t.true(inRange(end(), {start: 590, end: 760}));
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
