import chalk from 'chalk';
import inRange from 'in-range';

export default function assertInRange(t, value, {start = 0, end}) {
	if (inRange(value, {start, end})) {
		t.pass();
	} else {
		t.fail(`${start} ${start <= value ? '≤' : chalk.red('≰')} ${chalk.yellow(value)} ${value <= end ? '≤' : chalk.red('≰')} ${end}`);
	}
}
