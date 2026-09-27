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
		validateOptions(iterable, mapper, concurrency);

		const result = [];
		// Stage the errors by index, like `result`, so they are reported in input order.
		const errors = [];
		let skippedCount = 0;
		let isResolved = false;
		let isIterableDone = false;
		const pendingIndexes = new Set();
		let doneIndex = Number.POSITIVE_INFINITY;
		let currentIndex = 0;
		const iterator = getIterator(iterable);

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

		const pull = createPuller(iterator);

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
			// below it reported `done`, and that is at `doneIndex` itself. So the array is dense
			// below `lastIndex`, and the fast path can hand it over untouched.
			if (lastIndex === result.length && skippedCount === 0) {
				resolve(result);
				return;
			}

			// Otherwise this drops the skipped results and whatever the `done` cut off.
			resolve(result.slice(0, lastIndex).filter(value => value !== pMapSkip));
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

					// Ignore an item produced after an earlier pull reported `done`.
					if (index >= doneIndex) {
						return;
					}

					if (value === pMapSkip) {
						skippedCount++;
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
		preserveOrder = true,
	} = {},
) {
	validateOptions(iterable, mapper, concurrency);

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
				const iterator = getIterator(iterable);

				// Results are consumed from the front with a moving `headIndex` instead of `shift()`.
				// `shift()` moves every remaining entry, which is O(n) per element and made the whole
				// run O(n²) whenever `backpressure` let the array grow, which is the default.
				let promises = [];
				let headIndex = 0;
				let pendingPromisesCount = 0;
				let isIterableDone = false;
				let index = 0;

				// Without `preserveOrder`, each spawn still takes a slot in `promises`, so `backpressure` counts the same, but the slots are filled in the order the workers settle rather than the order they were spawned in, so the consumer gets whichever result is ready first. A worker always fills the oldest empty slot, so the resolvers are used in spawn order.
				const slotResolvers = new Map();
				let slotCount = 0;
				let filledSlotCount = 0;

				// The indexes of the pulls whose worker has not filled a slot yet, without `preserveOrder`.
				const unfilledIndexes = new Set();

				const fillSlot = result => {
					slotResolvers.get(filledSlotCount)(result);
					slotResolvers.delete(filledSlotCount++);
				};

				const pull = createPuller(iterator);

				function trySpawn() {
					// Do not spawn once the consumer is gone. The pull would be wasted work, and for a
					// one-shot source, like a queue, it takes an item nobody is going to ask for.
					if (isDone || isIterableDone || !(pendingPromisesCount < concurrency && promises.length - headIndex < backpressure)) {
						return;
					}

					pendingPromisesCount++;

					// Take the index when the pull starts, not when it resolves, so a source that
					// settles its `next()` calls out of call order still gets the right position.
					const currentIndex = index++;

					// Errors must be returned as a value instead of rejecting, otherwise a promise that
					// the consumer abandons after an earlier error becomes an unhandled rejection.
					const promise = (async () => {
						try {
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

							return {done: false, value: returnValue};
						} catch (error) {
							pendingPromisesCount--;
							isDone = true;
							return {error};
						}
					})();

					if (preserveOrder) {
						promises.push(promise);
						promise.then(() => {
							// Spawn if still below backpressure limit and just dropped below concurrency limit
							trySpawn();
						});
						return;
					}

					promises.push(new Promise(resolve => {
						slotResolvers.set(slotCount++, resolve);
					}));

					unfilledIndexes.add(currentIndex);

					// The worker never rejects, as errors are returned as a value.
					promise.then(result => {
						// The slot was already given back, as the pull came after the end of the source.
						if (!unfilledIndexes.delete(currentIndex)) {
							return;
						}

						if (result.done) {
							// The pulls made after this one came after the end of the source, and a source like a queue may never answer them, so give their slots back now instead of waiting on them.
							for (const unfilledIndex of unfilledIndexes) {
								if (unfilledIndex > currentIndex) {
									unfilledIndexes.delete(unfilledIndex);
									fillSlot({done: true});
								}
							}
						}

						fillSlot(result);
						trySpawn();
					});
				}

				trySpawn();

				try {
					while (headIndex < promises.length) {
						const result = await promises[headIndex]; // eslint-disable-line no-await-in-loop
						const {done, value} = result;

						// Release the entry instead of leaving it for a `shift()` to move, and drop the
						// consumed prefix once it is at least half the array. That keeps the backing
						// store proportional to the results still in flight rather than to the total
						// ever spawned, which matters for an endless source, while costing one copy per
						// half of the array, so it stays O(1) per element.
						promises[headIndex] = undefined;
						headIndex++;

						if (headIndex * 2 >= promises.length) {
							promises = promises.slice(headIndex);
							headIndex = 0;
						}

						if (Object.hasOwn(result, 'error')) {
							throw result.error;
						}

						if (done) {
							// Without `preserveOrder`, the `done` can arrive while other workers are still running.
							if (preserveOrder) {
								return;
							}

							continue;
						}

						// Spawn if just dropped below backpressure limit and below the concurrency limit
						trySpawn();

						// A `pMapSkip` result stays in `promises` and is stepped over here. Splicing it out
						// in the worker instead would make every skip an O(n) scan and move, so a run of
						// skips would be O(n²).
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

			// Override `return()` and `throw()` on the generator itself instead of wrapping it, so it
			// keeps what it inherits, like `Symbol.asyncDispose` for `await using`, and `next()` stays
			// the native one. Plain functions, not `async`: the generator already returns a promise,
			// and an `async` function would wrap it in two more promises and two more microtask hops.
			const {return: generatorReturn, throw: generatorThrow} = generator;

			generator.return = value => {
				isDone = true;
				return generatorReturn.call(generator, value);
			};

			generator.throw = error => {
				isDone = true;
				return generatorThrow.call(generator, error);
			};

			return generator;
		},
	};
}

