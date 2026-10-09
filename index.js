export default function pMap(iterable, mapper, options) {
	return mapConcurrently(iterable, mapper, options, false);
}

export function pMapSettled(iterable, mapper, options) {
	return mapConcurrently(iterable, mapper, options, true);
}

export function pMapKeyed(input, mapper, options) {
	return mapKeyed(input, mapper, options, false);
}

export function pMapSettledKeyed(input, mapper, options) {
	return mapKeyed(input, mapper, options, true);
}

// Like `Promise.allKeyed` and `Promise.allSettledKeyed`, with a mapper, and for a `Map` too. Each value travels with its key, so a skipped key, which leaves no slot in the result, cannot shift the keys after it.
async function mapKeyed(input, mapper, options, isSettled) {
	const entries = getKeyedEntries(input);

	// After the values have their handlers, like the other argument errors, which `mapConcurrently` checks. It cannot check this one, as it gets the wrapper below as its mapper.
	if (typeof mapper !== 'function') {
		throw new TypeError('Mapper function is required');
	}

	const mappedEntries = await mapConcurrently(entries, async ([key, inputResult]) => {
		try {
			if (inputResult.status === 'rejected') {
				throw inputResult.reason;
			}

			const result = await mapper(inputResult.value, key);

			if (result === pMapSkip || result === pMapStop) {
				return result;
			}

			return [key, isSettled ? {status: 'fulfilled', value: result} : result];
		} catch (error) {
			if (!isSettled) {
				throw error;
			}

			return [key, {status: 'rejected', reason: error}];
		}
	}, options, false);

	if (input instanceof Map) {
		return new Map(mappedEntries);
	}

	// A null prototype, like `Promise.allKeyed`, so a key like `__proto__` or `toString` is an own property like any other.
	return Object.setPrototypeOf(Object.fromEntries(mappedEntries), null);
}

