import {expectType, expectAssignable, expectNotAssignable, expectError} from 'tsd';
import pMap, {pMapIterable, pMapSettled, pMapKeyed, pMapSettledKeyed, type Options, type SettledOptions, type IterableOptions, type Mapper, type KeyedMapper, pMapSkip, pMapStop} from './index.js';

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

// `pMapSettled` resolves with the same results as `Promise.allSettled`.
expectType<Promise<Array<PromiseSettledResult<string>>>>(pMapSettled(sites, asyncMapper));
expectType<Promise<Array<PromiseSettledResult<string>>>>(pMapSettled(sitesWithPromises, asyncMapper, {concurrency: 2}));
expectType<Promise<Array<PromiseSettledResult<number>>>>(pMapSettled(sitesAsyncIterable, async site => site.length));
expectType<Promise<Array<PromiseSettledResult<string | number>>>>(pMapSettled(sites, multiResultTypeMapper));
expectType<Promise<Array<PromiseSettledResult<number>>>>(pMapSettled(numbers, skipAndStopMapper));
expectType<Promise<Array<PromiseSettledResult<number>>>>(pMapSettled(numbers, async number => number, {signal: new AbortController().signal}));

// The results narrow on `status`.
const settledResults = await pMapSettled(numbers, async number => `${number}`);
for (const result of settledResults) {
	if (result.status === 'fulfilled') {
		expectType<string>(result.value);
	} else {
		expectType<any>(result.reason);
	}
}

// `pMapSettled` never rejects for a mapper error, so `stopOnError` does not apply, and neither do the `pMapIterable` options.
expectAssignable<SettledOptions>({concurrency: 2});
expectError(pMapSettled(sites, asyncMapper, {stopOnError: false}));
expectError(pMapSettled(sites, asyncMapper, {backpressure: 2}));
expectError(pMapSettled(sites, asyncMapper, {preserveOrder: false}));
expectError(pMapSettled(numbers, async (site: string) => site));

// `pMapKeyed` keeps the keys, with the mapped values.
const keyedInput = {
	user: Promise.resolve('user'),
	count: 1,
};

expectType<Promise<{user: number; count: number}>>(pMapKeyed(keyedInput, async value => `${value}`.length));
expectType<Promise<{user: string | number; count: string | number}>>(pMapKeyed(keyedInput, value => value));

// The mapper gets the awaited values and the keys, with a number key as a string.
const symbolKey = Symbol('symbolKey');
const mixedKeyInput = {
	name: Promise.resolve('name'),
	1: true, // eslint-disable-line @typescript-eslint/naming-convention
	[symbolKey]: 2,
};

await pMapKeyed(mixedKeyInput, (value, key) => {
	expectType<string | boolean | number>(value);
	expectType<'name' | '1' | typeof symbolKey>(key);
	return value;
});

expectAssignable<KeyedMapper<typeof keyedInput, string>>(async (value: string | number, key: 'user' | 'count') => `${key}${value}`);

// A readonly input gives a mutable result, like `Promise.allKeyed`.
expectType<Promise<{a: number}>>(pMapKeyed({a: 1} as const, value => value * 2));

// An index signature.
const record: Record<string, Promise<number>> = {};
expectType<Promise<Record<string, string>>>(pMapKeyed(record, value => `${value}`));

// A mapper that can return `pMapSkip` or `pMapStop` makes the keys optional.
expectType<Promise<{user?: string | number; count?: string | number}>>(pMapKeyed(keyedInput, async value => (value === 1 ? pMapSkip : value)));
expectType<Promise<{user?: string | number; count?: string | number}>>(pMapKeyed(keyedInput, value => (value === 1 ? pMapStop : value)));

expectType<Promise<{user: number}>>(pMapKeyed({user: 1}, value => value, {concurrency: 2, stopOnError: false, signal: new AbortController().signal}));

// `pMapSettledKeyed` gives the same results as `Promise.allSettledKeyed`.
expectType<Promise<{user: PromiseSettledResult<number>; count: PromiseSettledResult<number>}>>(pMapSettledKeyed(keyedInput, async value => `${value}`.length));
expectType<Promise<{user?: PromiseSettledResult<string | number>; count?: PromiseSettledResult<string | number>}>>(pMapSettledKeyed(keyedInput, value => (value === 1 ? pMapSkip : value)));

const settledKeyed = await pMapSettledKeyed({user: 1}, async value => `${value}`);
if (settledKeyed.user.status === 'fulfilled') {
	expectType<string>(settledKeyed.user.value);
}

