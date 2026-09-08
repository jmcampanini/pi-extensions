import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../reader.js", import.meta.url), "utf8");

function createBrowser(positions: { id: string; top: number }[], hash = "") {
	const window = Object.assign(new EventTarget(), {
		scrollY: 0,
		scrollTo(this: EventTarget & { scrollY: number }, { top }: { top: number }) {
			this.scrollY = top;
			this.dispatchEvent(new Event("scroll"));
		},
	});
	const targets = positions.map((position) => ({
		...position,
		getBoundingClientRect() {
			return { top: this.top - window.scrollY };
		},
		scrollIntoView() {
			window.scrollTo({ top: this.top - 24 });
		},
	}));
	const outlines = Array.from({ length: 2 }, () =>
		targets.map((target) => {
			const attributes = new Map([["href", `#${target.id}`]]);
			return {
				getAttribute: (name: string) => attributes.get(name) ?? null,
				setAttribute: (name: string, value: string) => attributes.set(name, value),
				removeAttribute: (name: string) => attributes.delete(name),
			};
		}),
	);
	const latestButton = Object.assign(new EventTarget(), { hidden: true });
	const documentListeners: { type: string; listener: () => void; capture: boolean }[] = [];
	const document = {
		getElementById(id: string) {
			return id === "latest" ? latestButton : (targets.find((target) => target.id === id) ?? null);
		},
		querySelectorAll(selector: string) {
			if (selector === "[data-outline-target]") return outlines.flat();
			throw new Error(`Unsupported selector: ${selector}`);
		},
		addEventListener(type: string, listener: () => void, options?: boolean | AddEventListenerOptions) {
			documentListeners.push({
				type,
				listener,
				capture: options === true || (typeof options === "object" && options.capture === true),
			});
		},
	};
	let frameId = 0;
	const frames = new Map<number, () => void>();
	runInNewContext(script, {
		window,
		document,
		history: { scrollRestoration: "auto" },
		location: { hash },
		requestAnimationFrame(callback: () => void) {
			frames.set(++frameId, callback);
			return frameId;
		},
	});

	return {
		window,
		targets,
		latestButton,
		flushFrames() {
			while (frames.size) {
				const callbacks = [...frames.values()];
				frames.clear();
				for (const callback of callbacks) callback();
			}
		},
		toggleToolDisclosure() {
			// Native details toggle events reach the document only during capture.
			for (const { type, listener, capture } of documentListeners) {
				if (type === "toggle" && capture) listener();
			}
		},
		currentLinks() {
			return outlines.map((links) =>
				Object.fromEntries(
					links.flatMap((link) => {
						const current = link.getAttribute("aria-current");
						return current === null ? [] : [[link.getAttribute("href"), current]];
					}),
				),
			);
		},
	};
}

const positions = [
	{ id: "reply-z", top: 80 },
	{ id: "reasoning", top: 220 },
	{ id: "next-step", top: 500 },
	{ id: "exchange-a", top: 800 },
	{ id: "details", top: 920 },
];

