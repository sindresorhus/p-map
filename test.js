import test from 'ava';
import delay from 'delay';
import inRange from 'in-range';
import timeSpan from 'time-span';
import randomInt from 'random-int';
import m from './';

const input = [
	Promise.resolve([10, 300]),
	[20, 200],
	[30, 100]
];

const mapper = ([val, ms]) => delay(ms).then(() => val);

test('main', async t => {
	const end = timeSpan();
	t.deepEqual(await m(input, mapper), [10, 20, 30]);
	t.true(inRange(end(), 290, 320));
});

test('concurrency: 1', async t => {
	const end = timeSpan();
	t.deepEqual(await m(input, mapper, {concurrency: 1}), [10, 20, 30]);
	t.true(inRange(end(), 590, 650));
});

test('concurrency: 4', async t => {
	const concurrency = 4;
	let running = 0;

	await m(Array(100).fill(0), async () => {
		running++;
		t.true(running <= concurrency);
		await delay(randomInt(30, 200));
		running--;
	}, {concurrency});
});

test('handles empty iterable', async t => {
	t.deepEqual(await m([], mapper), []);
});