// The input must be an object, and the options are those of `pMap` and `pMapSettled`.
expectError(pMapKeyed('abc', value => value));
expectError(pMapKeyed(1, value => value));
expectError(pMapKeyed(null, value => value));
expectError(pMapKeyed(undefined, value => value));
expectError(pMapSettledKeyed(null, value => value));
expectError(pMapKeyed(keyedInput));
expectError(pMapKeyed(keyedInput, value => value, {backpressure: 2}));
expectError(pMapSettledKeyed(keyedInput, value => value, {stopOnError: false}));
expectError(pMapSettledKeyed(keyedInput, (value: boolean) => value));

// An array, a `Set`, or another iterable that is not a `Map` has no keys that the result could describe.
expectError(pMapKeyed(['a'], value => value));
expectError(pMapKeyed(['a'] as const, value => value));
expectError(pMapKeyed(new Set([1]), value => value));
expectError(pMapKeyed(new Uint8Array(2), value => value));
expectError(pMapSettledKeyed(['a'], value => value));
expectError(pMapSettledKeyed(new Set([1]), value => value));

// A `Map` gives a `Map`, with the keys of any type.
const objectKey = {id: 1};
const keyedMap = new Map<{id: number} | string, Promise<number> | number>([[objectKey, Promise.resolve(1)], ['b', 2]]);

expectType<Promise<Map<{id: number} | string, string>>>(pMapKeyed(keyedMap, async value => `${value}`));
expectType<Promise<Map<{id: number} | string, number>>>(pMapKeyed(keyedMap, value => (value > 1 ? pMapSkip : value)));
expectType<Promise<Map<{id: number} | string, PromiseSettledResult<string>>>>(pMapSettledKeyed(keyedMap, async value => `${value}`));
expectType<Promise<Map<string, number>>>(pMapKeyed(new Map([['a', 1]]) as ReadonlyMap<string, number>, value => value));

await pMapKeyed(keyedMap, (value, key) => {
	expectType<number>(value);
	expectType<{id: number} | string>(key);
	return value;
});

expectAssignable<KeyedMapper<typeof keyedMap, string>>((value: number, key: {id: number} | string) => `${value}`);

// A mapper that returns `any`, like `response.json()`, keeps the keys required.
declare function getJson(): Promise<any>;
expectType<Promise<{user: any; posts: any}>>(pMapKeyed({user: 'a', posts: 'b'}, async () => getJson()));

// A generic caller can forward its input.
// eslint-disable-next-line @typescript-eslint/ban-types
async function forwardKeyed<Input extends object>(input: Input) {
	return pMapKeyed(input, value => value);
}

expectType<{a: number}>(await forwardKeyed({a: 1}));

async function forwardUrls<Urls extends Record<string, string>>(urls: Urls) {
	return pMapSettledKeyed(urls, async url => url.length);
}

expectType<{a: PromiseSettledResult<number>}>(await forwardUrls({a: 'x'}));

// A union input maps each member.
declare const unionInput: {a: number} | {b: Promise<string>};
expectType<Promise<{a: boolean} | {b: boolean}>>(pMapKeyed(unionInput, value => typeof value === 'number'));
await pMapKeyed(unionInput, (value, key) => {
	expectType<number | string>(value);
	expectType<'a' | 'b'>(key);
	return value;
});

// A readonly input with a skip gives mutable optional keys.
expectType<Promise<{a?: number}>>(pMapKeyed({a: 1} as const, value => (value > 0 ? pMapSkip : value * 2)));

// A function with properties is still an object.
const functionWithProperties = Object.assign(() => 1, {a: 1});
expectType<Promise<{a: number}>>(pMapKeyed(functionWithProperties, value => value));

// Generators and async generators are iterables like any other.
function * numberGenerator(): Generator<number> {
	yield 1;
	yield 2;
}

async function * stringAsyncGenerator() {
	yield 'a';
}

expectType<Promise<string[]>>(pMap(numberGenerator(), number => `${number}`));
expectType<Promise<number[]>>(pMap(stringAsyncGenerator(), string => string.length));
expectType<AsyncIterable<number>>(pMapIterable(numberGenerator(), number => number * 2));
expectType<AsyncIterable<string>>(pMapIterable(stringAsyncGenerator(), async string => string));
expectType<Promise<Array<PromiseSettledResult<number>>>>(pMapSettled(numberGenerator(), number => number));
expectType<Promise<Array<PromiseSettledResult<string>>>>(pMapSettled(stringAsyncGenerator(), string => string));