describe("reader browser script", () => {
	it("highlights one matching entry in both outlines at the 24px reading inset", () => {
		const browser = createBrowser(positions);
		browser.window.dispatchEvent(new Event("load"));
		browser.flushFrames();

		assert.deepEqual(browser.currentLinks(), [{ "#reply-z": "location" }, { "#reply-z": "location" }]);
		for (const [top, id] of [
			[195, "reply-z"],
			[196, "reasoning"],
			[476, "next-step"],
			[776, "exchange-a"],
			[896, "details"],
			[300, "reasoning"],
			[0, "reply-z"],
		] as const) {
			browser.window.scrollTo({ top });
			browser.flushFrames();

			assert.deepEqual(
				browser.currentLinks(),
				[{ [`#${id}`]: "location" }, { [`#${id}`]: "location" }],
				`scrollY=${top}`,
			);
		}
	});

	it("keeps the current Turn highlighted when the turns have no headings", () => {
		const browser = createBrowser([
			{ id: "newest", top: 80 },
			{ id: "older", top: 400 },
		]);
		browser.window.dispatchEvent(new Event("load"));
		browser.flushFrames();

		assert.deepEqual(browser.currentLinks(), [{ "#newest": "location" }, { "#newest": "location" }]);

		browser.window.scrollTo({ top: 500 });
		browser.flushFrames();

		assert.deepEqual(browser.currentLinks(), [{ "#older": "location" }, { "#older": "location" }]);
	});

	it("recomputes the active heading when a non-bubbling tool disclosure shifts the content", () => {
		const browser = createBrowser(positions);
		browser.window.scrollTo({ top: 300 });
		browser.flushFrames();

		assert.deepEqual(browser.currentLinks(), [{ "#reasoning": "location" }, { "#reasoning": "location" }]);

		browser.targets[1]!.top = 420;
		browser.toggleToolDisclosure();
		browser.flushFrames();

		assert.deepEqual(browser.currentLinks(), [{ "#reply-z": "location" }, { "#reply-z": "location" }]);

		browser.targets[1]!.top = 220;
		browser.toggleToolDisclosure();
		browser.flushFrames();

		assert.deepEqual(browser.currentLinks(), [{ "#reasoning": "location" }, { "#reasoning": "location" }]);
	});

	it("highlights the hash destination on page load and restored pages", () => {
		const browser = createBrowser(positions, "#next-step");
		browser.window.dispatchEvent(new Event("load"));
		browser.flushFrames();

		assert.deepEqual(browser.currentLinks(), [{ "#next-step": "location" }, { "#next-step": "location" }]);

		browser.window.scrollTo({ top: 0 });
		browser.flushFrames();
		browser.window.dispatchEvent(new Event("pageshow"));
		browser.flushFrames();

		assert.deepEqual(browser.currentLinks(), [{ "#next-step": "location" }, { "#next-step": "location" }]);
	});

	it("recomputes the active entry after viewport resizing changes heading positions", () => {
		const browser = createBrowser(positions, "#reasoning");
		browser.window.dispatchEvent(new Event("load"));
		browser.flushFrames();
		browser.targets[1]!.top = 350;

		browser.window.dispatchEvent(new Event("resize"));
		browser.flushFrames();

		assert.deepEqual(browser.currentLinks(), [{ "#reply-z": "location" }, { "#reply-z": "location" }]);
	});

	it("uses the latest reading position when scroll events arrive before the next frame", () => {
		const browser = createBrowser(positions);
		browser.window.scrollTo({ top: 196 });
		browser.window.scrollTo({ top: 776 });
		browser.window.scrollTo({ top: 476 });
		browser.flushFrames();

		assert.deepEqual(browser.currentLinks(), [{ "#next-step": "location" }, { "#next-step": "location" }]);

		browser.window.scrollTo({ top: 0 });
		browser.flushFrames();

		assert.deepEqual(browser.currentLinks(), [{ "#reply-z": "location" }, { "#reply-z": "location" }]);
	});

	it("updates the outline and latest button when returning to the top", () => {
		const browser = createBrowser(positions);
		browser.window.scrollTo({ top: 476 });
		browser.flushFrames();

		assert.equal(browser.latestButton.hidden, false);

		browser.latestButton.dispatchEvent(new Event("click"));
		browser.flushFrames();

		assert.equal(browser.window.scrollY, 0);
		assert.equal(browser.latestButton.hidden, true);
		assert.deepEqual(browser.currentLinks(), [{ "#reply-z": "location" }, { "#reply-z": "location" }]);
	});

	it("keeps navigation working when the outline is empty", () => {
		const browser = createBrowser([]);
		browser.window.dispatchEvent(new Event("load"));
		browser.flushFrames();
		browser.window.scrollTo({ top: 200 });
		browser.flushFrames();

		assert.deepEqual(browser.currentLinks(), [{}, {}]);
		assert.equal(browser.latestButton.hidden, false);
	});
});
