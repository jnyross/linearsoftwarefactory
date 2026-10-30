import { expect, test } from 'bun:test'
import { slugify } from '../src/slugify'

test.each([
	['  Hello, World!  ', 'hello-world'],
	['AZ09', 'az09'],
	['Foo__-- \t\nBAR...baz/42', 'foo-bar-baz-42'],
	['already-slug-123', 'already-slug-123'],
	['---Hello---', 'hello'],
	['!!!Start', 'start'],
	['End???', 'end'],
	['', ''],
	[' \t\n ', ''],
	['***', ''],
	['café déjà vu', 'caf-d-j-vu'],
	['東京', ''],
	['A💡B', 'a-b'],
	['aÉb', 'a-b'],
	['0', '0'],
	['İ K', 'i-k'],
])('slugify(%j) returns %j', (input, expected) => {
	const actual = slugify(input)
	expect(actual).toBe(expected)
	if (actual !== '') {
		expect(actual).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
	}
})
