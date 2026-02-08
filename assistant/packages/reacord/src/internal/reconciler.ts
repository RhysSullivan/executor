import type { HostConfig } from "react-reconciler";
import ReactReconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants.js";
import { raise } from "./helpers";
import { Node } from "./node";
import type { Renderer } from "./renderer";
import { TextNode } from "./text-node";

let currentUpdatePriority: number = DefaultEventPriority;

type HostContext = Record<string, never>;

type Thenable = {
	then: (resolve: () => void) => void;
};

const config: HostConfig<
	string,
	Record<string, unknown>,
	Renderer,
	Node<unknown>,
	TextNode,
	never,
	never,
	never,
	HostContext,
	true,
	never,
	number,
	number
> & {
	supportsMicrotasks: boolean;
	scheduleMicrotask: (fn: () => void) => void;
	getCurrentUpdatePriority: () => number;
	setCurrentUpdatePriority: (priority: number) => void;
	resolveUpdatePriority: () => number;
	maySuspendCommit: (type: string, props: Record<string, unknown>) => boolean;
	preloadInstance: (type: string, props: Record<string, unknown>) => boolean;
	startSuspendingCommit: () => void;
	suspendInstance: (type: string, props: Record<string, unknown>) => void;
	waitForCommitToBeReady: () => Thenable | null;
	NotPendingTransition: null;
	HostTransitionContext: { _currentValue: null; _currentValue2: null };
	resetFormInstance: (instance: Node<unknown>) => void;
	shouldAttemptEagerTransition: () => boolean;
	hideInstance: (instance: Node<unknown>) => void;
	unhideInstance: (
		instance: Node<unknown>,
		props: Record<string, unknown>,
	) => void;
	hideTextInstance: (textInstance: TextNode) => void;
	unhideTextInstance: (textInstance: TextNode, text: string) => void;
} = {
	supportsMutation: true,
	supportsPersistence: false,
	supportsHydration: false,
	isPrimaryRenderer: true,

	supportsMicrotasks: true,
	scheduleMicrotask: queueMicrotask,

	scheduleTimeout: (fn: () => void, delay?: number) =>
		globalThis.setTimeout(fn, delay) as unknown as number,
	cancelTimeout: (id: number) =>
		globalThis.clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
	noTimeout: -1,

	getCurrentUpdatePriority: () => currentUpdatePriority,
	setCurrentUpdatePriority: (priority: number) => {
		currentUpdatePriority = priority;
	},
	resolveUpdatePriority: () => currentUpdatePriority || DefaultEventPriority,

	maySuspendCommit: () => true,
	preloadInstance: () => true,
	startSuspendingCommit: () => {},
	suspendInstance: () => {},
	waitForCommitToBeReady: () => null,
	NotPendingTransition: null,
	HostTransitionContext: { _currentValue: null, _currentValue2: null },
	resetFormInstance: () => {},
	shouldAttemptEagerTransition: () => false,

	getRootHostContext: () => ({}),
	getChildHostContext: (parentContext) => parentContext ?? {},

	createInstance: (
		type,
		props,
		_rootContainer,
		_hostContext,
		_internalHandle,
	) => {
		if (type !== "reacord-element") {
			raise(`Unknown element type: ${type}`);
		}

		if (typeof props.createNode !== "function") {
			raise("Missing createNode function");
		}

		const node: unknown = props.createNode(props.props as never);
		if (!(node instanceof Node)) {
			raise("createNode function did not return a Node");
		}

		return node;
	},
	createTextInstance: (text, _rootContainer, _hostContext, _internalHandle) =>
		new TextNode(text),
	shouldSetTextContent: () => false,
	detachDeletedInstance: () => {},
	beforeActiveInstanceBlur: () => {},
	afterActiveInstanceBlur: () => {},
	getInstanceFromNode: () => null,
	getInstanceFromScope: () => null,

	hideInstance: (instance) => {
		instance.hidden = true;
	},
	unhideInstance: (instance) => {
		instance.hidden = false;
	},
	hideTextInstance: (textInstance) => {
		textInstance.hidden = true;
	},
	unhideTextInstance: (textInstance) => {
		textInstance.hidden = false;
	},

	clearContainer: (renderer) => {
		renderer.nodes.clear();
	},
	appendChildToContainer: (renderer, child) => {
		renderer.nodes.add(child);
	},
	removeChildFromContainer: (renderer, child) => {
		renderer.nodes.remove(child);
	},
	insertInContainerBefore: (renderer, child, before) => {
		renderer.nodes.addBefore(child, before);
	},

	appendInitialChild: (parent, child) => {
		parent.children.add(child);
	},
	appendChild: (parent, child) => {
		parent.children.add(child);
	},
	removeChild: (parent, child) => {
		parent.children.remove(child);
	},
	insertBefore: (parent, child, before) => {
		parent.children.addBefore(child, before);
	},

	prepareUpdate: (_instance, _type, oldProps, newProps) => {
		return oldProps.props !== newProps.props ? true : null;
	},
	commitUpdate: (node, _payload, _type, oldProps, newProps) => {
		// react-reconciler may pass newProps without a props field in some update scenarios,
		// particularly during batched updates. Fall back to oldProps to ensure we don't lose
		// the current prop values when this occurs.
		const propsToUse =
			(newProps as Record<string, unknown>).props !== undefined
				? (newProps as Record<string, unknown>).props
				: (oldProps as Record<string, unknown>).props;
		if (propsToUse !== undefined) {
			node.props = propsToUse;
		}
	},
	commitTextUpdate: (node, _oldText, newText) => {
		node.props = newText;
	},

	prepareForCommit: () => null,
	resetAfterCommit: (renderer) => {
		queueMicrotask(() => {
			renderer.render();
		});
	},
	prepareScopeUpdate: () => {},

	preparePortalMount: () => raise("Portals are not supported"),
	getPublicInstance: () => raise("Refs are currently not supported"),

	finalizeInitialChildren: () => false,

	getCurrentEventPriority: () => DefaultEventPriority,
};

export const reconciler = ReactReconciler(config);
