'use strict';
module.exports = (iterable, mapper, opts) => new Promise((resolve, reject) => {
	const input = Array.from(iterable);

	if (input.length === 0) {
		resolve([]);
		return;
	}

	opts = Object.assign({
		concurrency: Infinity
	}, opts);

	let concurrency = opts.concurrency;

	if (concurrency === Infinity || concurrency > input.length) {
		concurrency = input.length;
	}

	if (!(Number.isFinite(concurrency) && concurrency >= 1)) {
		throw new TypeError('Expected `concurrency` to be a finite number from 1 and up');
	}

	const ret = new Array(input.length);
	let isRejected = false;
	let doneCount = 0;

	const next = i => {
		if (isRejected) {
			return;
		}

		if (doneCount === input.length) {
			resolve(ret);
			return;
		}

		if (i >= input.length) {
			return;
		}

		Promise.resolve(input[i])
			.then(el => mapper(el, i))
			.then(
				val => {
					doneCount++;
					ret[i] = val;
					next(i + concurrency);
				},
				err => {
					isRejected = true;
					reject(err);
				}
			);
	};

	for (let i = 0; i < concurrency; i++) {
		next(i);
	}
});
