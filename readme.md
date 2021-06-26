# p-map

> Map over promises concurrently

Useful when you need to run promise-returning & async functions multiple times with different inputs concurrently.

This is different from `Promise.all()` in that you can:

* Control the concurrency
* Decide whether or not to stop iterating when there's an error
* Stop iterating at any point (like `break` in standard loops)

## Install

```
$ npm install p-map
```

## Usage

```js
import pMap from 'p-map';
import got from 'got';

const sites = [
	getWebsiteFromUsername('https://sindresorhus'), //=> Promise
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

### Breaking from iteration

```js
import pMap from 'p-map';
import got from 'got';

const numbers = Array.from({length: 2000}).map((_, index) => index + 1);
//=> [1, 2, ..., 1999, 2000]

const mapper = async number => {
	if (number !== 404) {
		const {transcript} = await got(`https://xkcd.com/${number}/info.0.json`).json();
		if (/unicorn/.test(transcript)) {
			console.log('Found a XKCD comic with an unicorn:', number);
			return pMap.stop();
		}
	}
};

await pMap(numbers, mapper, {concurrency: 50});
//=> Found a XKCD comic with an unicorn: 948
```

## API

### pMap(input, mapper, options?)

Returns a `Promise` that is fulfilled when all promises in `input` and ones returned from `mapper` are fulfilled, or rejects if any of the promises reject. The fulfilled value is an `Array` of the fulfilled values returned from `mapper` in `input` order.

#### input

Type: `Iterable<Promise | unknown>`

Iterated over concurrently in the `mapper` function.

#### mapper(element, index)

Type: `Function`

Expected to return a `Promise` or value.

#### options

Type: `object`

##### concurrency

Type: `number` *(Integer)*\
Default: `Infinity`\
Minimum: `1`

Number of concurrently pending promises returned by `mapper`.

##### stopOnError

Type: `boolean`\
Default: `true`

When set to `false`, instead of stopping when a promise rejects, it will wait for all the promises to settle and then reject with an [aggregated error](https://github.com/sindresorhus/aggregate-error) containing all the errors from the rejected promises.

### pMap.stop(options?)

Creates a special object that indicates to `pMap` that iteration must stop immediately. This object should just be returned from within the mapper (and not used directly for anything).

#### options

Type: `object`

##### value

Type: `any`\
Default: `undefined`

Value to provide as result for this iteration.

##### ongoingMappings

Type: `object`

Options to configure what `pMap` must do with any concurrent ongoing mappings at the moment `stop` is called.

###### collapse

Type: `boolean`\
Default: `false`

Whether or not to remove all holes from the result array (caused by pending mappings).

###### fillWith

Type: `any`\
Default: `undefined`

Value to use as immediate result for pending mappings, replacing holes from the result array.

This option is ignored if `collapse` is set to `true`.


## p-map for enterprise

Available as part of the Tidelift Subscription.

The maintainers of p-map and thousands of other packages are working with Tidelift to deliver commercial support and maintenance for the open source dependencies you use to build your applications. Save time, reduce risk, and improve code health, while paying the maintainers of the exact dependencies you use. [Learn more.](https://tidelift.com/subscription/pkg/npm-p-map?utm_source=npm-p-map&utm_medium=referral&utm_campaign=enterprise&utm_term=repo)

## Related

- [p-all](https://github.com/sindresorhus/p-all) - Run promise-returning & async functions concurrently with optional limited concurrency
- [p-filter](https://github.com/sindresorhus/p-filter) - Filter promises concurrently
- [p-times](https://github.com/sindresorhus/p-times) - Run promise-returning & async functions a specific number of times concurrently
- [p-props](https://github.com/sindresorhus/p-props) - Like `Promise.all()` but for `Map` and `Object`
- [p-map-series](https://github.com/sindresorhus/p-map-series) - Map over promises serially
- [p-queue](https://github.com/sindresorhus/p-queue) - Promise queue with concurrency control
- [More…](https://github.com/sindresorhus/promise-fun)