export const pMapSkip = Symbol('skip');

// The checks `pMap` and `pMapIterable` share, so both reject the same input the same way.
// `pMap` runs this inside its promise, so a bad argument rejects rather than throws.
function validateOptions(iterable, mapper, concurrency) {
	// Optional chaining, so a nullish input gets this message rather than Node's internal
	// "null is not iterable".
	if (iterable?.[Symbol.iterator] === undefined && iterable?.[Symbol.asyncIterator] === undefined) {
		throw new TypeError(`Expected \`input\` to be either an \`Iterable\` or \`AsyncIterable\`, got (${typeof iterable})`);
	}

	if (typeof mapper !== 'function') {
		throw new TypeError('Mapper function is required');
	}

	if (!((Number.isSafeInteger(concurrency) && concurrency >= 1) || concurrency === Number.POSITIVE_INFINITY)) {
		throw new TypeError(`Expected \`concurrency\` to be an integer from 1 and up or \`Infinity\`, got \`${concurrency}\` (${typeof concurrency})`);
	}
}

// Take the async iterator when the input has both, like `for await` does.
function getIterator(iterable) {
	return iterable[Symbol.asyncIterator] === undefined ? iterable[Symbol.iterator]() : iterable[Symbol.asyncIterator]();
}

// Close the source so it can release its resources, like `for await` does.
// Callers must not await this so a source that is blocked in `next()` cannot block them.
async function closeIterator(iterator) {
	try {
		await iterator.return?.();
	} catch {}
}

// Pull the next item, and stop pulling once the source has reported `done`: a source like a queue
// may block in `next()` after it is exhausted, which would hang the caller. `done` is final, like
// `for await`, so anything the source produces after it is dropped.
function createPuller(iterator) {
	let isSourceDone = false;

	// A sync iterable, like an array, answers right away, so `done` can be seen here. An async
	// iterable is seen in the `then` below, as soon as its pull settles.
	const markDone = item => {
		if (item?.done) {
			isSourceDone = true;
		}
	};

	return () => {
		if (isSourceDone) {
			return {done: true};
		}

		const result = iterator.next();
		markDone(result);

		// A sync iterable, like an array, answers right away, so `done` has been read already and
		// the result can go back untouched.
		if (typeof result?.then !== 'function') {
			return result;
		}

		// An async iterable settles later, so `done` is read off the pull once it does. That is a
		// branch of its own, which leaves the caller awaiting the pull itself rather than a promise
		// derived from it, so an async source does not pay an extra microtask per element. The
		// rejection is handled here as well as by the caller, so a pull cannot escape as an
		// unhandled rejection.
		result.then(markDone, () => {});

		return result;
	};
}
