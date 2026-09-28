type BaseOptions = {
	/**
	Number of concurrently pending promises returned by `mapper`.

	Must be an integer from 1 and up or `Infinity`.

	`pMap` can drop items that pulls from `input` already had in flight: when it stops early, because a mapper throws or returns `pMapStop`, or the `signal` aborts, and, with `concurrency` above 1, when one pull reports `done` while another still gets an item. That is invisible for a re-readable input, like an array or a string, but a source that cannot be re-read, such as a queue, loses those items. With `concurrency: 1`, only an abort can drop an item.

	@default Infinity
	*/
	readonly concurrency?: number;
};

export type Options = BaseOptions & {
	/**
	When `true`, the first mapper rejection will be rejected back to the consumer.

	When `false`, instead of stopping when a promise rejects, it will wait for all the promises to settle and then reject with an [`AggregateError`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AggregateError) containing all the errors from the rejected promises.

	The errors are listed in the order of the input, not in the order the promises happened to settle in, so the same input always produces the same `AggregateError`.

	Caveat: When `true`, any already-started async mappers will continue to run until they resolve or reject. In the case of infinite concurrency with sync iterables, *all* mappers are invoked on startup and will continue after the first rejection. Use the `signal` option for abort control.

	@default true
	*/
	readonly stopOnError?: boolean;

	/**
	You can abort the promises using [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).

	An abort that comes from a timer or an I/O callback, like a `setTimeout`, cannot take effect while `pMap` is inside a stretch of work that never waits on a timer or I/O. Draining a large input with mappers that just return a value is one such stretch, and there the run finishes first. This is the same for `Promise.all` and for a plain loop, and it goes away as soon as the mapper or the source waits on a timer or I/O.

	@example
	```
	import pMap from 'p-map';
	import delay from 'delay';

	const abortController = new AbortController();

	setTimeout(() => {
		abortController.abort();
	}, 500);

	const mapper = async value => value;

	await pMap([delay(1000), delay(1000)], mapper, {signal: abortController.signal});
	// Throws AbortError (DOMException) after 500 ms.
	```
	*/
	readonly signal?: AbortSignal | undefined;
};

export type IterableOptions = BaseOptions & {
	/**
	Maximum number of promises returned by `mapper` that have resolved but not yet collected by the consumer of the async iterable. Calls to `mapper` will be limited so that there is never too much backpressure.

	Must be an integer from `concurrency` and up or `Infinity`.

	Useful whenever you are consuming the iterable slower than what the mapper function can produce concurrently. For example, to avoid making an overwhelming number of HTTP requests if you are saving each of the results to a database.

	A result of `pMapSkip` is collected by the consumer stepping over it, so it counts towards the limit until then. A mapper that skips most elements therefore still reads no further ahead than `backpressure` allows.

	`backpressure` defaults to `concurrency`, which defaults to `Infinity`, so nothing bounds the read-ahead by default. A source that never ends is then read without limit until memory runs out. Give such a source a finite `concurrency`. That also bounds `backpressure`, since it defaults to `concurrency`.

	Default: `options.concurrency`
	*/
	readonly backpressure?: number;

	/**
	Whether to yield the results in `input` order.

	When `false`, each result is yielded as soon as it is ready. A slow element then no longer holds back the results after it, and those results no longer fill up `backpressure` while they wait, so `mapper` keeps running at full `concurrency`. Use it when the order of the results does not matter.

	An error from `mapper` is then also thrown as soon as it happens, instead of after the results before it. The `index` passed to `mapper` is still the position in `input`.

	Default: `true`

	@example
	```
	import {pMapIterable} from 'p-map';

	// Each page is saved as soon as it is downloaded, without waiting for slower pages before it
	for await (const page of pMapIterable(urls, downloadPage, {concurrency: 8, preserveOrder: false})) {
		await savePage(page);
	}
	```
	*/
	readonly preserveOrder?: boolean;
};

type MaybePromise<T> = T | Promise<T>;

