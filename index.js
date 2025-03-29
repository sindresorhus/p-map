export default async function pMap(
	iterable,
	mapper,
	{
		concurrency = Number.POSITIVE_INFINITY,
		stopOnError = true,
		signal,
	} = {},
) {
	return new Promise((resolve, reject_) => {
		if (iterable[Symbol.iterator] === undefined && iterable[Symbol.asyncIterator] === undefined) {
			throw new TypeError(`Expected \`input\` to be either an \`Iterable\` or \`AsyncIterable\`, got (${typeof iterable})`);
		}

		if (typeof mapper !== 'function') {
			throw new TypeError('Mapper function is required');
		}

		if (!((Number.isSafeInteger(concurrency) && concurrency >= 1) || concurrency === Number.POSITIVE_INFINITY)) {
			throw new TypeError(`Expected \`concurrency\` to be an integer from 1 and up or \`Infinity\`, got \`${concurrency}\` (${typeof concurrency})`);
		}

		const result = [];
		const errors = [];
		const skippedIndexesMap = new Map();
		let isRejected = false;
		let isResolved = false;
		let isIterableDone = false;
		let resolvingCount = 0;
		let currentIndex = 0;
		const iterator = iterable[Symbol.iterator] === undefined ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();

		const reject = reason => {
			isRejected = true;
			isResolved = true;
			reject_(reason);
		};

		if (signal) {
			if (signal.aborted) {
				reject(signal.reason);
			}

			signal.addEventListener('abort', () => {
				reject(signal.reason);
			});
		}

		const next = async () => {
			if (isResolved) {
				return;
			}

			const nextItem = await iterator.next();

			const index = currentIndex;
			currentIndex++;

			// Note: `iterator.next()` can be called many times in parallel.
			// This can cause multiple calls to this `next()` function to
			// receive a `nextItem` with `done === true`.
			// The shutdown logic that rejects/resolves must be protected
			// so it runs only one time as the `skippedIndex` logic is
			// non-idempotent.
			if (nextItem.done) {
				isIterableDone = true;

				if (resolvingCount === 0 && !isResolved) {
					if (!stopOnError && errors.length > 0) {
						reject(new AggregateError(errors)); // eslint-disable-line unicorn/error-message
						return;
					}

					isResolved = true;

					if (skippedIndexesMap.size === 0) {
						resolve(result);
						return;
					}

					const pureResult = [];

					// Support multiple `pMapSkip`'s.
					for (const [index, value] of result.entries()) {
						if (skippedIndexesMap.get(index) === pMapSkip) {
							continue;
						}

						pureResult.push(value);
					}

					resolve(pureResult);
				}

				return;
			}

			resolvingCount++;

			// Intentionally detached
			(async () => {
				try {
					const element = await nextItem.value;

					if (isResolved) {
						return;
					}

					const value = await mapper(element, index);

					// Use Map to stage the index of the element.
					if (value === pMapSkip) {
						skippedIndexesMap.set(index, value);
					}

					result[index] = value;

					resolvingCount--;
					await next();
				} catch (error) {
					if (stopOnError) {
						reject(error);
					} else {
						errors.push(error);
						resolvingCount--;

						// In that case we can't really continue regardless of `stopOnError` state
						// since an iterable is likely to continue throwing after it throws once.
						// If we continue calling `next()` indefinitely we will likely end up
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
		// promise. We need this so we can await the `next()` calls
		// to stop creating runners before hitting the concurrency limit
		// if the iterable has already been marked as done.
		// NOTE: We *must* do this for async iterators otherwise we'll spin up
		// infinite `next()` calls by default and never start the event loop.
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

export function pMapIterable(
	iterable,
	mapper,
	{
		concurrency = Number.POSITIVE_INFINITY,
		backpressure = concurrency,
		preserveOrder = true,
	} = {},
) {
	if (iterable[Symbol.iterator] === undefined && iterable[Symbol.asyncIterator] === undefined) {
		throw new TypeError(`Expected \`input\` to be either an \`Iterable\` or \`AsyncIterable\`, got (${typeof iterable})`);
	}

	if (typeof mapper !== 'function') {
		throw new TypeError('Mapper function is required');
	}

	if (!((Number.isSafeInteger(concurrency) && concurrency >= 1) || concurrency === Number.POSITIVE_INFINITY)) {
		throw new TypeError(`Expected \`concurrency\` to be an integer from 1 and up or \`Infinity\`, got \`${concurrency}\` (${typeof concurrency})`);
	}

	if (!((Number.isSafeInteger(backpressure) && backpressure >= concurrency) || backpressure === Number.POSITIVE_INFINITY)) {
		throw new TypeError(`Expected \`backpressure\` to be an integer from \`concurrency\` (${concurrency}) and up or \`Infinity\`, got \`${backpressure}\` (${typeof backpressure})`);
	}

	if (typeof preserveOrder !== 'boolean') {
		throw new TypeError(`Expected \`preserveOrder\` to be a boolean, got \`${preserveOrder}\` (${typeof preserveOrder})`);
	}

	return {
		async * [Symbol.asyncIterator]() {
			const iterator = iterable[Symbol.asyncIterator] === undefined ? iterable[Symbol.iterator]() : iterable[Symbol.asyncIterator]();

			const promises = [];
			const popSpecificPromise = promise => promises.splice(promises.indexOf(promise), 1);
			const popNextPromise = preserveOrder ? _promise => promises.shift() : popSpecificPromise;

			let somePromiseHasSettled; // Only used when `preserveOrder: false`

			let runningMappersCount = 0;
			let isDone = false;
			let index = 0;

			const spawnInto = async deferredPromise => {
				let result;
				try {
					const {done, value} = await iterator.next();

					if (done) {
						result = {done: true};
					} else {
						runningMappersCount++;

						// Spawn if still below concurrency and backpressure limit
						trySpawn();

						const returnValue = await mapper(await value, index++);

						runningMappersCount--;

						if (returnValue === pMapSkip) {
							popSpecificPromise(deferredPromise.promise);
						}

						// Spawn if still below backpressure limit and just dropped below concurrency limit
						trySpawn();

						result = {done: false, value: returnValue};
					}
				} catch (error) {
					isDone = true;
					result = {error};
				}

				deferredPromise.resolve({promise: deferredPromise.promise, result});
				somePromiseHasSettled?.resolve(deferredPromise.promise);
			};

			function trySpawn() {
				if (isDone || !(runningMappersCount < concurrency && promises.length < backpressure)) {
					return;
				}

				// Create a deferred promise so `spawnInto` can `popSpecificPromise` what we push into `promises` (`indexOf` needs object reference)
				const deferredPromise = pDefer();
				promises.push(deferredPromise.promise);
				spawnInto(deferredPromise);
			}

			trySpawn();

			while (promises.length > 0) {
				somePromiseHasSettled = pDefer();

				const {promise, result: {error, done, value}} = await ( // eslint-disable-line no-await-in-loop
					preserveOrder
						// Treat `promises` as a queue
						? promises[0]
						// Treat `promises` as a pool (order doesn't matter)
						: Promise.race([
							// Ensures correctness in the case that mappers resolve between the time that one `await nextPromise()` resolves and the next `nextPromise` call is made
							// (these promises would otherwise be lost if an event emitter is not listening - the `promises` pool buffers resolved promises to be processed).
							// Basically, this is asking "did anyone finish?"
							Promise.race(promises), // We don't spread `promises` here to avoid copying a potentially large array
							// Ensures correctness in the case that more promises are added to `promises` after the initial `nextPromise` call is made
							// (these additional promises are not be included in the above `Promise.race`).
							// This occurs when `concurrency > 1`: the first `promise` will `trySpawn` and `promises.push` another promise before `await`ing the mapper,
							// but the ongoing `Promise.race(promises)` call from `nextPromise` is oblivious to this new promise as it was not present in `promises`
							// when the race began.
							somePromiseHasSettled.promise,
						])
				);

				if (value === pMapSkip) {
					// Promise already popped itself and ran `trySpawn`
					continue;
				}

				popNextPromise(promise);

				if (error) {
					throw error;
				}

				if (done) {
					if (preserveOrder) {
						// Consuming in-order means `promises` queue is now empty
						return;
					}

					// When consuming out-of-order, the `promises` pool may not yet be exhausted, but
					// future `trySpawn`s will not spawn (source has been exhausted) and there is no `value` to `yield`.
					continue;
				}

				// Spawn if just dropped below backpressure limit and below the concurrency limit
				trySpawn();

				yield value;
			}
		},
	};
}

export const pMapSkip = Symbol('skip');

// Copied from sindresorhus/p-defer
function pDefer() {
	const deferred = {};

	deferred.promise = new Promise((resolve, reject) => {
		deferred.resolve = resolve;
		deferred.reject = reject;
	});

	return deferred;
}
