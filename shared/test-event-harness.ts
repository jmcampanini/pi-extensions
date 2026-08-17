export function createTestEventHarness<Event = unknown, Context = unknown, Result = void>() {
	type Handler = (event: Event, context: Context) => Result;
	const handlers = new Map<string, Handler[]>();

	function on(type: string, handler: Handler): void {
		const registered = handlers.get(type) ?? [];
		registered.push(handler);
		handlers.set(type, registered);
	}

	function emit(type: string, event: Event, context: Context): void {
		for (const handler of handlers.get(type) ?? []) void handler(event, context);
	}

	function emitResults(type: string, event: Event, context: Context): Result[] {
		return (handlers.get(type) ?? []).map((handler) => handler(event, context));
	}

	async function emitAsync(type: string, event: Event, context: Context): Promise<void> {
		for (const handler of handlers.get(type) ?? []) await handler(event, context);
	}

	return { on, emit, emitResults, emitAsync };
}
