import test from 'ava';
import delay from 'delay';
import inRange from 'in-range';
import timeSpan from 'time-span';
import randomInt from 'random-int';
import AggregateError from 'aggregate-error';
import pMap from '.';

const input = [
	Promise.resolve([10, 300]),
	[20, 200],
	[30, 100]
];

const errorInput1 = [
	[20, 200],
	[30, 100],
	Promise.reject(new Error('foo')),
	Promise.reject(new Error('bar'))
];

const errorInput2 = [
	[20, 200],
	Promise.reject(new Error('bar')),
	[30, 100],
	Promise.reject(new Error('foo'))
];

const mapper = ([value, ms]) => delay(ms, {value});

test('main', async t => {
	const end = timeSpan();
	t.deepEqual(await pMap(input, mapper), [10, 20, 30]);
	t.true(inRange(end(), {start: 290, end: 430}));
});

test('concurrency: 1', async t => {
	const end = timeSpan();
	t.deepEqual(await pMap(input, mapper, {concurrency: 1}), [10, 20, 30]);
	t.true(inRange(end(), {start: 590, end: 760}));
});

test('concurrency: 4', async t => {
	const concurrency = 4;
	let running = 0;

	await pMap(new Array(100).fill(0), async () => {
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
	const input = new Array(10).map(() => randomInt(0, 100));
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
	await t.throwsAsync(pMap([], () => {}, {concurrency: 0}), TypeError);
	await t.notThrowsAsync(pMap([], () => {}, {concurrency: 1}));
	await t.notThrowsAsync(pMap([], () => {}, {concurrency: 10}));
	await t.notThrowsAsync(pMap([], () => {}, {concurrency: Infinity}));
});

test('immediately rejects when stopOnError is true', async t => {
	await t.throwsAsync(pMap(errorInput1, mapper, {concurrency: 1}), 'foo');
	await t.throwsAsync(pMap(errorInput2, mapper, {concurrency: 1}), 'bar');
});

test('aggregate errors when stopOnError is false', async t => {
	await t.notThrowsAsync(pMap(input, mapper, {concurrency: 1, stopOnError: false}));
	await t.throwsAsync(pMap(errorInput1, mapper, {concurrency: 1, stopOnError: false}), {instanceOf: AggregateError, message: /foo(.|\n)*bar/});
	await t.throwsAsync(pMap(errorInput2, mapper, {concurrency: 1, stopOnError: false}), {instanceOf: AggregateError, message: /bar(.|\n)*foo/});
});

test('aggregate errors using custom error class', async t => {
	class MyAggregateError extends AggregateError {
		constructor(errors) {
			super(errors);
			this.name = MyAggregateError;
			this.message = `MyAggregateError: ${this.message}`;
		}
	}

	await t.throwsAsync(pMap(errorInput1, mapper, {concurrency: 1, stopOnError: false, AggregateError: MyAggregateError}), {instanceOf: MyAggregateError, message: /^MyAggregateError: /});

	class DummyAggregateError extends Error {
		constructor(errors) {
			super(String(errors));
			this.errors = errors;
		}
	}

	await t.throwsAsync(pMap(errorInput1, mapper, {concurrency: 1, stopOnError: false, AggregateError: DummyAggregateError}), {instanceOf: DummyAggregateError, message: 'Error: foo,Error: bar'});
});
