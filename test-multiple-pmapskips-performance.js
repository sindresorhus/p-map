import test from 'ava';
import assertInRange from './assert-in-range.js';
import countArrayWork from './count-array-work.js';
import pMap, {pMapSkip} from './index.js';

function numberRange(length) {
	return Array.from({length}, (_, index) => index);
}

// Serial, because the helper swaps out `Array.prototype` for the duration.
test.serial('multiple pMapSkips - algorithmic complexity', async t => {
	// Guards against `pMapSkip` handling that scans or splices the result per skipped element,
	// which is O(n^2) on the number of `pMapSkip` items in the input. Only the upper bound: `pMap`
	// has no consumed prefix to trim, so there is no minimum amount of work to require.
	const size = 10_000;
	const entriesWorked = await countArrayWork(async () => pMap(numberRange(size), () => pMapSkip));
	assertInRange(t, entriesWorked, {end: size * 10});
});
