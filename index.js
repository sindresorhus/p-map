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
	let isSettled = false;
	let resolvingCount = 0;

	const next = i => {
		if (isSettled) {
			return;
		}

		const nextItem = iterator.next();
		if (nextItem.done) {
			if (resolvingCount === 0) {
				isSettled = true;
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
					isSettled = true;
					reject(err);
				}
			);
	};

	for (let i = 0; i < concurrency; i++) {
		next(i);
	}
});
