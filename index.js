import AggregateError from 'aggregate-error';

const stopSymbol = Symbol('pMap.stop');

export default async function pMap(
	iterable,
	mapper,
	{
		concurrency = Number.POSITIVE_INFINITY,
		stopOnError = true
	} = {}
) {
	return new Promise((resolve, reject) => {
		if (typeof mapper !== 'function') {
			throw new TypeError('Mapper function is required');
		}

		if (!((Number.isSafeInteger(concurrency) || concurrency === Number.POSITIVE_INFINITY) && concurrency >= 1)) {
			throw new TypeError(`Expected \`concurrency\` to be an integer from 1 and up or \`Infinity\`, got \`${concurrency}\` (${typeof concurrency})`);
		}

		const result = [];
		const errors = [];
		const iterator = iterable[Symbol.iterator]();
		const pendingIndexes = new Set();
		let finished = false;
		let isIterableDone = false;
		let currentIndex = 0;

		const next = () => {
			if (finished) {
				return;
			}

			const nextItem = iterator.next();
			const index = currentIndex;
			currentIndex++;

			if (nextItem.done) {
				isIterableDone = true;

				if (pendingIndexes.size === 0) {
					if (!stopOnError && errors.length > 0) {
						reject(new AggregateError(errors));
					} else {
						resolve(result);
					}
				}

				return;
			}

			pendingIndexes.add(index);

			(async () => {
				try {
					const element = await nextItem.value;

					if (finished) {
						return;
					}

					result[index] = await mapper(element, index);

					if (finished) {
						return;
					}

					pendingIndexes.delete(index);

					if (result[index] && result[index][stopSymbol]) {
						finished = true;
						const stopConfig = result[index][stopSymbol];
						result[index] = stopConfig.value;
						if (stopConfig.ongoingMappings.collapse) {
							resolve(result.flat(0));
						} else {
							for (const pendingIndex of pendingIndexes) {
								result[pendingIndex] = stopConfig.ongoingMappings.fillWith;
							}

							resolve(result);
						}
					} else {
						next();
					}
				} catch (error) {
					if (stopOnError) {
						finished = true;
						reject(error);
					} else {
						errors.push(error);
						pendingIndexes.delete(index);
						next();
					}
				}
			})();
		};

		for (let index = 0; index < concurrency; index++) {
			next();

			if (isIterableDone) {
				break;
			}
		}
	});
}

pMap.stop = ({value, ongoingMappings = {}} = {}) => ({[stopSymbol]: {value, ongoingMappings}});
