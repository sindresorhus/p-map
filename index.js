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
		const iterator = iterable[Symbol.iterator] === undefined ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();

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
			isRejected = true;
			isResolved = true;
			reject_(reason);
			cleanup();
		};

		if (signal) {
			if (signal.aborted) {
				reject(signal.reason);
			}

			signal.addEventListener('abort', signalListener, {once: true});
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
			const isSyncIterator = iterable[Symbol.asyncIterator] === undefined;
			const iterator = isSyncIterator ? iterable[Symbol.iterator]() : iterable[Symbol.asyncIterator]();

			const promises = [];
			const promisesIndexFromInputIndex = {};
			const inputIndexFromPromisesIndex = [];
			let runningMappersCount = 0;
			let isDone = false;
			let inputIndex = 0;
			let outputIndex = 0; // Only used when `preserveOrder: true`

			// This event emitter prevents the race conditions that arises when:
			//  - `preserveOrder: false`
			//  - `promises` are added after `Promise.race` is invoked, since `Promise.race` only races the promises that existed in its input array at call time
			// More specifically, this occurs when (in addition to `preserveOrder: false`):
			//  - `concurrency === Number.PositiveInfinity && Number.PositiveInfinity === backpressure`
			//    - this forces us to forgo eagerly filling the `promises` pool to avoid infinite recursion
			//    - IMO this is the root of this problem, and a problem in and of itself: we should consider requiring a finite concurrency & backpressure
			//    - given the inability to eagerly filing the `promises` pool with infinite concurrency & backpressure, there are some situations in which specifying
			//      a finite concurrency & backpressure will be faster than specifying the otherwise faster-sounding infinite concurrency & backpressure
			//  - an async iterator input iterable
			//    - `mapNext` can't `trySpawn` until it `await`s its `next`, since the input iterable might be done
			//    - the initial `trySpawn` thus ends when the execution of `mapNext` is suspended to `await next`
			//  - the input iterable produces more than one element
			//    - the (single) running `mapNext`'s `trySpawn` _will necessarily_ (since concurrency and backpressure are infinite)
			//      start another `mapNext` promise that `trySpawn` adds to `promises`
			//    - this additional promise does not partake in the already-running `nextPromise`, because its underlying `Promise.race` began without it,
			//      when the initial `trySpawn` returned and `nextPromise` was invoked from the main loop
			const promiseEmitter = new EventTarget(); // Only used when `preserveOrder: false`
			const promiseEmitterEvent = 'promiseFulfilled';

			const nextPromise = preserveOrder
				// Treat `promises` as a queue
				? () => {
					// May be `undefined` bc of `pMapSkip`s (which `popPromise` and remove their `promisesIndexFromInputIndex` entries)
					while (promisesIndexFromInputIndex[outputIndex] === undefined) {
						outputIndex += 1;
					}

					return promises[promisesIndexFromInputIndex[outputIndex++]];
				}
				// Treat `promises` as a pool (order doesn't matter)
				: () => Promise.race([
					// Ensures correctness in the case that mappers resolve between the time that one `await nextPromise()` resolves and the next `nextPromise` call is made
					// (these promises would otherwise be lost if an event emitter is not listening - the `promises` pool buffers resolved promises to be processed)
					// (I wonder if it may be actually be possible to convert the `preserveOrder: false` case to _exclusively_ event-based,
					//  but such a solution may get messy since we'd want to `yield` from a callback, likely requiring a resolved promises buffer anyway...)
					Promise.race(promises),
					// Ensures correctness in the case that more promises are added to `promises` after the initial `nextPromise` call is made
					// (these additional promises are not be included in the above `Promise.race`)
					// (see comment above `promiseEmitter` declaration for details on when this can occur)
					new Promise(resolve => {
						promiseEmitter.addEventListener(promiseEmitterEvent, r => resolve(r.detail), {once: true});
					}),
				]);

			function popPromise(inputIndex) {
				// Swap the fulfilled promise with the last element to avoid an O(n) shift to the `promises` array
				const tail = promises.pop();
				const tailInputIndex = inputIndexFromPromisesIndex.pop();
				const promisesIndex = promisesIndexFromInputIndex[inputIndex];
				delete promisesIndexFromInputIndex[inputIndex];

				if (promisesIndex !== promises.length) {
					promises[promisesIndex] = tail;
					inputIndexFromPromisesIndex[promisesIndex] = tailInputIndex;
					promisesIndexFromInputIndex[tailInputIndex] = promisesIndex;
				}
			}

			async function mapNext(promisesIndex) {
				const myInputIndex = inputIndex++; // Save this promise's index before `trySpawn`ing others
				runningMappersCount++;
				promisesIndexFromInputIndex[myInputIndex] = promisesIndex;
				inputIndexFromPromisesIndex[promisesIndex] = myInputIndex;

				let next;
				try {
					next = iterator.next();
					if (!isSyncIterator) { // `!isSyncIterator` iff `isPromiseLike(next)`, but former is already computed
						// Optimization: if our concurrency and/or backpressure is bounded (so that we won't infinitely recurse),
						// and we need to `await` the next `iterator` element, we first eagerly spawn more `mapNext` promises,
						// so that these promises can begin `await`ing their respective `iterator` elements (if needed) and `mapper` results in parallel.
						// This may entail memory usage closer to `options.backpressure` than necessary, but this space was already allocated to `pMapIterable` via
						// `options.concurrency` and `options.backpressure`.
						// This may also cause iteration well past the end of the `iterator`: we don't inspect the `iterator`'s response before `trySpawn`ing
						// (because we are `trySpawn`ing before `await`ing the response), which will request the next `iterator` element, so we may end up spawning many promises which resolve to `done`.
						// However, the time needed to `await` and ignore these `done` promises is presumed to be small relative to the time needed to perform common
						// `async` operations like disk reads, network requests, etc.
						// Overall, this can reduce the total time taken to process all elements.
						// Potential TODO: in the `concurrency === Number.POSITIVE_INFINITY` case, we could potentially still optimize here by eagerly spawning some # of promises.
						if (backpressure !== Number.POSITIVE_INFINITY) {
							// Spawn if still below concurrency and backpressure limit
							trySpawn();
						}

						next = await next;
					}
				} catch (error) {
					isDone = true;
					return {result: {error}, inputIndex: myInputIndex};
				}

				let {done, value} = next;
				if (done) {
					isDone = true;
					return {result: {done: true}, inputIndex: myInputIndex};
				}

				// Spawn if still below concurrency and backpressure limit
				trySpawn();

				let returnValue;
				try {
					if (isPromiseLike(value)) {
						value = await value;
					}

					returnValue = mapper(value, myInputIndex);
					if (isPromiseLike(returnValue)) {
						returnValue = await returnValue;
					}
				} catch (error) {
					isDone = true;
					return {result: {error}, inputIndex: myInputIndex};
				}

				runningMappersCount--;

				if (returnValue === pMapSkip) {
					// We `popPromise` ourselves so that we don't eat into the backpressure if we don't get `await`ed/cleanup up by the main loop for a while.
					// This is safe because the main loop will forgo `popPromise` when `pMapSkip` is produced.
					popPromise(myInputIndex);
				}

				// Spawn if still below backpressure limit and just dropped below concurrency limit
				trySpawn();

				return {result: {value: returnValue}, inputIndex: myInputIndex};
			}

			function trySpawn() {
				if (isDone || !(runningMappersCount < concurrency && promises.length < backpressure)) {
					return;
				}

				// Reserve index in `promises` array: we don't actually have the promise to save yet,
				// but we don't want recursive `trySpawn` calls to use this same index.
				// This is safe (i.e., the empty slot won't be `await`ed) because we replace the value immediately,
				// without yielding to the event loop, so no consumers (namely `nextPromise`)
				// can observe the intermediate state.
				const promisesIndex = promises.length++;

				const promise = mapNext(promisesIndex);
				promise.then(p => {
					const event = new Event(promiseEmitterEvent);
					event.detail = p;
					promiseEmitter.dispatchEvent(event);
				});
				// If the input iterable is sync, produces a non-promise, and maps to a non-promise-wrapped `pMapSkip` (no Promises anywhere),
				// then `mapNext` may execute `popPromise` synchronously, which removes the empty array entry we created above and
				// deletes information pertaining to `promisesIndex` from the ledgers, only to have us confound the effort by writing
				// back into `promises` again here.
				if (promises[promisesIndex] === undefined) {
					promises[promisesIndex] = promise;
				}
			}

			// Bootstrap `promises`
			trySpawn();

			while (promises.length > 0) {
				const {result: {error, done, value}, inputIndex} = await nextPromise(); // eslint-disable-line no-await-in-loop

				if (value === pMapSkip) {
					// `mapNext` already called `popPromise` and `trySpawn` upon observing `pMapSkip`
					continue;
				}

				popPromise(inputIndex);

				if (error) {
					throw error;
				}

				if (done) {
					// When `preserveOrder: false`, `continue` to consume any remaining pending promises in the pool
					if (!preserveOrder) {
						continue;
					}

					return;
				}

				// Spawn if just dropped below backpressure limit and below the concurrency limit
				trySpawn();

				yield value;
			}
		},
	};
}

function isPromiseLike(p) {
	return typeof p === 'object' && p !== null && 'then' in p && typeof p.then === 'function';
}

export const pMapSkip = Symbol('skip');
