import test from 'ava';
import {assertLinearArrayWork} from './count-array-work.js';
import {pMapIterable, pMapSkip} from './index.js';

function numberRange(length) {
	return Array.from({length}, (_, index) => index);
}

async function collect(iterable) {
	const values = [];

	for await (const value of iterable) {
		values.push(value);
	}

	return values;
}

// Serial, because the helper swaps out `Array.prototype` for the duration.
test.serial('pMapIterable - algorithmic complexity', async t => {
	// Guards against a per-result O(n) operation when consuming the mapped results.
	await assertLinearArrayWork(t, size => collect(pMapIterable(numberRange(size), value => value)), 10_000);
});

test.serial('pMapIterable - multiple pMapSkips - algorithmic complexity', async t => {
	// Guards against scanning for and removing each skipped result as it arrives.
	await assertLinearArrayWork(t, size => collect(pMapIterable(numberRange(size), () => pMapSkip)), 10_000);
});
