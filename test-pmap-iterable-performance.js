/* eslint-disable no-extend-native -- the test below counts O(n) `Array` work and puts the prototype back in a `finally` */
import test from 'ava';
import assertInRange from './assert-in-range.js';
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

// `Array.prototype` operations whose cost is proportional to the length of the array, rather
// than constant: `shift()` moves every entry after the removed one, and `slice()`, a
// one-element `splice()`, and `indexOf()` each walk the array. Doing one of those per mapped
// result makes consuming the results O(n^2) on the size of the input.
//
// Counting them keeps the guard deterministic. A wall-clock guard cannot see this, because the
// async machinery around each result costs far more than the array work does, so a run that is
// quadratic in its array work still looks linear in wall-clock time.
async function countArrayWork(work) {
	const {shift, slice, splice, indexOf} = Array.prototype;
	const counts = {total: 0};

	const count = amount => {
		counts.total += amount;
	};

	Array.prototype.shift = function (...arguments_) {
		count(Math.max(0, this.length - 1));
		return shift.apply(this, arguments_);
	};

	Array.prototype.slice = function (...arguments_) {
		count(this.length - (arguments_[0] ?? 0));
		return slice.apply(this, arguments_);
	};

	Array.prototype.splice = function (...arguments_) {
		if (arguments_[1] === 1) {
			count(Math.max(0, this.length - arguments_[0] - 1));
		}

		return splice.apply(this, arguments_);
	};

	Array.prototype.indexOf = function (...arguments_) {
		count(this.length);
		return indexOf.apply(this, arguments_);
	};

	try {
		await work();
	} finally {
		Array.prototype.shift = shift;
		Array.prototype.slice = slice;
		Array.prototype.splice = splice;
		Array.prototype.indexOf = indexOf;
	}

	return counts.total;
}

// Serial, because it swaps out `Array.prototype` for the duration.
async function assertWorkScalesLinearly(t, build, size) {
	const entriesWorked = await countArrayWork(async () => collect(build(size)));

	// Linear work is a small constant per result. Compacting the consumed prefix costs one copy
	// per half of the array, so it stays linear. A run that compacts, shifts, scans, or splices
	// on every result does about `size` work per result, which is far over the bound below.
	assertInRange(t, entriesWorked, {start: 0, end: size * 10});
}

test.serial('pMapIterable - algorithmic complexity', async t => {
	// Guards against a per-result O(n) operation when consuming the mapped results.
	await assertWorkScalesLinearly(t, size => pMapIterable(numberRange(size), value => value), 10_000);
});

test.serial('pMapIterable - multiple pMapSkips - algorithmic complexity', async t => {
	// Guards against scanning for and removing each skipped result as it arrives.
	await assertWorkScalesLinearly(t, size => pMapIterable(numberRange(size), () => pMapSkip), 10_000);
});
