import AggregateError from 'aggregate-error';

export default async function pMap(
	iterable,
	mapper,
	{
		concurrency = Number.POSITIVE_INFINITY,
		stopOnError = true
	} = {}
) {
	return new Promise((resolve, reject) => {
		if (typeof mapper !== 'function') {
			throw new TypeError('Mapper function is required');
		}

		if (!((Number.isSafeInteger(concurrency) || concurrency === Number.POSITIVE_INFINITY) && concurrency >= 1)) {
			throw new TypeError(`Expected \`concurrency\` to be an integer from 1 and up or \`Infinity\`, got \`${concurrency}\` (${typeof concurrency})`);
		}

		const result = [];
		const errors = [];
		const skippedIndexes = [];
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
			const index = currentIndex;
			currentIndex++;

			if (nextItem.done) {
				isIterableDone = true;

				if (resolvingCount === 0) {
					if (!stopOnError && errors.length > 0) {
						reject(new AggregateError(errors));
					} else {
						for (const skippedIndex of skippedIndexes) {
							result.splice(skippedIndex, 1);
						}

						resolve(result);
					}
				}

				return;
			}

			resolvingCount++;

			(async () => {
				try {
					const element = await nextItem.value;

					if (isRejected) {
						return;
					}

					const value = await mapper(element, index);
					if (value === pMapSkip) {
						skippedIndexes.push(index);
					} else {
						result[index] = value;
					}

					resolvingCount--;
					next();
				} catch (error) {
					if (stopOnError) {
						isRejected = true;
						reject(error);
					} else {
						errors.push(error);
						resolvingCount--;

						// In that case we can't really continue regardless of stopOnError state
						// since an iterable is likely to continue throwing after it throws once.
						// If we continue calling next() indefinitely we will likely end up
						// in an infinite loop of failed iteration.
						try {
							next();
						} catch (error) {
							isRejected = true;
							reject(error);
						}
					}
				}
			})();
		};

		for (let index = 0; index < concurrency; index++) {
			// Catch errors from the iterable.next() call
			// In that case we can't really continue regardless of stopOnError state
			// since an iterable is likely to continue throwing after it throws once.
			// If we continue calling next() indefinitely we will likely end up
			// in an infinite loop of failed iteration.
			try {
				next();
			} catch (error) {
				isRejected = true;
				reject(error);
				break;
			}

			if (isIterableDone || isRejected) {
				break;
			}
		}
	});
}

export const pMapSkip = Symbol('skip');
