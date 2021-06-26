import {expectType, expectAssignable, expectNotAssignable} from 'tsd';
import pMap, {Options, Mapper} from './index.js';

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
const mapperStoppingEarly1 = async (site: string, index: number) =>
	index > 1 ? pMap.stop({value: site.length}) : site;
const mapperStoppingEarly2 = async (site: string, index: number) =>
	index > 1 ? pMap.stop({value: index > 2 ? site.length : site}) : site;
const mapperStoppingEarly3 = async (site: string, index: number) =>
	index > 1 ? pMap.stop({value: index > 2 ? site.length : (index > 3 ? Date.now() : site)}) : true;

expectAssignable<Mapper>(asyncMapper);
expectAssignable<Mapper<string, string>>(asyncMapper);
expectAssignable<Mapper>(asyncSyncMapper);
expectAssignable<Mapper<string, string>>(asyncSyncMapper);
expectAssignable<Mapper<string, string | Promise<string>>>(asyncSyncMapper);
expectAssignable<Mapper>(multiResultTypeMapper);
expectAssignable<Mapper<string, string | number>>(multiResultTypeMapper);
expectAssignable<Mapper>(mapperStoppingEarly1);
expectAssignable<Mapper<string, string | number>>(mapperStoppingEarly1);
expectAssignable<Mapper>(mapperStoppingEarly2);
expectAssignable<Mapper<string, string | number>>(mapperStoppingEarly2);
expectAssignable<Mapper>(mapperStoppingEarly3);
expectAssignable<Mapper<string, string | number | boolean | Date>>(mapperStoppingEarly3);

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

expectType<Promise<number[]>>(pMap(numbers, (number: number) => number * 2));

pMap.stop();
pMap.stop({});
pMap.stop({value: 123});
pMap.stop({ongoingMappings: {}});
pMap.stop({ongoingMappings: {collapse: true}});
pMap.stop({ongoingMappings: {fillWith: 'hello'}});
pMap.stop({value: Date.now(), ongoingMappings: {collapse: false, fillWith: 'hello'}});

const shouldBeUnusableDirectly = pMap.stop({value: 123});
expectNotAssignable<number>(shouldBeUnusableDirectly);
