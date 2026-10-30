import { expect, test } from 'bun:test'
import { greet } from '../src/greet'

test('greet says hello', () => {
	expect(greet('Ada')).toBe('Hello, Ada!')
})

test('greet trims surrounding whitespace', () => {
	expect(greet('  Ada ')).toBe('Hello, Ada!')
})

test('greet supports formal mode', () => {
	expect(greet('Ada', { formal: true })).toBe('Good day, Ada.')
})

test('greet keeps the default when formal mode is not enabled', () => {
	expect(greet('  Ada ', {})).toBe('Hello, Ada!')
	expect(greet('  Ada ', { formal: false })).toBe('Hello, Ada!')
})
