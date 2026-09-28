import {expectType, expectAssignable, expectError} from 'tsd';
import pMap, {pMapIterable, type Options, type Mapper, pMapSkip, pMapStop} from './index.js';

const sites = [
	'https://sindresorhus.com',
	'https://avajs.dev',
	'https://github.com',
];

const sitesWithPromises = [
	'https://sindresorhus.com',
	Promise.resolve('https://avajs.dev'),
	Promise.resolve('https://github.com'),
];

const sitesAsyncIterable = {
	async * [Symbol.asyncIterator]() {
		yield 'https://sindresorhus.com';
		yield 'https://avajs.dev';
		yield 'https://github.com';
	},
};

const sitesAsyncIterableWithPromises: AsyncIterable<Promise<string>> = {
	[Symbol.asyncIterator]() {
		return {
			async next() {
				return {
					done: false,
					value: Promise.resolve('https://github.com'),
				};
			},
		};
	},
};

const numbers = [
	0,
	1,
	2,
];

const asyncMapper = async (site: string): Promise<string> => site;
const asyncSyncMapper = async (site: string, index: number): Promise<string> =>
	index > 1 ? site : Promise.resolve(site);
const multiResultTypeMapper = async (site: string, index: number): Promise<string | number> =>
	index > 1 ? site.length : site;

expectAssignable<Mapper>(asyncMapper);
expectAssignable<Mapper<string, string>>(asyncMapper);
expectAssignable<Mapper>(asyncSyncMapper);
expectAssignable<Mapper<string, string | Promise<string>>>(asyncSyncMapper);
expectAssignable<Mapper>(multiResultTypeMapper);
expectAssignable<Mapper<string, string | number>>(multiResultTypeMapper);

expectAssignable<Options>({});
expectAssignable<Options>({concurrency: 0});
expectAssignable<Options>({stopOnError: false});

expectType<Promise<string[]>>(pMap(sites, asyncMapper));
expectType<Promise<string[]>>(pMap(sites, asyncMapper, {concurrency: 2}));

expectType<Promise<string[]>>(pMap(sites, asyncSyncMapper));
expectType<Promise<Array<string | number>>>(pMap(sites, multiResultTypeMapper));

expectType<Promise<string[]>>(pMap(sites, (site: string) => site));
expectType<Promise<number[]>>(pMap(sites, (site: string) => site.length));

expectType<Promise<number[]>>(pMap(numbers, (number: number) => number * 2));

expectType<Promise<number[]>>(pMap(numbers, (number: number) => {
	if (number % 2 === 0) {
		return number * 2;
	}

	return pMapSkip;
}));

expectType<AsyncIterable<string>>(pMapIterable(sites, asyncMapper));
expectType<AsyncIterable<string>>(pMapIterable(sitesWithPromises, asyncMapper));
expectType<AsyncIterable<string>>(pMapIterable(sitesAsyncIterable, asyncMapper));
expectType<AsyncIterable<string>>(pMapIterable(sitesAsyncIterableWithPromises, asyncMapper));

// A readonly tuple input keeps the literal types.
expectType<Promise<Array<'a' | 'b'>>>(pMap(['a', 'b'] as const, async (site: 'a' | 'b') => site));

// A Set input.
expectType<Promise<number[]>>(pMap(new Set([1, 2]), async (value: number) => value * 2));

// A Map input, destructured in the mapper.
expectType<Promise<string[]>>(pMap(new Map([['a', 1]]), async ([key, value]: [string, number]) => `${key}${value}`));

// An async iterable that yields promises.
expectType<Promise<number[]>>(pMap(sitesAsyncIterableWithPromises, async (site: string) => site.length));

// A mapper that can return pMapStop.
const stopMapper = async (site: string) => (site.length > 20 ? pMapStop : site);
expectAssignable<Mapper<string, string>>(stopMapper);
expectType<Promise<string[]>>(pMap(sites, stopMapper));
expectType<AsyncIterable<string>>(pMapIterable(sites, stopMapper));

// A mapper that can return both pMapSkip and pMapStop.
const skipAndStopMapper = async (number: number) => {
	if (number === 0) {
		return pMapSkip;
	}

	return number > 1 ? pMapStop : number;
};

expectType<Promise<number[]>>(pMap(numbers, skipAndStopMapper));
expectType<AsyncIterable<number>>(pMapIterable(numbers, skipAndStopMapper));

// A mapper that always returns pMapSkip.
expectType<Promise<string[]>>(pMap(sites, async site => (site.length > 0 ? pMapSkip : site)));

// `backpressure` and `preserveOrder` are pMapIterable only.
expectError(pMap(sites, asyncMapper, {backpressure: 2}));
expectError(pMap(sites, asyncMapper, {preserveOrder: false}));
expectType<AsyncIterable<string>>(pMapIterable(sites, asyncMapper, {preserveOrder: false}));
expectError(pMapIterable(sites, asyncMapper, {preserveOrder: 'false'}));

// `stopOnError` and `signal` are pMap only.
expectError(pMapIterable(sites, asyncMapper, {stopOnError: false}));
expectError(pMapIterable(sites, asyncMapper, {signal: new AbortController().signal}));

// A mapper returning nothing.
const voidMapper = async (number: number) => {
	await Promise.resolve();
};

expectType<Promise<void[]>>(pMap(numbers, voidMapper));

// A mapper that returns a promise of a skip.
expectType<Promise<string[]>>(pMap(sites, async site => (site.length > 3 ? pMapSkip : site)));

// An input that is already async iterable, not promise yielding.
const asyncNumbers: AsyncIterable<number> = {
	async * [Symbol.asyncIterator]() {
		yield 1;
	},
};
expectType<Promise<string[]>>(pMap(asyncNumbers, async number => `${number}`));

// A readonly array input.
const readonlyNumbers: readonly number[] = [1, 2];
expectType<Promise<number[]>>(pMap(readonlyNumbers, async number => number));

// Options with an unknown key are rejected.
expectError(pMap(sites, asyncMapper, {concurrency: 2, nope: true}));
expectError(pMapIterable(sites, asyncMapper, {backpressure: 2, nope: true}));

// `concurrency` must be a number, not a numeric string.
expectError(pMap(sites, asyncMapper, {concurrency: '2'}));

// A mapper that does not accept the element type.
expectError(pMap(numbers, async (site: string) => site));

// `pMapIterable` infers the same way.
expectType<AsyncIterable<void>>(pMapIterable(numbers, voidMapper));
expectType<AsyncIterable<string>>(pMapIterable(asyncNumbers, async number => `${number}`));
