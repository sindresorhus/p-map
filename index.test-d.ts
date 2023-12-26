import {expectType, expectAssignable} from 'tsd';
import pMap, {pMapIterable, type Options, type Mapper, pMapSkip} from './index.js';

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
