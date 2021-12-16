import AggregateError from 'aggregate-error';

export interface Options {
	/**
	Number of concurrently pending promises returned by `mapper`.

	Must be an integer from 1 and up or `Infinity`.

	@default Infinity
	*/
	readonly concurrency?: number;

	/**
	When `true`, the first mapper rejection will be rejected back to the consumer.

	When `false`, instead of stopping when a promise rejects, it will wait for all the promises to settle and then reject with an [aggregated error](https://github.com/sindresorhus/aggregate-error) containing all the errors from the rejected promises.

	Caveat: When `true`, any already-started async mappers will continue to run until they resolve or reject. In the case of infinite concurrency with sync iterables, *all* mappers are invoked on startup and will continue after the first rejection. [Issue #51](https://github.com/sindresorhus/p-map/issues/51) can be implemented for abort control.

	@default true
	*/
	readonly stopOnError?: boolean;
}

/**
Function which is called for every item in `input`. Expected to return a `Promise` or value.

@param element - Iterated element.
@param index - Index of the element in the source array.
*/
export type Mapper<Element = any, NewElement = unknown | typeof pMapSkip> = (
	element: Element,
	index: number
) => NewElement | Promise<NewElement>;

/**
@param input - Synchronous or asynchronous iterable that is iterated over concurrently, calling the `mapper` function for each element. Each iterated item is `await`'d before the `mapper` is invoked so the iterable may return a `Promise` that resolves to an item. Asynchronous iterables (different from synchronous iterables that return `Promise` that resolves to an item) can be used when the next item may not be ready without waiting for an asynchronous process to complete and/or the end of the iterable may be reached after the asynchronous process completes. For example, reading from a remote queue when the queue has reached empty, or reading lines from a stream.
@param mapper - Function which is called for every item in `input`. Expected to return a `Promise` or value.
@returns A `Promise` that is fulfilled when all promises in `input` and ones returned from `mapper` are fulfilled, or rejects if any of the promises reject. The fulfilled value is an `Array` of the fulfilled values returned from `mapper` in `input` order.

@example
```
import pMap from 'p-map';
import got from 'got';

const sites = [
	getWebsiteFromUsername('sindresorhus'), //=> Promise
	'https://avajs.dev',
	'https://github.com'
];

const mapper = async site => {
	const {requestUrl} = await got.head(site);
	return requestUrl;
};

const result = await pMap(sites, mapper, {concurrency: 2});

console.log(result);
//=> ['https://sindresorhus.com/', 'https://avajs.dev/', 'https://github.com/']
```
*/
export default async function pMap<Element = any, NewElement = unknown>(
	input: AsyncIterable<Element | Promise<Element>> | Iterable<Element | Promise<Element>>,
	mapper: Mapper<Element, NewElement>,
	{
		concurrency = Number.POSITIVE_INFINITY,
		stopOnError = true
	}: Options = {}
): Promise<Array<Exclude<NewElement, typeof pMapSkip>>> {
	return new Promise((resolve, reject_) => { // eslint-disable-line promise/param-names
		// @ts-expect-error: input is both Iterable|AsyncIterable
		if (input[Symbol.iterator] === undefined && input[Symbol.asyncIterator] === undefined) {
			throw new TypeError(`Expected \`input\` to be either an \`Iterable\` or \`AsyncIterable\`, got (${typeof input})`);
		}

		if (typeof mapper !== 'function') {
			throw new TypeError('Mapper function is required');
		}

		if (!((Number.isSafeInteger(concurrency) || concurrency === Number.POSITIVE_INFINITY) && concurrency >= 1)) {
			throw new TypeError(`Expected \`concurrency\` to be an integer from 1 and up or \`Infinity\`, got \`${concurrency}\` (${typeof concurrency})`);
		}

		const result: Array<Exclude<NewElement, typeof pMapSkip>> = [];
		const errors: any[] = [];
		const skippedIndexesMap = new Map();
		let isRejected = false;
		let isResolved = false;
		let isIterableDone = false;
		let resolvingCount = 0;
		let currentIndex = 0;
		// @ts-expect-error: input is both Iterable|AsyncIterable
		const iterator = input[Symbol.iterator] === undefined ? input[Symbol.asyncIterator]() : input[Symbol.iterator]();

		const reject = (reason: any) => {
			isRejected = true;
			isResolved = true;
			reject_(reason);
		};

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
						reject(new AggregateError(errors));
						return;
					}

					isResolved = true;

					if (!skippedIndexesMap.size) {
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

					const value = await mapper(element, index) as unknown;

					// Use Map to stage the index of the element.
					if (value === pMapSkip) {
						skippedIndexesMap.set(index, value);
					}

					result[index] = value as any;

					resolvingCount--;
					await next();
				} catch (error: unknown) {
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
						} catch (error: unknown) {
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
				} catch (error: unknown) {
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

/**
Return this value from a `mapper` function to skip including the value in the returned array.

@example
```
import pMap, {pMapSkip} from 'p-map';
import got from 'got';

const sites = [
	getWebsiteFromUsername('sindresorhus'), //=> Promise
	'https://avajs.dev',
	'https://example.invalid',
	'https://github.com'
];

const mapper = async site => {
	try {
		const {requestUrl} = await got.head(site);
		return requestUrl;
	} catch {
		return pMapSkip;
	}
};

const result = await pMap(sites, mapper, {concurrency: 2});

console.log(result);
//=> ['https://sindresorhus.com/', 'https://avajs.dev/', 'https://github.com/']
```
*/
export const pMapSkip = Symbol('skip');
