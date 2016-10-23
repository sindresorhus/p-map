'use strict';
module.exports = (iterable, mapper, opts) => new Promise((resolve, reject) => {
	opts = Object.assign({
		concurrency: Infinity
	}, opts);

	const concurrency = opts.concurrency;

	if (concurrency < 1) {
		throw new TypeError('Expected `concurrency` to be a number from 1 upto Infinity');
	}

	const ret = [];
	const iterator = iterable[Symbol.iterator]();
	let isRejected = false;
	let iterableDone = false;
	let resolvingCount = 0;

	const next = i => {
		if (isRejected) {
			return;
		}

		const nextItem = iterator.next();

		if (nextItem.done) {
			iterableDone = true;
			if (resolvingCount === 0) {
				resolve(ret);
			}

			return;
		}

		resolvingCount++;
		Promise.resolve(nextItem.value)
			.then(el => mapper(el, i))
			.then(
				val => {
					ret[i] = val;
					resolvingCount--;
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
		if (iterableDone) {
			break;
		}
	}
});
