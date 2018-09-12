import {expectType} from 'tsd-check';
import pMap, {Options, Mapper} from '.';

const sites = [
	'ava.li',
	'todomvc.com',
	'github.com'
];

const numbers = [
	0,
	1,
	2
];

const asyncMapper = async (site: string) => site;
const asyncSyncMapper = (site: string, index: number) => index > 1 ? site : Promise.resolve(site);
const multiResultTypeMapper = (site: string, index: number) => index > 1 ? site.length : site;

expectType<Mapper>(asyncMapper);
expectType<Mapper>(asyncSyncMapper);
expectType<Mapper>(multiResultTypeMapper);

expectType<Options>({});
expectType<Options>({concurrency: 0});

expectType<string[]>(await pMap(sites, asyncMapper));
expectType<string[]>(await pMap(sites, asyncMapper, {concurrency: 2}));

expectType<string[]>(await pMap(sites, asyncSyncMapper));
expectType<(string | number)[]>(await pMap(sites, multiResultTypeMapper));

expectType<string[]>(await pMap(sites, (site: string) => site));
expectType<number[]>(await pMap(sites, (site: string) => site.length));

expectType<number[]>(await pMap(numbers, (number: number) => number * 2));
