import { visibleWidth } from "@earendil-works/pi-tui";

export const COMPONENT_IDS = [
	"token-flow",
	"cache",
	"cost",
	"context",
	"compact-target",
	"elapsed",
	"runtime-identity",
] as const;

export type FooterComponentId = (typeof COMPONENT_IDS)[number];
export type FooterComponentState = "full" | "compact" | "hidden";
export type FooterAlignment = "left" | "right";

export interface FooterComponent {
	id: FooterComponentId;
	alignment: FooterAlignment;
	full: string;
	compact: string;
}

export interface FooterLayoutSpan {
	text: string;
	component?: FooterComponentId;
}

export interface FittedFooterLayout {
	left: string;
	right: string;
	line: string;
	spans: FooterLayoutSpan[];
	states: Record<FooterComponentId, FooterComponentState>;
}

export const DISPLAY_ORDER: readonly FooterComponentId[] = [
	"token-flow",
	"cache",
	"cost",
	"context",
	"compact-target",
	"elapsed",
	"runtime-identity",
];

export const REDUCTION_ORDER: readonly FooterComponentId[] = [
	"cost",
	"compact-target",
	"elapsed",
	"token-flow",
	"cache",
	"context",
	"runtime-identity",
];

const COMPONENT_SEPARATOR = " • ";
const MINIMUM_SIDE_GAP = 2;

interface VisibleComponent {
	id: FooterComponentId;
	text: string;
}

function initialStates(components: ReadonlyMap<FooterComponentId, FooterComponent>): Record<FooterComponentId, FooterComponentState> {
	return Object.fromEntries(
		COMPONENT_IDS.map((id) => [id, components.has(id) ? "full" : "hidden"]),
	) as Record<FooterComponentId, FooterComponentState>;
}

function composeSide(
	alignment: FooterAlignment,
	components: ReadonlyMap<FooterComponentId, FooterComponent>,
	states: Readonly<Record<FooterComponentId, FooterComponentState>>,
): VisibleComponent[] {
	return DISPLAY_ORDER.flatMap((id) => {
		const component = components.get(id);
		if (!component || component.alignment !== alignment) return [];
		const state = states[id];
		if (state === "hidden") return [];
		const text = component[state];
		return text ? [{ id, text }] : [];
	});
}

function joinSide(components: readonly VisibleComponent[]): string {
	return components.map((component) => component.text).join(COMPONENT_SEPARATOR);
}

function compose(
	components: ReadonlyMap<FooterComponentId, FooterComponent>,
	states: Readonly<Record<FooterComponentId, FooterComponentState>>,
): {
	left: string;
	right: string;
	leftComponents: VisibleComponent[];
	rightComponents: VisibleComponent[];
	requiredWidth: number;
} {
	const leftComponents = composeSide("left", components, states);
	const rightComponents = composeSide("right", components, states);
	const left = joinSide(leftComponents);
	const right = joinSide(rightComponents);
	const requiredWidth = visibleWidth(left) + visibleWidth(right) + (left && right ? MINIMUM_SIDE_GAP : 0);
	return { left, right, leftComponents, rightComponents, requiredWidth };
}

function appendSideSpans(spans: FooterLayoutSpan[], components: readonly VisibleComponent[]): void {
	for (const [index, component] of components.entries()) {
		if (index > 0) spans.push({ text: COMPONENT_SEPARATOR });
		spans.push({ text: component.text, component: component.id });
	}
}

function renderSpans(
	left: string,
	right: string,
	leftComponents: readonly VisibleComponent[],
	rightComponents: readonly VisibleComponent[],
	width: number,
): FooterLayoutSpan[] {
	const spans: FooterLayoutSpan[] = [];
	appendSideSpans(spans, leftComponents);
	if (right) {
		spans.push({ text: " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right))) });
		appendSideSpans(spans, rightComponents);
	}
	return spans;
}

export function styleFooterSpans(
	spans: readonly FooterLayoutSpan[],
	styleDefault: (text: string) => string,
	styleComponent: (id: FooterComponentId, text: string) => string,
): string {
	return spans
		.map((span) => span.component ? styleComponent(span.component, span.text) : styleDefault(span.text))
		.join("");
}

export function fitFooterLayout(componentsInput: readonly FooterComponent[], width: number): FittedFooterLayout {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	const components = new Map(componentsInput.map((component) => [component.id, component]));
	const states = initialStates(components);

	function resultIfFit(): FittedFooterLayout | undefined {
		const candidate = compose(components, states);
		if (candidate.requiredWidth > safeWidth) return undefined;
		const spans = renderSpans(
			candidate.left,
			candidate.right,
			candidate.leftComponents,
			candidate.rightComponents,
			safeWidth,
		);
		return {
			left: candidate.left,
			right: candidate.right,
			line: spans.map((span) => span.text).join(""),
			spans,
			states: { ...states },
		};
	}

	const full = resultIfFit();
	if (full) return full;

	for (const nextState of ["compact", "hidden"] as const) {
		for (const id of REDUCTION_ORDER) {
			if (!components.has(id)) continue;
			states[id] = nextState;
			const fitted = resultIfFit();
			if (fitted) return fitted;
		}
	}

	return {
		left: "",
		right: "",
		line: "",
		spans: [],
		states: { ...states },
	};
}
