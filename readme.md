# p-map

> Map over promises concurrently

Useful when you need to run promise-returning & async functions multiple times with different inputs concurrently.

This is different from `Promise.all()` in that you can control the concurrency and also decide whether or not to stop iterating when there's an error.

## Install

```sh
npm install p-map
```

## Usage

```js
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

## API

Except for `pMapIterable`, each function is a version of a `Promise` method that maps each element and limits the concurrency:

| `Promise` | p-map |
| --- | --- |
| `Promise.all()` | [`pMap`](#pmapinput-mapper-options) |
| `Promise.allSettled()` | [`pMapSettled`](#pmapsettledinput-mapper-options) |
| `Promise.allKeyed()` | [`pMapKeyed`](#pmapkeyedinput-mapper-options) |
| `Promise.allSettledKeyed()` | [`pMapSettledKeyed`](#pmapsettledkeyedinput-mapper-options) |

`Promise.allKeyed()` and `Promise.allSettledKeyed()` are a [Stage 3 proposal](https://github.com/tc39/proposal-await-dictionary), so they may not be in your JavaScript engine yet. `pMapKeyed` and `pMapSettledKeyed` work without them.

### pMap(input, mapper, options?)

Returns a `Promise` that is fulfilled when all promises in `input` and the ones returned from `mapper` are fulfilled, or rejects if any of the promises reject. The fulfilled value is an `Array` of the fulfilled values returned from `mapper` in `input` order.

### pMapSettled(input, mapper, options?)

A version of `pMap` for [`Promise.allSettled()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled): an error from `mapper`, or an element of `input` that rejects, does not reject the returned `Promise`.

Returns a `Promise` that is fulfilled when all promises in `input` and the ones returned from `mapper` are settled. The fulfilled value is an `Array` of objects in `input` order, the same as from `Promise.allSettled()`: `{status: 'fulfilled', value}` for each value returned from `mapper`, and `{status: 'rejected', reason}` for each error from `mapper` or from `input`.

```js
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

An element of `input` that rejects gets a `{status: 'rejected', reason}` result, and `mapper` is not called for it. A [`pMapSkip`](#pmapskip) result is left out, and [`pMapStop`](#pmapstop) stops like in `pMap`.

The returned `Promise` still rejects when iterating `input` throws, like `Promise.allSettled()`, and when the [`signal`](#signal) aborts.

It takes the same options as `pMap`, except [`stopOnError`](#stoponerror).

> [!NOTE]
> Promises that are already in `input` are already running, so `concurrency` cannot limit them. With a finite `concurrency`, a promise that rejects before `pMapSettled` reaches it is reported as an unhandled rejection. For promises you already have, use `Promise.allSettled()`. With `pMapSettled`, give the values in `input` and start the async work in `mapper`.

### pMapKeyed(input, mapper, options?)

A version of `pMap` for the values of an object or a `Map`, like [`Promise.allKeyed()`](https://github.com/tc39/proposal-await-dictionary) is for `Promise.all()`.

Returns a `Promise` that is fulfilled with an object with the same keys, in the same order, and the values returned from `mapper`, or rejects if any of the values or the mappers reject. The object has a `null` prototype, like the one from `Promise.allKeyed()`. For a `Map`, it is a new `Map`.

```js
import {pMapKeyed} from 'p-map';

const {user, posts} = await pMapKeyed({
	user: 'https://example.com/api/user',
	posts: 'https://example.com/api/posts',
}, async url => {
	const response = await fetch(url);
	return response.json();
}, {concurrency: 2});
```

`input` is an object or a `Map`. For an object, it uses the own enumerable keys, strings and symbols, like `Promise.allKeyed()`. For a `Map`, it uses the entries, and a key can be any value. A `Map` from another realm, like from `node:vm` or an iframe, is used as an object, so its entries are not mapped. All the values are read right away, and each value is `await`'d before `mapper` is called for it, so a value may be a `Promise`. With TypeScript, give an `input` of type `any`, like the result of `response.json()`, a specific type, like `as Record<string, string>`, as the result type is not useful otherwise.

`mapper(value, key)` is called with each value and its key. Expected to return a `Promise` or value.

A value that rejects gets a handler right away, so it is never an unhandled rejection, even when `concurrency` has not reached it yet.

A [`pMapSkip`](#pmapskip) result leaves out the key, and [`pMapStop`](#pmapstop) keeps only the keys before it.

It takes the same options as `pMap`.

### pMapSettledKeyed(input, mapper, options?)

A version of `pMapKeyed` for [`Promise.allSettledKeyed()`](https://github.com/tc39/proposal-await-dictionary): an error from `mapper`, or a value of `input` that rejects, does not reject the returned `Promise`.

Returns a `Promise` that is fulfilled with an object with the same keys, in the same order, when all the values and mappers are settled. Each value is `{status: 'fulfilled', value}` with the value returned from `mapper`, or `{status: 'rejected', reason}` with the error from `mapper` or from `input`, the same as from `Promise.allSettledKeyed()`. The object has a `null` prototype. For a `Map`, it is a new `Map`.

```js
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

