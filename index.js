'use strict';
const AggregateError = require('aggregate-error');

const pMap = (iterable, mapper, options) => new Promise((resolve, reject) => {
	options = Object.assign({
		concurrency: Infinity,
		aggregateErrorsWhenDone: false
	}, options);

	if (typeof mapper !== 'function') {
		throw new TypeError('Mapper function is required');
	}

	const {concurrency, aggregateErrorsWhenDone} = options;

	if (!(typeof concurrency === 'number' && concurrency >= 1)) {
		throw new TypeError(`Expected \`concurrency\` to be a number from 1 and up, got \`${concurrency}\` (${typeof concurrency})`);
	}

	const ret = [];
	const errors = [];
	const iterator = iterable[Symbol.iterator]();
	let isRejected = false;
	let isIterableDone = false;
	let resolvingCount = 0;
	let currentIndex = 0;

	const next = () => {
		if (isRejected) {
			return;
		}

		const nextItem = iterator.next();
		const i = currentIndex;
		currentIndex++;

		if (nextItem.done) {
			isIterableDone = true;

			if (resolvingCount === 0) {
				if (aggregateErrorsWhenDone && errors.length !== 0) {
					reject(new AggregateError(errors));
				} else {
					resolve(ret);
				}
			}

			return;
		}

		resolvingCount++;

		Promise.resolve(nextItem.value)
			.then(element => mapper(element, i))
			.then(
				value => {
					ret[i] = value;
					resolvingCount--;
					next();
				},
				error => {
					if (aggregateErrorsWhenDone) {
						errors.push(error);
						resolvingCount--;
						next();
					} else {
						isRejected = true;
						reject(error);
					}
				}
			);
	};

	for (let i = 0; i < concurrency; i++) {
		next();

		if (isIterableDone) {
			break;
		}
	}
});

module.exports = pMap;
// TODO: Remove this for the next major release
module.exports.default = pMap;
