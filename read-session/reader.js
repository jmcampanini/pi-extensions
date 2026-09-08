(() => {
	const outlineLinks = [...document.querySelectorAll("[data-outline-target]")];
	const outlineTargets = [...new Set(outlineLinks.map((link) => link.getAttribute("href").slice(1)))]
		.map((id) => document.getElementById(id))
		.filter(Boolean);
	const updateOutline = () => {
		let active = outlineTargets[0];
		for (const target of outlineTargets) {
			if (target.getBoundingClientRect().top > 24) break;
			active = target;
		}
		for (const link of outlineLinks) {
			if (link.getAttribute("href") === `#${active?.id}`) link.setAttribute("aria-current", "location");
			else link.removeAttribute("aria-current");
		}
	};
	let outlineFrame;
	const scheduleOutlineUpdate = () => {
		if (outlineFrame !== undefined) return;
		outlineFrame = requestAnimationFrame(() => {
			outlineFrame = undefined;
			updateOutline();
		});
	};

	const latestButton = document.getElementById("latest");
	const updateLatestButton = () => {
		latestButton.hidden = window.scrollY < 160;
	};
	const scrollToLatest = () =>
		window.scrollTo({
			top: 0,
			behavior: "instant",
		});
	if ("scrollRestoration" in history) history.scrollRestoration = "manual";
	const initialPosition = () => {
		if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
		else scrollToLatest();
		updateLatestButton();
		scheduleOutlineUpdate();
	};
	window.addEventListener("load", () => requestAnimationFrame(initialPosition));
	window.addEventListener("pageshow", initialPosition);
	window.addEventListener("scroll", updateLatestButton, { passive: true });
	window.addEventListener("scroll", scheduleOutlineUpdate, { passive: true });
	window.addEventListener("resize", scheduleOutlineUpdate);
	document.addEventListener("toggle", scheduleOutlineUpdate, true);
	latestButton.addEventListener("click", scrollToLatest);

	let statusTimer;
	document.addEventListener("click", async (event) => {
		const outlineLink = event.target.closest(".outline-menu a");
		if (outlineLink) outlineLink.closest("details").open = false;

		const button = event.target.closest("button[data-copy]");
		if (!button) return;
		const source = document.getElementById(button.dataset.copy);
		const status = document.getElementById("copy-status");
		try {
			try {
				await navigator.clipboard.writeText(source.value);
			} catch {
				const position = { x: scrollX, y: scrollY };
				source.hidden = false;
				source.classList.add("clipboard-fallback");
				try {
					source.select();
					if (!document.execCommand("copy")) throw new Error("Copy unavailable");
				} finally {
					source.hidden = true;
					source.classList.remove("clipboard-fallback");
					button.focus({ preventScroll: true });
					window.scrollTo(position.x, position.y);
				}
			}
			status.textContent = "Copied. Ready to paste in Pi.";
		} catch {
			status.textContent = "Copy unavailable. Select the text and copy it manually.";
		}
		clearTimeout(statusTimer);
		status.classList.add("visible");
		statusTimer = setTimeout(() => status.classList.remove("visible"), 3000);
	});
})();