// A mutable tuple maps over the union of its element types, and the mapper gets the index as a number.
const mixedTuple: [string, number] = ['a', 1];
await pMap(mixedTuple, (element, index) => {
	expectType<string | number>(element);
	expectType<number>(index);
	return element;
});
expectType<Promise<Array<string | number>>>(pMap(mixedTuple, element => element));
expectType<AsyncIterable<string | number>>(pMapIterable(mixedTuple, element => element));

// `Set`, `Map`, and readonly array inputs for the other functions.
expectType<AsyncIterable<number>>(pMapIterable(new Set(['a']), value => value.length));
expectType<AsyncIterable<string>>(pMapIterable(new Map([['a', 1]]), ([key, value]) => `${key}${value}`));
expectType<Promise<Array<PromiseSettledResult<boolean>>>>(pMapSettled(new Set([1]), value => value > 0));
expectType<Promise<Array<PromiseSettledResult<number>>>>(pMapSettled(readonlyNumbers, async number => number));

// Explicit generic arguments.
expectType<Promise<string[]>>(pMap<number, string>(numbers, number => `${number}`));
expectError(pMap<number, string>(numbers, number => number));
expectType<AsyncIterable<string>>(pMapIterable<number, string>(numbers, async number => `${number}`));
expectType<Promise<Array<PromiseSettledResult<string>>>>(pMapSettled<number, string>(numbers, number => `${number}`));
expectType<Promise<{a: string}>>(pMapKeyed<{a: number}, string>({a: 1}, value => `${value}`));
expectError(pMapKeyed<{a: number}, string>({a: 1}, value => value));
expectType<Promise<{a: PromiseSettledResult<string>}>>(pMapSettledKeyed<{a: number}, string>({a: 1}, value => `${value}`));

// A mapper that returns a promise or a plain value.
// eslint-disable-next-line @typescript-eslint/promise-function-async
expectType<Promise<number[]>>(pMap(numbers, number => (number > 1 ? Promise.resolve(number * 2) : number)));
// eslint-disable-next-line @typescript-eslint/promise-function-async
expectType<Promise<{a: string}>>(pMapKeyed({a: 1}, value => (value > 1 ? Promise.resolve(`${value}`) : `${value}`)));

// A `pMapSkip` or `pMapStop` from `pMapIterable` and `pMapSettled` is left out of the result type.
expectType<AsyncIterable<number>>(pMapIterable(numbers, number => (number > 1 ? pMapSkip : number)));
expectType<Promise<Array<PromiseSettledResult<number>>>>(pMapSettled(numbers, async number => (number > 1 ? pMapStop : number)));

// `Mapper` checks the element, the index, and the result.
expectAssignable<Mapper<number, string>>((element: number, index: number) => `${element}${index}`);
expectAssignable<Mapper<number, string>>(() => pMapSkip);
expectAssignable<Mapper<number, string>>(async (element: number) => (element > 1 ? pMapStop : `${element}`));
expectNotAssignable<Mapper<number, string>>((element: string) => element);
expectNotAssignable<Mapper<number, string>>((element: number, index: string) => index);
expectNotAssignable<Mapper<number, string>>((element: number) => element);

// `KeyedMapper` checks the value and the key.
expectAssignable<KeyedMapper<{a: Promise<number>}, string>>((value: number, key: 'a') => `${key}${value}`);
expectAssignable<KeyedMapper<Map<number, string>, number>>(async (value: string, key: number) => key);
expectNotAssignable<KeyedMapper<{a: number}, string>>((value: number, key: 'b') => `${key}${value}`);
expectNotAssignable<KeyedMapper<{a: number}, string>>((value: string) => value);
expectNotAssignable<KeyedMapper<{a: number}, string>>((value: number) => value);

// A `KeyedMapper` can return `pMapSkip` and `pMapStop`, like a `Mapper`.
expectAssignable<KeyedMapper<{a: number}, string>>(() => pMapSkip);
expectAssignable<KeyedMapper<{a: number}, string>>(async (value: number) => (value > 1 ? pMapStop : `${value}`));

// A mapper typed as a `KeyedMapper` can return `pMapSkip`, so it makes the keys optional.
const keyedSkipMapper: KeyedMapper<{a: number; b: number}, number> = value => (value > 1 ? pMapSkip : value);
expectType<Promise<{a?: number; b?: number}>>(pMapKeyed({a: 1, b: 2}, keyedSkipMapper));
expectType<Promise<{a?: PromiseSettledResult<number>; b?: PromiseSettledResult<number>}>>(pMapSettledKeyed({a: 1, b: 2}, keyedSkipMapper));

