import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { fitText } from "../interactive-subagents/text-fit.ts";
import type { RepositoryContext } from "./repository-context.ts";

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

export const DISPLAY_ORDER: readonly FooterComponentId[] = [...COMPONENT_IDS];

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

export type RepositoryComponentId = "cwd" | "session" | "issue" | "pr" | "branch";
export type RepositoryComponentState = "full" | "compact" | "clamped" | "hidden";
export type RepositoryReductionStage =
	| "full"
	| "cwd-compact"
	| "session-hidden"
	| "issue-compact"
	| "pr-compact"
	| "issue-hidden"
	| "pr-hidden"
	| "local-clamped"
	| "branch-only";

export interface CwdVariants {
	full: string;
	compact: string;
}

export interface RepositoryLayoutInput {
	cwd: CwdVariants;
	session?: string;
	branch?: string | null;
	context: RepositoryContext;
}

export interface RepositoryLayoutSpan {
	text: string;
	component?: RepositoryComponentId;
	url?: string;
}

export interface FittedRepositoryLayout {
	left: string;
	right: string;
	line: string;
	spans: RepositoryLayoutSpan[];
	states: Record<RepositoryComponentId, RepositoryComponentState>;
	stage: RepositoryReductionStage;
}

interface RepositoryLayoutState {
	cwd: RepositoryComponentState;
	session: RepositoryComponentState;
	issue: RepositoryComponentState;
	pr: RepositoryComponentState;
	branch: RepositoryComponentState;
}

function isPathWithinHome(cwd: string, home: string): boolean {
	if (cwd === home) return true;
	if (!cwd.startsWith(home)) return false;
	const boundary = cwd[home.length];
	return boundary === "/" || boundary === "\\";
}

export function cwdVariants(cwd: string, home: string | undefined): CwdVariants {
	const normalizedHome = home?.replace(/[\\/]+$/, "");
	const full = normalizedHome && isPathWithinHome(cwd, normalizedHome)
		? `~${cwd.slice(normalizedHome.length)}`
		: cwd;
	const parts = full.split(/[\\/]/).filter(Boolean);
	const compact = parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : full;
	return { full, compact };
}

function repositoryStates(input: RepositoryLayoutInput): RepositoryLayoutState {
	return {
		cwd: "full",
		session: input.session ? "full" : "hidden",
		issue: input.context.issue ? "full" : "hidden",
		pr: input.context.pr ? "full" : "hidden",
		branch: input.branch ? "full" : "hidden",
	};
}

function repositorySideSpans(
	input: RepositoryLayoutInput,
	states: Readonly<RepositoryLayoutState>,
	cwdText: string,
	branchText: string,
): { left: RepositoryLayoutSpan[]; right: RepositoryLayoutSpan[] } {
	const left: RepositoryLayoutSpan[] = [];
	const right: RepositoryLayoutSpan[] = [];
	if (states.cwd !== "hidden" && cwdText) left.push({ text: cwdText, component: "cwd" });
	if (states.session !== "hidden" && input.session) left.push({ text: input.session, component: "session" });
	if (states.issue !== "hidden" && input.context.issue) {
		const issue = input.context.issue;
		right.push({
			text: states.issue === "compact" ? `i${issue.number}` : `is#${issue.number} ${issue.state}`,
			component: "issue",
			url: issue.url,
		});
	}
	if (states.pr !== "hidden" && input.context.pr) {
		const pr = input.context.pr;
		right.push({
			text: states.pr === "compact" ? `p${pr.number}` : `pr#${pr.number} ${pr.state}`,
			component: "pr",
			url: pr.url,
		});
	}
	if (states.branch !== "hidden" && branchText) right.push({ text: branchText, component: "branch" });
	return { left, right };
}

function repositorySideText(spans: readonly RepositoryLayoutSpan[]): string {
	return spans.map((span) => span.text).join(COMPONENT_SEPARATOR);
}

function repositoryRequiredWidth(left: string, right: string): number {
	return visibleWidth(left) + visibleWidth(right) + (left && right ? MINIMUM_SIDE_GAP : 0);
}

