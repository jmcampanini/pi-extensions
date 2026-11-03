import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";

type OriginalProvider = {
	provider: Provider;
	config: ReturnType<ModelRegistry["getRegisteredProviderConfig"]>;
};

export default function modelAllowlist(pi: ExtensionAPI) {
	const originals = new WeakMap<ModelRegistry, Map<string, OriginalProvider>>();

	pi.on("session_start", async (_event, ctx) => {
		const allowed = readAllowlist(pi.getSettings());
		if (allowed === undefined && !originals.has(ctx.modelRegistry)) return;

		const providers = originals.get(ctx.modelRegistry) ?? new Map<string, OriginalProvider>();
		originals.set(ctx.modelRegistry, providers);
		for (const model of ctx.modelRegistry.getAll()) {
			if (providers.has(model.provider)) continue;
			const provider = ctx.modelRegistry.getProvider(model.provider);
			if (!provider) continue;
			providers.set(model.provider, {
				provider,
				config: ctx.modelRegistry.getRegisteredProviderConfig(model.provider),
			});
		}

		for (const [id, { provider, config }] of providers) {
			if (allowed === undefined) {
				pi.unregisterProvider(id);
				if (config) ctx.modelRegistry.registerProvider(id, config);
				else pi.registerProvider(provider);
				continue;
			}

			const keep = (model: { id: string }) => allowed.has(`${id}/${model.id}`);
			if (config) {
				const refreshModels = config.refreshModels?.bind(config);
				const modifyModels = config.oauth?.modifyModels?.bind(config.oauth);
				ctx.modelRegistry.registerProvider(id, {
					...config,
					models: (config.models ?? provider.getAllModels?.() ?? provider.getModels()).filter(keep),
					...(refreshModels ? {
						refreshModels: async (context) => (await refreshModels(context)).filter(keep),
					} : {}),
					...(config.oauth && modifyModels ? {
						oauth: { ...config.oauth, modifyModels: (models, credentials) => modifyModels(models, credentials).filter(keep) },
					} : {}),
				});
				continue;
			}

			const filterAllModels = provider.filterAllModels?.bind(provider);
			pi.registerProvider({
				...provider,
				getModels: () => provider.getModels().filter(keep),
				getAllModels: () => (provider.getAllModels?.() ?? provider.getModels()).filter(keep),
				filterModels: (models, credential) => (provider.filterModels?.(models, credential) ?? models).filter(keep),
				...(filterAllModels ? {
					filterAllModels: (models, credential) => filterAllModels(models, credential).filter(keep),
				} : {}),
			});
		}

		await ctx.modelRegistry.refresh({ allowNetwork: false });
	});
}

function readAllowlist(settings: ReturnType<ExtensionAPI["getSettings"]>): Set<string> | undefined {
	const entries = "modelAllowlist" in settings ? settings.modelAllowlist : undefined;
	if (entries === undefined) return undefined;

	const isExactIdList = Array.isArray(entries) && entries.length > 0 &&
		entries.every((entry) => typeof entry === "string" && /^[^/\s*?]+\/[^\s*?]+$/.test(entry));
	if (!isExactIdList) throw new Error("modelAllowlist must be a nonempty array of exact provider/model IDs");

	return new Set(entries);
}
