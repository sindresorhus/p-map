export default async function pMap(
	iterable,
	mapper,
	{
		concurrency = Number.POSITIVE_INFINITY,
		stopOnError = true,
		signal,
	} = {},
) {
	return new Promise((resolve_, reject_) => {
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
		const iterator = iterable[Symbol.asyncIterator] === undefined ? iterable[Symbol.iterator]() : iterable[Symbol.asyncIterator]();

		const signalListener = () => {
			reject(signal.reason);
		};

		const cleanup = () => {
			signal?.removeEventListener('abort', signalListener);
		};

		const resolve = value => {
			resolve_(value);
			cleanup();
		};

		const reject = reason => {
			if (isResolved) {
				return;
			}

			isRejected = true;
			isResolved = true;
			reject_(reason);
			cleanup();

			if (!isIterableDone) {
				closeIterator(iterator);
			}
		};

		if (signal) {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}

			signal.addEventListener('abort', signalListener, {once: true});
		}

		const next = async () => {
			if (isResolved) {
				return;
			}

			// Once the source reported `done`, don't pull again like `for await`. A source like a queue may block in `next()` after it is exhausted, which would hang the completion below.
			const nextItem = isIterableDone ? {done: true} : await iterator.next();

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
				} catch (error) {
					if (stopOnError) {
						reject(error);
						return;
					}

					errors.push(error);
				}

				resolvingCount--;

				// If the iterable throws we can't really continue regardless of `stopOnError` state
				// since an iterable is likely to continue throwing after it throws once.
				// If we continue calling `next()` indefinitely we will likely end up
				// in an infinite loop of failed iteration.
				try {
					await next();
				} catch (error) {
					reject(error);
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

	return {
		async * [Symbol.asyncIterator]() {
			const iterator = iterable[Symbol.asyncIterator] === undefined ? iterable[Symbol.iterator]() : iterable[Symbol.asyncIterator]();

			const promises = [];
			let pendingPromisesCount = 0;
			let isDone = false;
			let isIterableDone = false;
			let index = 0;

			function trySpawn() {
				// Don't pull again once the source reported `done`, like `for await`. A source like a queue may block in `next()` after it is exhausted.
				if (isDone || isIterableDone || !(pendingPromisesCount < concurrency && promises.length < backpressure)) {
					return;
				}

				pendingPromisesCount++;

				// Errors must be returned as a value instead of rejecting, otherwise a promise that
				// the consumer abandons after an earlier error becomes an unhandled rejection.
				const promise = (async () => {
					try {
						const {done, value} = await iterator.next();

						if (done) {
							isIterableDone = true;
							pendingPromisesCount--;
							return {done: true};
						}

						// Spawn if still below concurrency and backpressure limit
						trySpawn();

						const currentIndex = index++;
						const element = await value;

						// The consumer stopped iterating or a mapper threw while this input was pending, so drop it instead of doing work nobody will consume.
						if (isDone) {
							pendingPromisesCount--;
							return {done: false, value: pMapSkip};
						}

						const returnValue = await mapper(element, currentIndex);

						pendingPromisesCount--;

						if (returnValue === pMapSkip) {
							const index = promises.indexOf(promise);

							if (index > 0) {
								promises.splice(index, 1);
							}
						}

						// Spawn if still below backpressure limit and just dropped below concurrency limit
						trySpawn();

						return {done: false, value: returnValue};
					} catch (error) {
						pendingPromisesCount--;
						isDone = true;
						return {error};
					}
				})();

				promises.push(promise);
			}

			trySpawn();

			try {
				while (promises.length > 0) {
					const result = await promises[0]; // eslint-disable-line no-await-in-loop
					const {done, value} = result;

					promises.shift();

					if (Object.hasOwn(result, 'error')) {
						throw result.error;
					}

					if (done) {
						return;
					}

					// Spawn if just dropped below backpressure limit and below the concurrency limit
					trySpawn();

					if (value === pMapSkip) {
						continue;
					}

					yield value;
				}
			} finally {
				// Stop pulling input once the consumer stops iterating, otherwise pending skipped mappers keep spawning work.
				isDone = true;

				if (!isIterableDone) {
					closeIterator(iterator);
				}
			}
		},
	};
}

export const pMapSkip = Symbol('skip');

// Close the source so it can release its resources, like `for await` does.
// Callers must not await this so a source that is blocked in `next()` cannot block them.
async function closeIterator(iterator) {
	try {
		await iterator.return?.();
	} catch {}
}
