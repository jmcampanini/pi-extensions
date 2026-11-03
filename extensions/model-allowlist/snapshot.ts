import type { Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const guardKey = Symbol.for("pi-extensions.model-allowlist.snapshot-guards");
type GuardedRuntime = ModelRuntime & {
	[guardKey]?: WeakMap<Provider, ReadonlySet<string>>;
};

export function guardSnapshots(provider: Provider, allowed: ReadonlySet<string>) {
	const prototype: GuardedRuntime = ModelRuntime.prototype;
	if (!prototype[guardKey]) {
		const filters = new WeakMap<Provider, ReadonlySet<string>>();
		prototype[guardKey] = filters;
		const getAvailableSnapshot = prototype.getAvailableSnapshot;

		// Pi 1.4 rebuilds provisional snapshots without provider filters during refresh.
		prototype.getAvailableSnapshot = function () {
			return getAvailableSnapshot.call(this).filter((model) => {
				const native = this.getRegisteredNativeProvider(model.provider);
				const allowlist = native && filters.get(native);
				return !allowlist || allowlist.has(`${model.provider}/${model.id}`);
			});
		};
	}
	prototype[guardKey].set(provider, allowed);
}