function repositoryResult(
	input: RepositoryLayoutInput,
	states: Readonly<RepositoryLayoutState>,
	cwdText: string,
	branchText: string,
	width: number,
	stage: RepositoryReductionStage,
): FittedRepositoryLayout {
	const sides = repositorySideSpans(input, states, cwdText, branchText);
	const left = repositorySideText(sides.left);
	const right = repositorySideText(sides.right);
	const spans: RepositoryLayoutSpan[] = [];
	for (const [index, span] of sides.left.entries()) {
		if (index > 0) spans.push({ text: COMPONENT_SEPARATOR });
		spans.push(span);
	}
	if (right) {
		spans.push({ text: " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right))) });
		for (const [index, span] of sides.right.entries()) {
			if (index > 0) spans.push({ text: COMPONENT_SEPARATOR });
			spans.push(span);
		}
	}
	return {
		left,
		right,
		line: spans.map((span) => span.text).join(""),
		spans,
		states: { ...states },
		stage,
	};
}

function fitTail(text: string, width: number): string {
	if (width <= 0) return "";
	const textWidth = visibleWidth(text);
	if (textWidth <= width) return text;
	if (width === 1) return "…";
	return `…${sliceByColumn(text, textWidth - width + 1, width - 1, true)}`;
}

export function fitRepositoryLayout(input: RepositoryLayoutInput, width: number): FittedRepositoryLayout {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	const states = repositoryStates(input);
	let cwdText = input.cwd.full;
	let branchText = input.branch ?? "";

	function resultIfFit(stage: RepositoryReductionStage): FittedRepositoryLayout | undefined {
		const result = repositoryResult(input, states, cwdText, branchText, safeWidth, stage);
		return repositoryRequiredWidth(result.left, result.right) <= safeWidth ? result : undefined;
	}

	let fitted = resultIfFit("full");
	if (fitted) return fitted;

	states.cwd = "compact";
	cwdText = input.cwd.compact;
	fitted = resultIfFit("cwd-compact");
	if (fitted) return fitted;

	if (states.session !== "hidden") {
		states.session = "hidden";
		fitted = resultIfFit("session-hidden");
		if (fitted) return fitted;
	}

	if (states.issue !== "hidden") {
		states.issue = "compact";
		fitted = resultIfFit("issue-compact");
		if (fitted) return fitted;
	}

	if (states.pr !== "hidden") {
		states.pr = "compact";
		fitted = resultIfFit("pr-compact");
		if (fitted) return fitted;
	}

	if (states.issue !== "hidden") {
		states.issue = "hidden";
		fitted = resultIfFit("issue-hidden");
		if (fitted) return fitted;
	}

	if (states.pr !== "hidden") {
		states.pr = "hidden";
		fitted = resultIfFit("pr-hidden");
		if (fitted) return fitted;
	}

	states.session = "hidden";
	states.issue = "hidden";
	states.pr = "hidden";
	if (!branchText) {
		states.cwd = "clamped";
		cwdText = fitTail(cwdText, safeWidth);
		return repositoryResult(input, states, cwdText, branchText, safeWidth, "local-clamped");
	}
	if (!cwdText || safeWidth < 6) {
		states.cwd = "hidden";
		states.branch = "clamped";
		branchText = fitText(branchText, safeWidth);
		return repositoryResult(input, states, "", branchText, safeWidth, "branch-only");
	}

	const available = safeWidth - MINIMUM_SIDE_GAP;
	let leftWidth = Math.max(2, Math.floor(available * 0.44));
	let rightWidth = available - leftWidth;
	const cwdWidth = visibleWidth(cwdText);
	const branchWidth = visibleWidth(branchText);
	if (leftWidth > cwdWidth) {
		leftWidth = cwdWidth;
		rightWidth = available - leftWidth;
	}
	if (rightWidth > branchWidth) {
		rightWidth = branchWidth;
		leftWidth = available - rightWidth;
	}
	states.cwd = leftWidth < cwdWidth ? "clamped" : states.cwd;
	states.branch = rightWidth < branchWidth ? "clamped" : states.branch;
	cwdText = fitTail(cwdText, leftWidth);
	branchText = fitText(branchText, rightWidth);
	return repositoryResult(input, states, cwdText, branchText, safeWidth, "local-clamped");
}

export function styleRepositorySpans(
	spans: readonly RepositoryLayoutSpan[],
	styleDefault: (text: string) => string,
	styleLink: (text: string, url: string) => string,
): string {
	return spans
		.map((span) => span.url ? styleLink(span.text, span.url) : styleDefault(span.text))
		.join("");
}
