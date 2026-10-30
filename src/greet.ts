export function greet(name: string, options?: { formal?: boolean }): string {
	if (options?.formal) return `Good day, ${name}`
	return `Hello, ${name}`
}
