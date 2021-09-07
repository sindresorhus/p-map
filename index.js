import AggregateError from 'aggregate-error';

export default async function pMap(
	iterable,
	mapper,
	{
		concurrency = Number.POSITIVE_INFINITY,
		stopOnError = true
	} = {}
) {
	return new Promise((resolve, reject_) => { // eslint-disable-line promise/param-names
		if (typeof mapper !== 'function') {
			throw new TypeError('Mapper function is required');
		}

		if (!((Number.isSafeInteger(concurrency) || concurrency === Number.POSITIVE_INFINITY) && concurrency >= 1)) {
			throw new TypeError(`Expected \`concurrency\` to be an integer from 1 and up or \`Infinity\`, got \`${concurrency}\` (${typeof concurrency})`);
		}

		const result = [];
		const errors = [];
		const skippedIndexes = [];
		let isRejected = false;
		let isIterableDone = false;
		let resolvingCount = 0;
		let currentIndex = 0;
		let asyncIterator = false;
		let iterator;

		if (iterable[Symbol.iterator] === undefined) {
			// We've got an async iterable
			iterator = iterable[Symbol.asyncIterator]();
			asyncIterator = true;
		} else {
			iterator = iterable[Symbol.iterator]();
		}

		const reject = reason => {
			isRejected = true;
			reject_(reason);
		};

		const next = async () => {
			if (isRejected) {
				return;
			}

			const nextItem = asyncIterator ? await iterator.next() : iterator.next();

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

			// Intentionally detached
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
					await next();
				} catch (error) {
					if (stopOnError) {
						reject(error);
					} else {
						errors.push(error);
						resolvingCount--;

						// In that case we can't really continue regardless of stopOnError state
						// since an iterable is likely to continue throwing after it throws once.
						// If we continue calling next() indefinitely we will likely end up
						// in an infinite loop of failed iteration.
						try {
							await next();
						} catch (error) {
							reject(error);
						}
					}
				}
			})();
		};

		// Create the concurrent runners in a detached (non-awaited)
		// promise.  We need this so we can await the next() calls
		// to stop creating runners before hitting the concurrency limit
		// if the iterable has already been marked as done.
		// NOTE: We *must* do this for async iterators otherwise we'll spin up
		// infinite next() calls by default and never start the event loop.
		(async () => {
			for (let index = 0; index < concurrency; index++) {
				try {
					// eslint-disable-next-line no-await-in-loop
					await next();
				} catch (error) {
					reject(error);
					break;
				}

				if (isIterableDone || isRejected) {
					break;
				}
			}
		})();
	});
}

export const pMapSkip = Symbol('skip');
