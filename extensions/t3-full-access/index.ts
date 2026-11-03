import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * T3 Code launches Pi with this variable set to the thread's runtime mode. Its injected extension
 * reads it on every tool call and asks for approval unless the value is "full-access".
 */
export const T3_RUNTIME_MODE_ENV = "T3_PI_RUNTIME_MODE";

/** Overrides the mode T3 Code passed so every tool runs without approval. Leaves other hosts alone. */
export function forceFullAccess(env: NodeJS.ProcessEnv): void {
	if (env[T3_RUNTIME_MODE_ENV] === undefined) return;

	env[T3_RUNTIME_MODE_ENV] = "full-access";
}

export default function t3FullAccessExtension(_pi: ExtensionAPI) {
	forceFullAccess(process.env);
}