// The engine behind all the functions, except `pMapIterable`. With `isSettled`, an element or a mapper that rejects gives a `{status: 'rejected'}` result instead of an error, like `Promise.allSettled`, so `stopOnError` does not apply.
async function mapConcurrently(
	iterable,
	mapper,
	{
		concurrency = Number.POSITIVE_INFINITY,
		stopOnError = true,
		signal,
	} = {},
	isSettled,
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

		// Settle only once the source is done, or a mapper stopped, and every earlier pull and mapper has finished. A pull before the `done` or the stop can still produce an element, while pulls after it do not affect the result.
		const settleIfFinished = () => {
			if (isResolved || doneIndex === Number.POSITIVE_INFINITY) {
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

			// A stop ended the result before the source did, so close it, like `for await` does on a `break`. Not at the stop itself, as a source that settles its `next()` calls out of call order may still owe an earlier element, and closing could drop it.
			if (!isIterableDone) {
				closeIterator(iterator);
			}

			// `done` is final, like `for await`, so a `done` that lands between two elements ends
			// the result there and everything the source produced past it is dropped. A stop cuts it the same way.
			const lastIndex = Math.min(doneIndex, result.length);

			// Every index below `lastIndex` has a value: an index only goes unassigned when its pull reported `done` or its mapper returned `pMapStop`, and the lowest such index is `doneIndex`. So the array is dense below `lastIndex`, and the fast path can hand it over untouched.
			if (lastIndex === result.length && skippedCount === 0) {
				resolve(result);
				return;
			}

			// Otherwise this drops the skipped results and whatever the `done` or the stop cut off.
			resolve(result.slice(0, lastIndex).filter(value => value !== pMapSkip));
		};

		const next = async () => {
			// After a `done` or a stop, a pull would take an item nobody is going to map, which a one-shot source, like a queue, would lose.
			if (isResolved || currentIndex >= doneIndex) {
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

			// Intentionally detached
			const runner = (async () => {
				try {
					const element = await nextItem.value;

					if (isResolved || index >= doneIndex) {
						return;
					}

					const value = await mapper(element, index);

					// Ignore an item produced after an earlier pull reported `done` or an earlier mapper returned `pMapStop`.
					if (index >= doneIndex) {
						return;
					}

					// A stop ends the result here, like a `done` from the source, so settling waits only for the earlier elements.
					if (value === pMapStop) {
						doneIndex = index;
						return;
					}

					if (value === pMapSkip) {
						skippedCount++;
					}

					result[index] = isSettled && value !== pMapSkip ? {status: 'fulfilled', value} : value;
				} catch (error) {
					if (index >= doneIndex) {
						return;
					}

					if (isSettled) {
						result[index] = {status: 'rejected', reason: error};
					} else if (stopOnError) {
						reject(error);
						return;
					} else {
						errors[index] = error;
					}
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

			// Link the runner to the returned promise, so the async stack trace of a mapper error reaches the caller. Nothing awaits the runner, so the trace would stop there, but V8 follows a reaction that resolves another promise. The link never settles, so it never resolves the returned promise. It is a new promise for each runner, as a shared one would keep a reaction for every element.
			runner.then(() => new Promise(() => {})).then(resolve_);
		};

		// Create the concurrent runners in a detached (non-awaited)
		// promise. We need this so we can await the `next()` calls
		// to stop creating runners before hitting the concurrency limit
		// if the iterable has already been marked as done or a mapper stopped.
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

				if (isResolved || currentIndex >= doneIndex) {
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

	if (!isLimit(backpressure, concurrency)) {
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
				let isIterableDone = false;

				// The lowest index whose pull reported `done`. Without `preserveOrder`, the pulls after it have their slots given back, so their errors are dropped.
				let doneIndex = Number.POSITIVE_INFINITY;

				// An element that is being read, or is waiting for a mapper, does not hold a mapper slot, so the next element can be read while the mappers run. Those elements have their own cap of `concurrency`, so the source never sees more than `concurrency` overlapping `next()` calls, even with `backpressure: Infinity`. `backpressure` caps everything in flight together.
				let readingCount = 0;
				let runningMappersCount = 0;

				// The workers waiting for a mapper slot, in the order they started waiting. A finished mapper hands its slot to the oldest one.
				const mapperWaiters = new Map();
				let mapperWaiterCount = 0;
				let wokenMapperWaiterCount = 0;

				const releaseMapperSlot = () => {
					if (wokenMapperWaiterCount === mapperWaiterCount) {
						runningMappersCount--;
						return;
					}

					mapperWaiters.get(wokenMapperWaiterCount)();
					mapperWaiters.delete(wokenMapperWaiterCount++);
				};

				let index = 0;

				// The lowest index whose mapper returned `pMapStop`, or, with `preserveOrder`, whose pull, element, or mapper threw. The stream ends there, like a `break` or a `throw` in a loop. Once it is set, nothing past it is pulled, and no pending element past it is mapped, while the earlier elements still finish and are yielded first. `isDone` cannot do this, as it would drop the values of the earlier elements too.
				let stopIndex = Number.POSITIVE_INFINITY;

				// Without `preserveOrder`, each spawn still takes a slot in `promises`, so `backpressure` counts the same, but the slots are filled in the order the workers settle rather than the order they were spawned in, so the consumer gets whichever result is ready first. A worker always fills the oldest empty slot, at `fillIndex`. An empty slot is `undefined`, and a filled one holds the result itself rather than a promise, so a result costs a promise only when the consumer has to wait for it, through `wake`.
				let fillIndex = 0;
				let wake;

				// The indexes of the pulls whose worker has not filled a slot yet, without `preserveOrder`.
				const unfilledIndexes = new Set();

				// The consumer waits only when the head is empty, and then the oldest empty slot is the head, so the first fill wakes it.
				const fillSlot = result => {
					promises[fillIndex++] = result;
					wake?.(result);
					wake = undefined;
				};

				const pull = createPuller(iterator);

				function trySpawn() {
					// Do not spawn once the consumer is gone, the source is done, or the stream ends at an earlier element. The pull would be wasted work, and for a one-shot source, like a queue, it takes an item nobody is going to ask for.
					if (isDone || isIterableDone || index > stopIndex || readingCount >= concurrency || promises.length - headIndex >= backpressure) {
						return;
					}

					readingCount++;

					// Take the index when the pull starts, not when it resolves, so a source that
					// settles its `next()` calls out of call order still gets the right position.
					const currentIndex = index++;

					// Errors must be returned as a value instead of rejecting, otherwise a promise that
					// the consumer abandons after an earlier error becomes an unhandled rejection.
					const promise = (async () => {
						try {
							let element;
							try {
								const {done, value} = await pull();

								if (done) {
									isIterableDone = true;
									doneIndex = Math.min(doneIndex, currentIndex);
									return {done: true};
								}

								// Spawn if still below the reading and backpressure limits
								trySpawn();

								element = await value;

								if (runningMappersCount < concurrency) {
									runningMappersCount++;
								} else {
									// `releaseMapperSlot` hands the slot over without decrementing `runningMappersCount`, so it is already counted.
									await new Promise(resolve => {
										mapperWaiters.set(mapperWaiterCount++, resolve);
									});
								}
							} finally {
								readingCount--;
							}

							// Spawn now that this element is no longer waiting for a mapper, so the next one is read while this one is mapped
							trySpawn();

							let returnValue;
							try {
								// The consumer stopped iterating, or the stream ends before this element, while this element was being read or waiting for a mapper, so drop it instead of doing work nobody will consume.
								if (isDone || currentIndex > stopIndex) {
									return {done: false, value: pMapSkip};
								}

								returnValue = await mapper(element, currentIndex);
							} finally {
								releaseMapperSlot();
							}

							if (returnValue === pMapStop) {
								stopIndex = Math.min(stopIndex, currentIndex);
							}

							return {done: false, value: returnValue};
						} catch (error) {
							// With `preserveOrder`, the error is thrown at its own position, after the results before it, so those still finish. Without it, the error is thrown as soon as it settles, so nothing still pending can be yielded anymore.
							// An error from a pull after the end of the source is dropped, as `done` is final, so it must have no effect. `doneIndex` is set before the worker that saw `done` settles, so its slot hand-back runs before the delivery check of any error that sees it here, and the two always agree.
							if (preserveOrder) {
								stopIndex = Math.min(stopIndex, currentIndex);
							} else if (currentIndex < doneIndex) {
								isDone = true;
							}

							return {error};
						}
					})();

					if (preserveOrder) {
						promises.push(promise);
						return;
					}

					promises.push(undefined);

					unfilledIndexes.add(currentIndex);

					// The worker never rejects, as errors are returned as a value.
					// The slot is filled here, a tick after the worker settles, rather than by the worker itself, for the same reason the consumer awaits a filled slot: so the consumer never runs, and pulls, earlier.
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
					});
				}

				trySpawn();

				try {
					while (headIndex < promises.length) {
						// Without `preserveOrder`, a filled slot holds the result itself, and it is still awaited. That takes one tick, like awaiting a settled promise, so the consumer, and its `trySpawn()`, never run earlier than with a promise in the slot. Taking a ready result without the tick can make the consumer pull before it sees a stop or the end of the source, and a one-shot source, like a queue, would lose that item.
						// eslint-disable-next-line no-await-in-loop
						const result = await (promises[headIndex] ?? new Promise(resolve => {
							wake = resolve;
						}));
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
							fillIndex -= headIndex;
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

						// The stream ends where the stop would have been yielded: after the earlier elements with `preserveOrder`, and after the results that were ready before it without.
						if (value === pMapStop) {
							return;
						}

						// Spawn if just dropped below the backpressure limit and still below the reading limit
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

export const pMapStop = Symbol('stop');

// The checks `pMap` and `pMapIterable` share, so both reject the same input the same way.
// `mapConcurrently` runs this inside its promise, so a bad argument rejects rather than throws.
function validateOptions(iterable, mapper, concurrency) {
	// Optional chaining, so a nullish input gets this message rather than Node's internal
	// "null is not iterable".
	if (iterable?.[Symbol.iterator] === undefined && iterable?.[Symbol.asyncIterator] === undefined) {
		throw new TypeError(`Expected \`input\` to be either an \`Iterable\` or \`AsyncIterable\`, got (${typeof iterable})`);
	}

	if (typeof mapper !== 'function') {
		throw new TypeError('Mapper function is required');
	}

	if (!isLimit(concurrency, 1)) {
		throw new TypeError(`Expected \`concurrency\` to be an integer from 1 and up or \`Infinity\`, got \`${concurrency}\` (${typeof concurrency})`);
	}
}

// Whether the value is an integer from `minimum` and up, or `Infinity`, as `concurrency` and `backpressure` must be.
function isLimit(value, minimum) {
	return (Number.isSafeInteger(value) && value >= minimum) || value === Number.POSITIVE_INFINITY;
}

// Read the entries of a `Map`, or else the own enumerable keys, strings and symbols, in the order and the way `Promise.allKeyed` does, all up front. Each value gets a handler right away, also like `Promise.allKeyed`, so a value that rejects before a mapper slot reaches it is not an unhandled rejection.
function getKeyedEntries(input) {
	if (input === null || (typeof input !== 'object' && typeof input !== 'function')) {
		throw new TypeError(`Expected \`input\` to be an object, got (${input === null ? 'null' : typeof input})`);
	}

	const entries = [];

	const addEntry = (key, value) => {
		// Resolve the whole entry, so the engine checks termination after the value settles and before the mapper runs.
		entries.push(Promise.resolve(value).then(
			value => [key, {status: 'fulfilled', value}],
			error => [key, {status: 'rejected', reason: error}],
		));
	};

	if (input instanceof Map) {
		for (const [key, value] of input) {
			addEntry(key, value);
		}
	} else {
		for (const key of Reflect.ownKeys(input)) {
			if (Object.getOwnPropertyDescriptor(input, key)?.enumerable) {
				addEntry(key, input[key]);
			}
		}
	}

	return entries;
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