// The options of each function.
expectAssignable<IterableOptions>({concurrency: 2, backpressure: 4, preserveOrder: false});
expectAssignable<SettledOptions>({concurrency: 2, signal: new AbortController().signal});
expectError(pMapSettled(sites, asyncMapper, {nope: true}));
expectError(pMapKeyed(keyedInput, value => value, {nope: true}));
expectError(pMapKeyed(keyedInput, value => value, {preserveOrder: false}));
expectError(pMapSettledKeyed(keyedInput, value => value, {backpressure: 2}));
expectError(pMapSettledKeyed(keyedInput, value => value, {preserveOrder: false}));

// `concurrency` and `backpressure` must be numbers for every function.
expectError(pMapIterable(sites, asyncMapper, {concurrency: '2'}));
expectError(pMapIterable(sites, asyncMapper, {backpressure: '2'}));
expectError(pMapSettled(sites, asyncMapper, {concurrency: '2'}));
expectError(pMapKeyed(keyedInput, value => value, {concurrency: '2'}));
expectError(pMapSettledKeyed(keyedInput, value => value, {concurrency: '2'}));

// `signal` is an `AbortSignal` or `undefined`.
expectType<Promise<string[]>>(pMap(sites, asyncMapper, {signal: undefined}));
expectError(pMap(sites, asyncMapper, {signal: null}));
expectError(pMap(sites, asyncMapper, {signal: true}));
expectError(pMapSettled(sites, asyncMapper, {signal: 'abort'}));
expectType<Promise<{a: PromiseSettledResult<number>}>>(pMapSettledKeyed({a: 1}, value => value, {signal: AbortSignal.abort()}));
expectError(pMapKeyed(keyedInput, value => value, {signal: null}));

// An interface input.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface KeyedUser {
	name: string;
	age: Promise<number>;
}

declare const keyedUser: KeyedUser;
expectType<Promise<{name: string; age: string}>>(pMapKeyed(keyedUser, value => `${value}`));
await pMapKeyed(keyedUser, (value, key) => {
	expectType<string | number>(value);
	expectType<'name' | 'age'>(key);
	return value;
});

// A class instance with fields only.
class KeyedPoint {
	x = 1;
	y = Promise.resolve(2);
}

expectType<Promise<{x: string; y: string}>>(pMapKeyed(new KeyedPoint(), value => `${value}`));
await pMapKeyed(new KeyedPoint(), (value, key) => {
	expectType<number>(value);
	expectType<'x' | 'y'>(key);
	return value;
});

// A `Record` with symbol, number, and string keys.
declare const symbolRecord: Record<symbol, Promise<number>>;
expectType<Promise<Record<symbol, string>>>(pMapKeyed(symbolRecord, value => `${value}`));
await pMapKeyed(symbolRecord, (value, key) => {
	expectType<number>(value);
	expectType<symbol>(key);
	return value;
});

declare const numberRecord: Record<number, string>;
expectType<Promise<Record<number, number>>>(pMapKeyed(numberRecord, value => value.length));
await pMapKeyed(numberRecord, (value, key) => {
	expectType<string>(value);
	expectType<`${number}`>(key);
	return value;
});

await pMapKeyed(record, (value, key) => {
	expectType<number>(value);
	expectType<string>(key);
	return value;
});

// An optional property stays optional, and the mapper gets `undefined` for it.
declare const optionalInput: {a?: Promise<number>; b: string};
expectType<Promise<{a?: string; b: string}>>(pMapKeyed(optionalInput, value => `${value}`));
await pMapKeyed(optionalInput, value => {
	expectType<number | string | undefined>(value);
	return value;
});

// A nested promise is awaited all the way, but a promise inside an object value is not.
declare const nestedPromiseInput: {a: Promise<Promise<number>>; b: {c: Promise<number>}};
await pMapKeyed(nestedPromiseInput, value => {
	expectType<number | {c: Promise<number>}>(value);
	return value;
});
expectType<Promise<{a: number}>>(pMapKeyed({a: Promise.resolve(Promise.resolve(1))}, value => value));