It takes the same `input` and `mapper` as `pMapKeyed`, and the same options as `pMap`, except [`stopOnError`](#stoponerror).

A value of `input` that rejects gets a `{status: 'rejected', reason}` result, and `mapper` is not called for it. Each value gets a handler right away, so it is never an unhandled rejection. A [`pMapSkip`](#pmapskip) result leaves out the key, and [`pMapStop`](#pmapstop) keeps only the keys before it.

The returned `Promise` still rejects when reading `input` throws, and when the [`signal`](#signal) aborts.

### pMapIterable(input, mapper, options?)

Returns an async iterable that streams each return value from `mapper` in order, or as soon as each is ready when [`preserveOrder`](#preserveorder) is `false`.

```js
import {pMapIterable} from 'p-map';

// Multiple posts are fetched concurrently, with limited concurrency and backpressure
for await (const post of pMapIterable(postIds, getPostMetadata, {concurrency: 8})) {
	console.log(post);
};
```

> [!NOTE]
> Like an async generator, a `return()` or `throw()` on the iterator that comes while a `next()` call is still pending waits for that `next()` to settle. A `break` in a `for await` loop is not affected, as the loop only stops between results. If `input` can block in `next()` for good, like a queue that waits for an item, stop it at the source, for example with an `AbortSignal` that it listens to.

#### input

Type: `AsyncIterable<Promise<unknown> | unknown> | Iterable<Promise<unknown> | unknown>`

Synchronous or asynchronous iterable that is iterated over concurrently, calling the `mapper` function for each element. Each iterated item is `await`'d before the `mapper` is invoked so the iterable may return a `Promise` that resolves to an item.

Asynchronous iterables (different from synchronous iterables that return `Promise` that resolves to an item) can be used when the next item may not be ready without waiting for an asynchronous process to complete and/or the end of the iterable may be reached after the asynchronous process completes. For example, reading from a remote queue when the queue has reached empty, or reading lines from a stream.

For `pMapKeyed` and `pMapSettledKeyed`, see [`pMapKeyed`](#pmapkeyedinput-mapper-options).

#### mapper(element, index)

Type: `Function`

Expected to return a `Promise` or value.

For `pMapKeyed` and `pMapSettledKeyed`, see [`pMapKeyed`](#pmapkeyedinput-mapper-options).

#### options

Type: `object`

##### concurrency

Type: `number` *(Integer)*\
Default: `Infinity`\
Minimum: `1`

Number of concurrently pending promises returned by `mapper`.

The right value depends on the work. Rules of thumb:

- Network or database: the pool size or rate limit of the other side.
- File system: tens to low hundreds, to avoid `EMFILE` errors.
- Child processes or worker threads: [`os.availableParallelism()`](https://nodejs.org/api/os.html#osavailableparallelism).
- Synchronous CPU-bound work: concurrency does not help.

If unsure, start low and measure. See also [Dynamic concurrency](#dynamic-concurrency).

> [!NOTE]
> `pMap` and `pMapSettled` can drop items that pulls from `input` already had in flight: when they stop early, because a mapper returns `pMapStop`, a mapper throws (only for `pMap`), or the `signal` aborts, and, with `concurrency` above 1, when one pull reports `done` while another still gets an item. That is invisible for a re-readable input, like an array or a string, but a source that cannot be re-read, such as a queue, loses those items. With `concurrency: 1`, only an abort can drop an item.

##### backpressure

**Only for `pMapIterable`**

Type: `number` *(Integer)*\
Default: `options.concurrency`\
Minimum: `options.concurrency`

Maximum number of elements taken from `input` that the consumer of the async iterable has not collected yet. That counts the elements being read, waiting for `mapper`, being mapped, and the results waiting to be collected. Calls to `mapper` will be limited so that there is never too much backpressure.

Useful whenever you are consuming the iterable slower than what the mapper function can produce concurrently. For example, to avoid making an overwhelming number of HTTP requests if you are saving each of the results to a database.

A `backpressure` above `concurrency` also lets `pMapIterable` read ahead: up to `backpressure - concurrency` elements, but no more than `concurrency`, are read from `input` while the mappers run, so a slow `input` does not leave a mapper waiting for its next element. Useful when reading `input` is slow, for example when it is another `pMapIterable`. With `concurrency: 1`, `backpressure: 2` overlaps reading each element with mapping the one before it. When the iteration ends early, the elements read ahead are not mapped, so a source that cannot be re-read, such as a queue, loses them.

A result of `pMapSkip` is collected by the consumer stepping over it, so it counts towards the limit until then. A mapper that skips most elements therefore still reads no further ahead than `backpressure` allows.

> [!NOTE]
> `backpressure` defaults to `concurrency`, which defaults to `Infinity`, so by default nothing bounds how far `input` is read ahead of the consumer. A source that never ends is then read without limit until memory runs out. Give such a source a finite `concurrency`. That also bounds `backpressure`, since it defaults to `concurrency`.

##### preserveOrder

**Only for `pMapIterable`**

Type: `boolean`\
Default: `true`

Whether to yield the results in `input` order.

When `false`, each result is yielded as soon as it is ready. A slow element then no longer holds back the results after it, and those results no longer fill up `backpressure` while they wait, so `mapper` keeps running at full `concurrency`. Use it when the order of the results does not matter.

An error from `mapper` is then also thrown as soon as it happens, instead of after the results before it. The `index` passed to `mapper` is still the position in `input`.

```js
import {pMapIterable} from 'p-map';

// Each page is saved as soon as it is downloaded, without waiting for slower pages before it
for await (const page of pMapIterable(urls, downloadPage, {concurrency: 8, preserveOrder: false})) {
	await savePage(page);
}
```

##### stopOnError

**Only for `pMap` and `pMapKeyed`**

Type: `boolean`\
Default: `true`

When `true`, the first mapper rejection will be rejected back to the consumer.

When `false`, instead of stopping when a promise rejects, it will wait for all the promises to settle and then reject with an [`AggregateError`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AggregateError) containing all the errors from the rejected promises.

The errors are listed in the order of the input, not in the order the promises happened to settle in, so the same input always produces the same `AggregateError`.

Caveat: When `true`, any already-started async mappers will continue to run until they resolve or reject. In the case of infinite concurrency with sync iterables, *all* mappers are invoked on startup and will continue after the first rejection. Use the `signal` option for abort control.

##### signal

**Not for `pMapIterable`**

Type: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)

You can abort the promises using [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).

```js
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

> [!NOTE]
> An abort that comes from a timer or an I/O callback, like a `setTimeout`, cannot take effect while the mapping is inside a stretch of work that never waits on a timer or I/O. Draining a large input with mappers that just return a value is one such stretch, and there the run finishes first. This is the same for `Promise.all` and for a plain loop, and it goes away as soon as the mapper or the source waits on a timer or I/O.

### pMapSkip

Return this value from a `mapper` function to skip including the value in the returned array, or, for `pMapKeyed` and `pMapSettledKeyed`, to leave out the key.

```js
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

### pMapStop

Return this value from a `mapper` function to stop iterating, like `break` in a loop.

`pMap` resolves with the results of the elements before it, in order, without waiting for the elements after it. Like in a loop, an error from an earlier element still rejects. An error from a later element rejects only if it happens before the stop. With `stopOnError: false`, only the errors from earlier elements are collected.

`pMapKeyed` stops the same way, and keeps only the keys before it. `pMapSettled` and `pMapSettledKeyed` also stop the same way, but an error from an element before the stop gives a `{status: 'rejected', reason}` result instead of a rejection.

`pMapIterable` ends the stream where the stop would have been yielded: after the elements before it with [`preserveOrder`](#preserveorder), or after the results that were ready before it without.

`pMap`, `pMapSettled`, and `pMapIterable` then read no more elements from `input`, and close `input`. `pMapKeyed` and `pMapSettledKeyed` have read all the values already. Mappers that are still running are not canceled, and their results are dropped. The element that returns `pMapStop` adds no value to the result.

```js
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

## Recipes

### Rate limiting

This package controls how many mapper promises run concurrently. To limit how often the mapper starts, compose it with a rate limiter like [`p-throttle`](https://github.com/sindresorhus/p-throttle):

```js
import pThrottle from 'p-throttle';
import pMap from 'p-map';

const throttle = pThrottle({
	limit: 1,
	interval: 1000,
	strict: true,
});

const result = await pMap(input, throttle(mapper), {concurrency: 2});
```

For more advanced scheduling, use [`p-queue`](https://github.com/sindresorhus/p-queue).

### Dynamic concurrency

To change the concurrency while mapping, compose the mapper with [`p-limit`](https://github.com/sindresorhus/p-limit), whose `concurrency` can be changed at any time:

```js
import pLimit from 'p-limit';
import pMap from 'p-map';

const limit = pLimit(2);

// For example, raise it when the server is less busy
setTimeout(() => {
	limit.concurrency = 8;
}, 10_000);

try {
	// The `concurrency` option is the highest value `limit.concurrency` can have
	await pMap(input, (element, index) => limit(mapper, element, index), {concurrency: 8});
} finally {
	// Do not start the queued elements after a stop or an error
	limit.clearQueue();
}
```

## Related

- [p-all](https://github.com/sindresorhus/p-all) - Run promise-returning & async functions concurrently with optional limited concurrency
- [p-filter](https://github.com/sindresorhus/p-filter) - Filter promises concurrently
- [p-times](https://github.com/sindresorhus/p-times) - Run promise-returning & async functions a specific number of times concurrently
- [p-props](https://github.com/sindresorhus/p-props) - Like `Promise.all()` but for `Map` and `Object`
- [p-map-series](https://github.com/sindresorhus/p-map-series) - Map over promises serially
- [More…](https://github.com/sindresorhus/promise-fun)
