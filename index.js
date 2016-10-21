'use strict';
module.exports = (iterable, mapper, opts) => new Promise((resolve, reject) => {
	opts = Object.assign({
		concurrency: 1
	}, opts);

	const concurrency = opts.concurrency;

	if (!(Number.isFinite(concurrency) && concurrency >= 1)) {
		throw new TypeError('Expected `concurrency` to be a finite number from 1 and up');
	}

	const ret = [];
	const iterator = iterable[Symbol.iterator]();
	let isRejected = false;

	const next = i => {
		if (isRejected) {
			return;
		}

		const nextItem = iterator.next();
		if (nextItem.done) {
			resolve(ret);
			return;
		}

		Promise.resolve(nextItem.value)
			.then(el => mapper(el, i))
			.then(
				val => {
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
