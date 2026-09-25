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
		// Stage the errors by index, like `result`, so they are reported in input order.
		const errors = [];
		const skippedIndexesMap = new Map();
		let isResolved = false;
		let isIterableDone = false;
		const pendingIndexes = new Set();
		let doneIndex = Number.POSITIVE_INFINITY;
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

		// Serialize the pulls like `for await` does so every element keeps its input position
		// even when a source resolves its `next()` calls out of call order.
		const pull = createPuller(iterator, () => isIterableDone || isResolved);

		// Settle only once the source is done and every earlier pull and mapper has finished. A pull
		// before `done` can still produce an element, while pulls after it do not affect the result.
		const settleIfFinished = () => {
			if (isResolved || !isIterableDone) {
				return;
			}

			for (const index of pendingIndexes) {
				if (index < doneIndex) {
					return;
				}
			}

			if (!stopOnError) {
				const collectedErrors = [];

				for (let index = 0; index < Math.min(doneIndex, errors.length); index++) {
					if (index in errors) {
						collectedErrors.push(errors[index]);
					}
				}

				if (collectedErrors.length > 0) {
					reject(new AggregateError(collectedErrors)); // eslint-disable-line unicorn/error-message
					return;
				}
			}

			isResolved = true;

			// `done` is final, like `for await`, so a `done` that lands between two elements ends
			// the result there and everything the source produced past it is dropped.
			const lastIndex = Math.min(doneIndex, result.length);

			// Every index below `lastIndex` has a value: an index only goes unassigned when the pull
			// below it reported `done`, and that is at `doneIndex` itself. So the array is dense and
			// can be handed over as is unless there is a `pMapSkip` to drop.
			if (lastIndex === result.length && skippedIndexesMap.size === 0) {
				resolve(result);
				return;
			}

			const pureResult = [];

			for (let index = 0; index < lastIndex; index++) {
				// Support multiple `pMapSkip`'s.
				if (skippedIndexesMap.get(index) === pMapSkip) {
					continue;
				}

				pureResult.push(result[index]);
			}

			resolve(pureResult);
		};

		const next = async () => {
			if (isResolved) {
				return;
			}

			// Take the index when the pull starts, not when it resolves, so a source that settles
			// its `next()` calls out of call order still gets the right position.
			const index = currentIndex++;
			pendingIndexes.add(index);

			let nextItem;
			try {
				nextItem = await pull();
			} catch (error) {
				pendingIndexes.delete(index);

				if (index < doneIndex) {
					throw error;
				}

				settleIfFinished();
				return;
			}

			if (nextItem.done) {
				pendingIndexes.delete(index);
				doneIndex = Math.min(doneIndex, index);
				isIterableDone = true;
				settleIfFinished();
				return;
			}

			if (index >= doneIndex) {
				pendingIndexes.delete(index);
				settleIfFinished();
				return;
			}

			// Intentionally detached
			(async () => {
				try {
					const element = await nextItem.value;

					if (isResolved || index >= doneIndex) {
						return;
					}

					const value = await mapper(element, index);

					// Use Map to stage the index of the element.
					if (index >= doneIndex) {
						return;
					}

					if (value === pMapSkip) {
						skippedIndexesMap.set(index, value);
					}

					result[index] = value;
				} catch (error) {
					if (index >= doneIndex) {
						return;
					}

					if (stopOnError) {
						reject(error);
						return;
					}

					errors[index] = error;
				} finally {
					pendingIndexes.delete(index);
					settleIfFinished();
				}

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

				if (isIterableDone || isResolved) {
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
		[Symbol.asyncIterator]() {
			// `isDone` lives outside the generator so the wrapper below can set it the moment the
			// consumer asks to stop. The generator is suspended on a pending `next()` at that point,
			// so its `finally` would not run until much later and workers finishing in the meantime
			// would keep pulling and mapping input for nobody.
			let isDone = false;

			const generator = (async function * () {
				const iterator = iterable[Symbol.asyncIterator] === undefined ? iterable[Symbol.iterator]() : iterable[Symbol.asyncIterator]();

				const promises = [];
				let pendingPromisesCount = 0;
				let isIterableDone = false;
				let index = 0;

				// Serialize the pulls like `for await` does so every element keeps its input position
				// even when a source resolves its `next()` calls out of call order.
				const pull = createPuller(iterator, () => isDone || isIterableDone);

				function trySpawn() {
					// Do not spawn once the consumer is gone. The pull would be wasted work, and for a
					// one-shot source, like a queue, it takes an item nobody is going to ask for.
					if (isDone || isIterableDone || !(pendingPromisesCount < concurrency && promises.length < backpressure)) {
						return;
					}

					pendingPromisesCount++;

					// Errors must be returned as a value instead of rejecting, otherwise a promise that
					// the consumer abandons after an earlier error becomes an unhandled rejection.
					const promise = (async () => {
						try {
							// Take the index when the pull starts, not when it resolves, so a source that
							// settles its `next()` calls out of call order still gets the right position.
							const currentIndex = index++;
							const {done, value} = await pull();

							if (done) {
								isIterableDone = true;
								pendingPromisesCount--;
								return {done: true};
							}

							// Spawn if still below concurrency and backpressure limit
							trySpawn();

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
			})();

			return {
				async next() {
					return generator.next();
				},
				async return(value) {
					isDone = true;
					return generator.return(value);
				},
				async throw(error) {
					isDone = true;
					return generator.throw(error);
				},
				// Not `async`: `for await` takes the result of this call as the iterator itself, so
				// returning a promise here would leave it looking for `next()` on a promise.
				[Symbol.asyncIterator]() {
					return this;
				},
			};
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

// Pull the next item, in call order, so every element keeps its input position even when a
// source resolves its `next()` calls out of call order. Pulls are still issued as soon as they
// are requested, so a slow source is not stalled. Once `isStopped()` reports true we never pull
// again: a source like a queue may block in `next()` after it is exhausted, which would hang
// the caller.
function createPuller(iterator, isStopped) {
	const pendingPulls = new Map();
	let pulledCount = 0;
	let pullIndex = 0;
	let isSourceDone = false;

	return () => {
		if (isSourceDone || isStopped()) {
			return {done: true};
		}

		const result = iterator.next();

		// `done` is final, like `for await`, so anything the source produces after it is dropped.
		// A sync iterable, like an array, answers right away so it can be seen here. An async
		// iterable is seen below, as soon as its pull settles.
		const markDone = item => {
			if (item?.done) {
				isSourceDone = true;
			}
		};

		markDone(result);

		const pull = Promise.resolve(result);

		// A pull is only awaited once every pull before it has settled, so it can reject before
		// anyone is listening for it. This also marks `done` as soon as the pull settles.
		pull.then(markDone, () => {});
		pendingPulls.set(pulledCount++, pull);

		const index = pullIndex++;
		const nextItem = pendingPulls.get(index);
		pendingPulls.delete(index);
		return nextItem;
	};
}
