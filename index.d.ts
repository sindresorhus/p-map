declare const stop: unique symbol;

export type StopSymbol = typeof stop;

export interface Options {
	/**
	Number of concurrently pending promises returned by `mapper`.

	Must be an integer from 1 and up or `Infinity`.

	@default Infinity
	*/
	readonly concurrency?: number;

	/**
	When set to `false`, instead of stopping when a promise rejects, it will wait for all the promises to settle and then reject with an [aggregated error](https://github.com/sindresorhus/aggregate-error) containing all the errors from the rejected promises.

	@default true
	*/
	readonly stopOnError?: boolean;
}

export interface OngoingMappingsStopOptions {
	/**
	Whether or not to remove all holes from the result array (caused by pending mappings).

	@default false
	*/
	readonly collapse?: boolean;

	/**
	Value to use as immediate result for pending mappings, replacing holes from the result array.

	This option is ignored if `collapse` is set to `true`.

	@default undefined
	*/
	readonly fillWith?: unknown;
}

export interface StopOptions<NewElement> {
	/**
	Value to provide as result for this iteration.

	@default undefined
	*/
	readonly value?: NewElement;

	/**
	Options to configure what `pMap` must do with any concurrent ongoing mappings at the moment `stop` is called.
	*/
	readonly ongoingMappings?: OngoingMappingsStopOptions;
}

type BaseStopValueWrapper<NewElement> = {
	[stop]: Required<StopOptions<NewElement>>;
};

export type StopValueWrapper<NewElement> = NewElement extends any ? BaseStopValueWrapper<NewElement> : never;

type MaybeWrappedInStop<NewElement> = NewElement | StopValueWrapper<NewElement>;

/**
Function which is called for every item in `input`. Expected to return a `Promise` or value.

@param element - Iterated element.
@param index - Index of the element in the source array.
*/
export type Mapper<Element = any, NewElement = unknown> = (
	element: Element,
	index: number
) => MaybeWrappedInStop<NewElement> | Promise<MaybeWrappedInStop<NewElement>>;

/**
@param input - Iterated over concurrently in the `mapper` function.
@param mapper - Function which is called for every item in `input`. Expected to return a `Promise` or value.
@returns A `Promise` that is fulfilled when all promises in `input` and ones returned from `mapper` are fulfilled, or rejects if any of the promises reject. The fulfilled value is an `Array` of the fulfilled values returned from `mapper` in `input` order.

@example
```
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
*/
declare const pMap: {
	<Element, NewElement>(
		input: Iterable<Element>,
		mapper: Mapper<Element, NewElement>,
		options?: Options
	): Promise<NewElement[]>;

	/**
	Creates a special object that indicates to `pMap` that iteration must stop immediately. This object should just be returned from within the mapper (and not used directly for anything).

	@example
	```
	import pMap from 'p-map';
	import got from 'got';

	const numbers = Array.from({ length: 2000 }).map((_, i) => i + 1);
	//=> [1, 2, ..., 1999, 2000]

	const mapper = async number => {
		if (number !== 404) {
			const { transcript } = await got(`https://xkcd.com/${number}/info.0.json`).json();
			if (/unicorn/.test(transcript)) {
				console.log('Found a XKCD comic with an unicorn:', number);
				return pMap.stop();
			}
		}
	};

	await pMap(numbers, mapper, { concurrency: 50 });
	//=> Found a XKCD comic with an unicorn: 948
	```
	*/
	stop: <NewElement>(options?: StopOptions<NewElement>) => StopValueWrapper<NewElement>;
};

export default pMap;
