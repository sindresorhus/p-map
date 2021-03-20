import {expectType} from 'tsd';
import pMap = require('.');
import {Options, Mapper} from '.';

const sites = [
	'https://sindresorhus.com',
	'https://avajs.dev',
	'https://github.com'
];

const numbers = [
	0,
	1,
	2
];

const asyncMapper = async (site: string): Promise<string> => site;
const asyncSyncMapper = async (site: string, index: number): Promise<string> =>
	index > 1 ? site : Promise.resolve(site);
const multiResultTypeMapper = async (site: string, index: number): Promise<string | number> =>
	index > 1 ? site.length : site;

expectType<Mapper>(asyncMapper);
expectType<Mapper<string, string>>(asyncMapper);
expectType<Mapper>(asyncSyncMapper);
expectType<Mapper<string, string | Promise<string>>>(asyncSyncMapper);
expectType<Mapper>(multiResultTypeMapper);
expectType<Mapper<string, string | number>>(multiResultTypeMapper);

expectType<Options>({});
expectType<Options>({concurrency: 0});
expectType<Options>({stopOnError: false});

expectType<Promise<string[]>>(pMap(sites, asyncMapper));
expectType<Promise<string[]>>(pMap(sites, asyncMapper, {concurrency: 2}));

expectType<Promise<string[]>>(pMap(sites, asyncSyncMapper));
expectType<Promise<Array<string | number>>>(pMap(sites, multiResultTypeMapper));

expectType<Promise<string[]>>(pMap(sites, (site: string) => site));
expectType<Promise<number[]>>(pMap(sites, (site: string) => site.length));

expectType<Promise<number[]>>(pMap(numbers, (number: number) => number * 2));
