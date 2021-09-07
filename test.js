import test from 'ava';
import delay from 'delay';
import inRange from 'in-range';
import timeSpan from 'time-span';
import randomInt from 'random-int';
import AggregateError from 'aggregate-error';
import pMap, {pMapSkip} from './index.js';

const sharedInput = [
	Promise.resolve([10, 300]),
	[20, 200],
	[30, 100]
];

const errorInput1 = [
	[20, 200],
	[30, 100],
	[() => Promise.reject(new Error('foo')), 10],
	[() => {
		throw new Error('bar');
	}, 10]
];

const errorInput2 = [
	[20, 200],
	[() => Promise.reject(new Error('bar')), 10],
	[30, 100],
	[() => {
		throw new Error('foo');
	}, 10]
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
	}

	[Symbol.iterator]() {
		let index = 0;
		const max = this._max;
		const throwOnIndex = this._throwOnIndex;
		return {
			next() {
				if (index === throwOnIndex) {
					throw new Error(`throwing on index ${index}`);
				}

				const item = {value: index, done: index === max};
				index++;
				return item;
			}
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
	await t.throwsAsync(pMap(errorInput1, mapper, {concurrency: 1, stopOnError: false}), {instanceOf: AggregateError, message: /foo(.|\n)*bar/});
	await t.throwsAsync(pMap(errorInput2, mapper, {concurrency: 1, stopOnError: false}), {instanceOf: AggregateError, message: /bar(.|\n)*foo/});
});

test('pMapSkip', async t => {
	t.deepEqual(await pMap([
		1,
		pMapSkip,
		2
	], async value => value), [1, 2]);
});

test('do not run mapping after stop-on-error happened', async t => {
	const input = [1, delay(300, {value: 2}), 3];
	const mappedValues = [];
	await t.throwsAsync(
		pMap(input, async value => {
			mappedValues.push(value);
			if (value === 1) {
				await delay(100);
				throw new Error('Oops!');
			}
		},
		{concurrency: 1})
	);
	await delay(500);
	t.deepEqual(mappedValues, [1]);
});

test('catches exception from source iterator - 1st item', async t => {
	const input = new ThrowingIterator(100, 0);
	const mappedValues = [];
	await t.throwsAsync(pMap(
		input,
		async value => {
			mappedValues.push(value);
			await delay(100);
			return value;
		},
		{concurrency: 1}
	));
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
		{concurrency: 1}
	));
	await delay(300);
	t.deepEqual(mappedValues, [0]);
});

// The 2nd iterable item throwing after a 1st item mapper exception, with stopOnError false,
// is distinct from other cases because our next() is called from a catch block
test('catches exception from source iterator - 2nd item after 1st item mapper throw', async t => {
	const input = new ThrowingIterator(100, 1);
	const mappedValues = [];
	await t.throwsAsync(pMap(
		input,
		async value => {
			mappedValues.push(value);
			await delay(100);
			throw new Error('mapper threw error');
		},
		{concurrency: 1, stopOnError: false}
	));
	await delay(300);
	t.deepEqual(mappedValues, [0]);
});
