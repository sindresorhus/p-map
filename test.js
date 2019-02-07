import test from 'ava';
import delay from 'delay';
import inRange from 'in-range';
import timeSpan from 'time-span';
import randomInt from 'random-int';
import pMap from '.';
import AggregateError from 'aggregate-error';

const input = [
	Promise.resolve([10, 300]),
	[20, 200],
	[30, 100]
];

const errorInput = [
	[20, 200],
	[30, 100],
	Promise.reject(new Error('foo')),
	Promise.reject(new Error('bar'))
];

const mapper = ([value, ms]) => delay(ms, {value});

test('main', async t => {
	const end = timeSpan();
	t.deepEqual(await pMap(input, mapper), [10, 20, 30]);
	t.true(inRange(end(), 290, 430));
});

test('concurrency: 1', async t => {
	const end = timeSpan();
	t.deepEqual(await pMap(input, mapper, {concurrency: 1}), [10, 20, 30]);
	t.true(inRange(end(), 590, 760));
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
	await t.throwsAsync(pMap([], () => {}, {concurrency: undefined}), TypeError);
	await t.notThrowsAsync(pMap([], () => {}, {concurrency: 1}));
	await t.notThrowsAsync(pMap([], () => {}, {concurrency: 10}));
	await t.notThrowsAsync(pMap([], () => {}, {concurrency: Infinity}));
});

test('aggregate error', async t => {
	await t.throwsAsync(m(errorInput, mapper, {concurrency: 1, aggregateError: true}), AggregateError);
});
