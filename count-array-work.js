/* eslint-disable no-extend-native -- the helper below counts O(n) `Array` work and puts the prototype back in a `finally` */
import assertInRange from './assert-in-range.js';

// `Array.prototype` operations whose cost is proportional to the length of the array, rather
// than constant: `shift()` moves every entry after the removed one, and `slice()`, a
// one-element `splice()`, and `indexOf()` each walk the array. Doing one of those per mapped
// result makes consuming the results O(n^2) on the size of the input.
//
// Counting them keeps the guard deterministic. A wall-clock guard cannot see this, because the
// async machinery around each result costs far more than the array work does, so a run that is
// quadratic in its array work still looks linear in wall-clock time.
export default async function countArrayWork(work) {
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

// Assert that a run over `size` results both trims the results it has consumed and stays linear.
// The lower bound is what a run that drops the consumed prefix as it goes copies, at least one
// entry per result on average; a run that never trims copies nothing and holds every result it has
// ever produced. The upper bound is the opposite failure: a run that compacts, shifts, scans, or
// splices on every result does about `size` work per result.
export async function assertLinearArrayWork(t, build, size) {
	const entriesWorked = await countArrayWork(async () => build(size));
	assertInRange(t, entriesWorked, {start: size / 2, end: size * 10});
}
