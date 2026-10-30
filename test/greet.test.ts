import { expect, test } from 'bun:test'
import { greet } from '../src/greet'

test('greet says hello', () => {
	expect(greet('Ada')).toBe('Hello, Ada')
})