// A `Map` with literal keys, and a `Map` subclass, give a `Map`.
declare const literalKeyMap: Map<'a' | 'b', Promise<number>>;
expectType<Promise<Map<'a' | 'b', string>>>(pMapKeyed(literalKeyMap, value => `${value}`));
expectType<Promise<Map<'a' | 'b', PromiseSettledResult<number>>>>(pMapSettledKeyed(literalKeyMap, value => value));

class KeyedCustomMap extends Map<string, number> {}
expectType<Promise<Map<string, string>>>(pMapKeyed(new KeyedCustomMap(), value => `${value}`));

declare const readonlyKeyedMap: ReadonlyMap<symbol, Promise<string>>;
await pMapKeyed(readonlyKeyedMap, (value, key) => {
	expectType<string>(value);
	expectType<symbol>(key);
	return value;
});
expectType<Promise<Map<symbol, PromiseSettledResult<number>>>>(pMapSettledKeyed(readonlyKeyedMap, value => value.length));

// A union of a `Map` and an object maps each member.
declare const mapOrObject: Map<string, number> | {a: number};
expectType<Promise<Map<string, string> | {a: string}>>(pMapKeyed(mapOrObject, value => `${value}`));

// A `pMapSkip` makes the settled keys optional, and each settled result narrows on `status`.
const optionalSettledKeyed = await pMapSettledKeyed({a: 1, b: 'b'}, value => (value === 1 ? pMapSkip : value));
expectType<PromiseSettledResult<string | number> | undefined>(optionalSettledKeyed.a);

const narrowedSettledKeyed = await pMapSettledKeyed({a: 1, b: 'b'}, async value => value);
if (narrowedSettledKeyed.a.status === 'rejected') {
	expectType<any>(narrowedSettledKeyed.a.reason);
} else {
	expectType<string | number>(narrowedSettledKeyed.a.value);
}

const settledKeyedMap = await pMapSettledKeyed(new Map([['a', 1]]), async value => `${value}`);
const settledKeyedMapEntry = settledKeyedMap.get('a');
if (settledKeyedMapEntry?.status === 'fulfilled') {
	expectType<string>(settledKeyedMapEntry.value);
}

// A generic caller can use the values.
async function doubleKeyed<Input extends Record<string, number>>(input: Input) {
	return pMapKeyed(input, value => value * 2);
}

expectType<{a: number; b: number}>(await doubleKeyed({a: 1, b: 2}));

async function wrapElements<Element>(elements: readonly Element[]) {
	return pMap(elements, async element => [element]);
}

expectType<number[][]>(await wrapElements([1, 2]));

// `pMapSkip` and `pMapStop` are distinct.
expectNotAssignable<typeof pMapSkip>(pMapStop);
expectNotAssignable<typeof pMapStop>(pMapSkip);

// A mapper that only returns `pMapSkip` or `pMapStop` gives an empty result, so its type has no values. Each result goes through a variable first, as an `expectType` around the call would change what TypeScript infers.
const onlySkipped = pMap(numbers, () => pMapSkip);
expectType<Promise<never[]>>(onlySkipped);

const onlySkippedSettled = pMapSettled(numbers, () => pMapSkip);
expectType<Promise<Array<PromiseSettledResult<never>>>>(onlySkippedSettled);

const onlySkippedKeyed = pMapKeyed({a: 1, b: 2}, () => pMapSkip);
expectType<Promise<{a?: never; b?: never}>>(onlySkippedKeyed);

const onlyStoppedKeyed = pMapKeyed({a: 1}, () => pMapStop);
expectType<Promise<{a?: never}>>(onlyStoppedKeyed);

const onlySkippedSettledKeyed = pMapSettledKeyed({a: 1}, () => pMapSkip);
expectType<Promise<{a?: PromiseSettledResult<never>}>>(onlySkippedSettledKeyed);

const onlyStoppedSettledKeyed = pMapSettledKeyed({a: 1}, () => pMapStop);
expectType<Promise<{a?: PromiseSettledResult<never>}>>(onlyStoppedSettledKeyed);

const onlySkippedMap = pMapKeyed(new Map([['a', 1]]), () => pMapSkip);
expectType<Promise<Map<string, never>>>(onlySkippedMap);

// TypeScript widens the symbol to `symbol` when an async mapper only returns `pMapSkip` or `pMapStop`, as it only keeps it when each part of the expected return type is a promise. This pins that limitation, so a TypeScript version that lifts it shows up here.
const onlySkippedAsync = pMap(numbers, async () => pMapSkip);
expectType<Promise<symbol[]>>(onlySkippedAsync);
