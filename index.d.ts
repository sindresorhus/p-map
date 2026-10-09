type BaseOptions = {
	/**
	Number of concurrently pending promises returned by `mapper`.

	Must be an integer from 1 and up or `Infinity`.

	The right value depends on the work. Rules of thumb:
	- Network or database: the pool size or rate limit of the other side.
	- File system: tens to low hundreds, to avoid `EMFILE` errors.
	- Child processes or worker threads: [`os.availableParallelism()`](https://nodejs.org/api/os.html#osavailableparallelism).
	- Synchronous CPU-bound work: concurrency does not help.

	If unsure, start low and measure. See also the “Dynamic concurrency” recipe in the readme.

	`pMap` and `pMapSettled` can drop items that pulls from `input` already had in flight: when they stop early, because a mapper returns `pMapStop`, a mapper throws (only for `pMap`), or the `signal` aborts, and, with `concurrency` above 1, when one pull reports `done` while another still gets an item. That is invisible for a re-readable input, like an array or a string, but a source that cannot be re-read, such as a queue, loses those items. With `concurrency: 1`, only an abort can drop an item.

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

	An abort that comes from a timer or an I/O callback, like a `setTimeout`, cannot take effect while the mapping is inside a stretch of work that never waits on a timer or I/O. Draining a large input with mappers that just return a value is one such stretch, and there the run finishes first. This is the same for `Promise.all` and for a plain loop, and it goes away as soon as the mapper or the source waits on a timer or I/O.

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

/**
The options of `pMapSettled` and `pMapSettledKeyed`: those of `pMap`, except `stopOnError`, as they never reject for an error from `mapper`.
*/
export type SettledOptions = Omit<Options, 'stopOnError'>;

export type IterableOptions = BaseOptions & {
	/**
	Maximum number of elements taken from `input` that the consumer of the async iterable has not collected yet. That counts the elements being read, waiting for `mapper`, being mapped, and the results waiting to be collected. Calls to `mapper` will be limited so that there is never too much backpressure.

	Must be an integer from `concurrency` and up or `Infinity`.

	Useful whenever you are consuming the iterable slower than what the mapper function can produce concurrently. For example, to avoid making an overwhelming number of HTTP requests if you are saving each of the results to a database.

	A `backpressure` above `concurrency` also lets `pMapIterable` read ahead: up to `backpressure - concurrency` elements, but no more than `concurrency`, are read from `input` while the mappers run, so a slow `input` does not leave a mapper waiting for its next element. Useful when reading `input` is slow, for example when it is another `pMapIterable`. With `concurrency: 1`, `backpressure: 2` overlaps reading each element with mapping the one before it. When the iteration ends early, the elements read ahead are not mapped, so a source that cannot be re-read, such as a queue, loses them.

	A result of `pMapSkip` is collected by the consumer stepping over it, so it counts towards the limit until then. A mapper that skips most elements therefore still reads no further ahead than `backpressure` allows.

	`backpressure` defaults to `concurrency`, which defaults to `Infinity`, so by default nothing bounds how far `input` is read ahead of the consumer. A source that never ends is then read without limit until memory runs out. Give such a source a finite `concurrency`. That also bounds `backpressure`, since it defaults to `concurrency`.

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

type Control = typeof pMapSkip | typeof pMapStop;

/**
Function which is called for every item in `input`. Expected to return a `Promise` or value.

@param element - Iterated element.
@param index - Index of the element in the source array.
*/
export type Mapper<Element = any, NewElement = unknown> = (
	element: Element,
	index: number
) => MaybePromise<NewElement | Control>;

// The keys as `mapper` gets them: the keys of a `Map`, or else the keys of the object, where a number key, like `1` in `{1: 'a'}`, is a string at runtime. It goes through each member of a union input, as `keyof` would only give the keys they share.
type KeyedKey<Input> = Input extends ReadonlyMap<infer Key, unknown>
	? Key
	: Exclude<keyof Input, number> | `${Extract<keyof Input, number>}`;

type KeyedValue<Input> = Awaited<Input extends ReadonlyMap<unknown, infer Value> ? Value : Input[keyof Input]>;

// The mapper as `pMapKeyed` and `pMapSettledKeyed` take it. Unlike `KeyedMapper`, it does not add `pMapSkip` and `pMapStop` to the return type, so they stay in the inferred `NewValue`, where `KeyedResult` sees whether a key can be left out.
type KeyedMapperFunction<Input, NewValue> = (
	value: KeyedValue<Input>,
	key: KeyedKey<Input>
) => MaybePromise<NewValue>;

/**
Function which is called for every value in `input`. Expected to return a `Promise` or value.

@param value - The value, `await`'d.
@param key - The key of the value.
*/
// eslint-disable-next-line @typescript-eslint/ban-types
export type KeyedMapper<Input extends object = any, NewValue = unknown> = KeyedMapperFunction<Input, NewValue | Control>;

// Any other iterable, like an array or a `Set`, is accepted at runtime, like by `Promise.allKeyed`, but its keys are not what the types would describe, and for a `Set` there are none, so it is rejected here. An intersection, unlike a conditional type, also accepts the input of a generic caller.
type KeyedInput<Input> = Input & (ReadonlyMap<unknown, unknown> | {readonly [Symbol.iterator]?: never});

// A key is only optional when `mapper` can return `pMapSkip` or `pMapStop`, which leave it out. A mapper that returns `any` is not taken to return them.
type KeyedResult<Input, NewValue, Value> = Input extends ReadonlyMap<infer Key, unknown>
	? Map<Key, Value>
	: ([NewValue] extends [Exclude<NewValue, Control>] ? {-readonly [Key in keyof Input]: Value} : {-readonly [Key in keyof Input]?: Value});

// Any value returned from `mapper`. It is `unknown` spelled out, as `unknown | Control` would be just `unknown`, and naming `Control` makes TypeScript keep the `unique symbol` type of a mapper that only returns `pMapSkip` or `pMapStop`, like `() => pMapSkip`, instead of widening it to `symbol`, like the return type of `Mapper` does. TypeScript still widens it for an async mapper, as it then only keeps it when each part of the expected return type is a promise.
// eslint-disable-next-line @typescript-eslint/ban-types
type KeyedNewValue = {} | null | undefined | Control;

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
): Promise<Array<Exclude<NewElement, Control>>>;

/**
Like an async generator, a `return()` or `throw()` on the iterator that comes while a `next()` call is still pending waits for that `next()` to settle. A `break` in a `for await` loop is not affected, as the loop only stops between results. If `input` can block in `next()` for good, like a queue that waits for an item, stop it at the source, for example with an `AbortSignal` that it listens to.

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
): AsyncIterable<Exclude<NewElement, Control>>;

/**
A version of `pMap` for [`Promise.allSettled()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled): an error from `mapper`, or an element of `input` that rejects, does not reject the returned `Promise`.

An element of `input` that rejects gets a `{status: 'rejected', reason}` result, and `mapper` is not called for it. A `pMapSkip` result is left out, and `pMapStop` stops like in `pMap`.

The returned `Promise` still rejects when iterating `input` throws, like `Promise.allSettled()`, and when the `signal` aborts.

It takes the same options as `pMap`, except `stopOnError`.

Promises that are already in `input` are already running, so `concurrency` cannot limit them. With a finite `concurrency`, a promise that rejects before `pMapSettled` reaches it is reported as an unhandled rejection. For promises you already have, use `Promise.allSettled()`. With `pMapSettled`, give the values in `input` and start the async work in `mapper`.

@param input - Synchronous or asynchronous iterable that is iterated over concurrently, calling the `mapper` function for each element. Each iterated item is `await`'d before the `mapper` is invoked so the iterable may return a `Promise` that resolves to an item. Asynchronous iterables (different from synchronous iterables that return `Promise` that resolves to an item) can be used when the next item may not be ready without waiting for an asynchronous process to complete and/or the end of the iterable may be reached after the asynchronous process completes. For example, reading from a remote queue when the queue has reached empty, or reading lines from a stream.
@param mapper - Function which is called for every item in `input`. Expected to return a `Promise` or value.
@returns A `Promise` that is fulfilled when all promises in `input` and the ones returned from `mapper` are settled. The fulfilled value is an `Array` of objects in `input` order, the same as from `Promise.allSettled()`: `{status: 'fulfilled', value}` for each value returned from `mapper`, and `{status: 'rejected', reason}` for each error from `mapper` or from `input`.

@example
```
import {pMapSettled} from 'p-map';

const results = await pMapSettled(urls, async url => {
	const response = await fetch(url);
	return response.json();
}, {concurrency: 4});

for (const result of results) {
	if (result.status === 'fulfilled') {
		console.log(result.value);
	} else {
		console.error(result.reason);
	}
}
```
*/
export function pMapSettled<Element, NewElement>(
	input: AsyncIterable<Element | Promise<Element>> | Iterable<Element | Promise<Element>>,
	mapper: Mapper<Element, NewElement>,
	options?: SettledOptions
): Promise<Array<PromiseSettledResult<Exclude<NewElement, Control>>>>;

/**
A version of `pMap` for the values of an object or a `Map`, like [`Promise.allKeyed()`](https://github.com/tc39/proposal-await-dictionary) is for `Promise.all()`.

For an object, it uses the own enumerable keys, strings and symbols, like `Promise.allKeyed()`. For a `Map`, it uses the entries, and a key can be any value. A `Map` from another realm, like from `node:vm` or an iframe, is used as an object, so its entries are not mapped. All the values are read right away, and each value is `await`'d before `mapper` is called for it, so a value may be a `Promise`. With TypeScript, give an `input` of type `any`, like the result of `response.json()`, a specific type, like `as Record<string, string>`, as the result type is not useful otherwise.

A value that rejects gets a handler right away, so it is never an unhandled rejection, even when `concurrency` has not reached it yet.

A `pMapSkip` result leaves out the key, and `pMapStop` keeps only the keys before it.

It takes the same options as `pMap`.

@param input - An object or a `Map` whose values are mapped.
@param mapper - Function which is called with each value and its key. Expected to return a `Promise` or value.
@returns A `Promise` that is fulfilled with an object with the same keys, in the same order, and the values returned from `mapper`, or rejects if any of the values or the mappers reject. The object has a `null` prototype, like the one from `Promise.allKeyed()`. For a `Map`, it is a new `Map`.

@example
```
import {pMapKeyed} from 'p-map';

const {user, posts} = await pMapKeyed({
	user: 'https://example.com/api/user',
	posts: 'https://example.com/api/posts',
}, async url => {
	const response = await fetch(url);
	return response.json();
}, {concurrency: 2});
```
*/
// eslint-disable-next-line @typescript-eslint/ban-types
export function pMapKeyed<Input extends object, NewValue extends KeyedNewValue>(
	input: KeyedInput<Input>,
	mapper: KeyedMapperFunction<Input, NewValue>,
	options?: Options
): Promise<KeyedResult<Input, NewValue, Exclude<NewValue, Control>>>;

/**
A version of `pMapKeyed` for [`Promise.allSettledKeyed()`](https://github.com/tc39/proposal-await-dictionary): an error from `mapper`, or a value of `input` that rejects, does not reject the returned `Promise`.

It takes the same `input` and `mapper` as `pMapKeyed`, and the same options as `pMap`, except `stopOnError`.

A value of `input` that rejects gets a `{status: 'rejected', reason}` result, and `mapper` is not called for it. Each value gets a handler right away, so it is never an unhandled rejection. A `pMapSkip` result leaves out the key, and `pMapStop` keeps only the keys before it.

The returned `Promise` still rejects when reading `input` throws, and when the `signal` aborts.

@param input - An object or a `Map` whose values are mapped.
@param mapper - Function which is called with each value and its key. Expected to return a `Promise` or value.
@returns A `Promise` that is fulfilled with an object with the same keys, in the same order, when all the values and mappers are settled. Each value is `{status: 'fulfilled', value}` with the value returned from `mapper`, or `{status: 'rejected', reason}` with the error from `mapper` or from `input`, the same as from `Promise.allSettledKeyed()`. The object has a `null` prototype. For a `Map`, it is a new `Map`.

@example
```
import {pMapSettledKeyed} from 'p-map';

const {user, posts} = await pMapSettledKeyed({
	user: 'https://example.com/api/user',
	posts: 'https://example.com/api/posts',
}, async url => {
	const response = await fetch(url);
	return response.json();
}, {concurrency: 2});

if (user.status === 'fulfilled') {
	console.log(user.value);
}

if (posts.status === 'rejected') {
	console.error(posts.reason);
}
```
*/
// eslint-disable-next-line @typescript-eslint/ban-types
export function pMapSettledKeyed<Input extends object, NewValue extends KeyedNewValue>(
	input: KeyedInput<Input>,
	mapper: KeyedMapperFunction<Input, NewValue>,
	options?: SettledOptions
): Promise<KeyedResult<Input, NewValue, PromiseSettledResult<Exclude<NewValue, Control>>>>;

/**
Return this value from a `mapper` function to skip including the value in the returned array, or, for `pMapKeyed` and `pMapSettledKeyed`, to leave out the key.

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

`pMapKeyed` stops the same way, and keeps only the keys before it. `pMapSettled` and `pMapSettledKeyed` also stop the same way, but an error from an element before the stop gives a `{status: 'rejected', reason}` result instead of a rejection.

`pMapIterable` ends the stream where the stop would have been yielded: after the elements before it with `preserveOrder`, or after the results that were ready before it without.

`pMap`, `pMapSettled`, and `pMapIterable` then read no more elements from `input`, and close `input`. `pMapKeyed` and `pMapSettledKeyed` have read all the values already. Mappers that are still running are not canceled, and their results are dropped. The element that returns `pMapStop` adds no value to the result.

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