/**
Function which is called for every item in `input`. Expected to return a `Promise` or value.

@param element - Iterated element.
@param index - Index of the element in the source array.
*/
export type Mapper<Element = any, NewElement = unknown> = (
	element: Element,
	index: number
) => MaybePromise<NewElement | typeof pMapSkip | typeof pMapStop>;

/**
@param input - Synchronous or asynchronous iterable that is iterated over concurrently, calling the `mapper` function for each element. Each iterated item is `await`'d before the `mapper` is invoked so the iterable may return a `Promise` that resolves to an item. Asynchronous iterables (different from synchronous iterables that return `Promise` that resolves to an item) can be used when the next item may not be ready without waiting for an asynchronous process to complete and/or the end of the iterable may be reached after the asynchronous process completes. For example, reading from a remote queue when the queue has reached empty, or reading lines from a stream.
@param mapper - Function which is called for every item in `input`. Expected to return a `Promise` or value.
@returns A `Promise` that is fulfilled when all promises in `input` and the ones returned from `mapper` are fulfilled, or rejects if any of the promises reject. The fulfilled value is an `Array` of the fulfilled values returned from `mapper` in `input` order.

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
export default function pMap<Element, NewElement>(
	input: AsyncIterable<Element | Promise<Element>> | Iterable<Element | Promise<Element>>,
	mapper: Mapper<Element, NewElement>,
	options?: Options
): Promise<Array<Exclude<NewElement, typeof pMapSkip | typeof pMapStop>>>;

/**
@param input - Synchronous or asynchronous iterable that is iterated over concurrently, calling the `mapper` function for each element. Each iterated item is `await`'d before the `mapper` is invoked so the iterable may return a `Promise` that resolves to an item. Asynchronous iterables (different from synchronous iterables that return `Promise` that resolves to an item) can be used when the next item may not be ready without waiting for an asynchronous process to complete and/or the end of the iterable may be reached after the asynchronous process completes. For example, reading from a remote queue when the queue has reached empty, or reading lines from a stream.
@param mapper - Function which is called for every item in `input`. Expected to return a `Promise` or value.
@returns An async iterable that streams each return value from `mapper` in order, or as soon as each is ready when `preserveOrder` is `false`.

@example
```
import {pMapIterable} from 'p-map';

// Multiple posts are fetched concurrently, with limited concurrency and backpressure
for await (const post of pMapIterable(postIds, getPostMetadata, {concurrency: 8})) {
	console.log(post);
};
```
*/
export function pMapIterable<Element, NewElement>(
	input: AsyncIterable<Element | Promise<Element>> | Iterable<Element | Promise<Element>>,
	mapper: Mapper<Element, NewElement>,
	options?: IterableOptions
): AsyncIterable<Exclude<NewElement, typeof pMapSkip | typeof pMapStop>>;

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
export const pMapSkip: unique symbol;

/**
Return this value from a `mapper` function to stop iterating, like `break` in a loop.

`pMap` resolves with the results of the elements before it, in order, without waiting for the elements after it. Like in a loop, an error from an earlier element still rejects. An error from a later element rejects only if it happens before the stop. With `stopOnError: false`, only the errors from earlier elements are collected.

`pMapIterable` ends the stream where the stop would have been yielded: after the elements before it with `preserveOrder`, or after the results that were ready before it without.

Either way, no more elements are read from `input`, and `input` is then closed. Mappers that are still running are not canceled, and their results are dropped. The element that returns `pMapStop` adds no value to the result.

@example
```
import pMap, {pMapStop} from 'p-map';

function * pageNumbers() {
	for (let pageNumber = 1; ; pageNumber++) {
		yield pageNumber;
	}
}

const mapper = async pageNumber => {
	const page = await getPage(pageNumber);
	return page.items.length === 0 ? pMapStop : page;
};

const pages = await pMap(pageNumbers(), mapper, {concurrency: 4});

console.log(pages);
//=> Every page before the first empty page, in order
```
*/
export const pMapStop: unique symbol;
