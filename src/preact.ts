import { render as prender, ContainerNode, VNode, createElement, options as preactOptions } from 'preact'
import { DOMElement, DOMRootElement, NodeNames } from './dom.js';
import * as dom from './dom.js'
import Ink, { type Options as InkOptions } from './ink.js';
import instances from './instances.js';
import { Stream } from 'node:stream'
import { throttle } from 'es-toolkit/compat';
import applyStyle, { type Styles } from './styles.js';

const TEXT_NODE = 1
const BOX_NODE = 3
const ROOT_NODE = 4;
const nodeTypes: Record<NodeNames, number> = {
	'ink-text': TEXT_NODE,
	'ink-box': BOX_NODE,
	'ink-root': ROOT_NODE,
	'#text': TEXT_NODE
};

const domNode2PreactElement = new WeakMap<dom.DOMNode, PreactElement>();

(globalThis as any).document = {
	createTextNode(text: string) {
		const textNode = dom.createTextNode(text);
		const ele = new PreactElement(textNode)
		domNode2PreactElement.set(textNode, ele)
		return ele
	},
	createElementNS(namespaceURI: string, qualifiedName: string) {
		if (qualifiedName.startsWith('ink-')) {
			const node = dom.createNode(qualifiedName as any)
			const ele = new PreactElement(node)
			domNode2PreactElement.set(node, ele)
			return ele
		}
		throw new Error('Method not implemented.');
	}
}

function isContainer(node: dom.DOMNode): node is dom.DOMElement {
	return node.nodeName === 'ink-root' || node.nodeName === 'ink-box' || node.nodeName === 'ink-text'
}

function searchStatic(node: dom.DOMNode): DOMElement | undefined {
	if (node.internal_static) {
		return node as DOMElement
	}
	if (node.nodeName === 'ink-root' || node.nodeName === 'ink-box') {
		for (const child of node.childNodes) {
			const staticNode = searchStatic(child)
			if (staticNode) {
				return staticNode
			}
		}
	}
	return
}



class PreactElement implements ContainerNode {
	_style: Styles | null = null
	addEventListener(key: string, callback: Function) {
		// @ts-ignore
		this.node.events['on' + key] = (e: object) => {
			callback.call(
				this,
				{
					type: key,
					...e
				})
		}
	}
	removeEventListener(key: string) {
		// @ts-ignore
		this.node.events['on' + key] = undefined
	}
	get attributes() {
		return this.node.attributes ?? {}
	}
	get style() {
		if (this._style) {
			return this._style
		}
		const node = this.node;
		this._style = new Proxy(node.style, {
			set(obj, prop, value) {
				if (typeof value == 'string' && /^\d+px/.test(value)) {
					const r = Reflect.set(obj, prop, +value.replace('px', ''))
					if (node.yogaNode) {
						applyStyle(node.yogaNode, obj)
						PreactElement.scheduleOutput()
					}
					return r
				}
				const r = Reflect.set(obj, prop, value)
				if (node.yogaNode) {
					applyStyle(node.yogaNode, obj)
					PreactElement.scheduleOutput()
				}
				return r
			}
		})

		return this._style
	}
	set data(data: any) {
		if (this.node.nodeName === '#text') {
			dom.setTextNodeValue(this.node, String(data))
			PreactElement.scheduleOutput()
		}
	}
	set internal_transform(value: any) {
		this.node.internal_transform = value
		PreactElement.scheduleOutput()
	}
	setAttribute(key: string, value: any) {
		if (key === 'style') {
			dom.setStyle(this.node as DOMElement, value)
		}
		if (key === 'internal_transform') {
			this.node.internal_transform = value
		}
		if (key === 'internal_static') {
			this.node.internal_static = value
			if (value) {
				PreactElement.root.staticNode = (this.node as dom.DOMBoxElement)
			} else {
				PreactElement.root.staticNode = searchStatic(PreactElement.root)
			}
		}
		dom.setAttribute(this.node as DOMElement, key, value)
		PreactElement.scheduleOutput()
	}
	constructor(public readonly node: dom.DOMNode) {
		this.nodeType = nodeTypes[node.nodeName]
	}
	removeChild(child: ContainerNode): ContainerNode {
		const thisNode = this.node;
		if (isContainer(thisNode)) {
			const childNode = (child as PreactElement).node;
			dom.removeChildNode(thisNode, childNode as DOMElement);
			childNode.yogaNode?.freeRecursive();
			PreactElement.scheduleOutput()
			return child;
		}
		throw new Error('This is not a container');
	}
	appendChild(node: ContainerNode): ContainerNode {
		const thisNode = this.node
		if (isContainer(thisNode)) {
			PreactElement.scheduleOutput()
			const n = (node as PreactElement).node
			dom.appendChildNode(
				thisNode,
				n as DOMElement
			)
			return node
		}
		throw new Error('This is not a container');
	}
	insertBefore(node: ContainerNode, child: ContainerNode | null): ContainerNode {
		const thisNode = this.node;
		if (isContainer(thisNode)) {
			PreactElement.scheduleOutput()
			const newNode = (node as PreactElement).node;
			const refNode = child ? (child as PreactElement).node : null;
			dom.insertBeforeNode(
				thisNode,
				newNode as DOMElement,
				refNode as DOMElement
			);
			return node;
		}
		throw new Error('This is not a container');
	}
	contains(other: ContainerNode | null): boolean {
		const thisNode = this.node;
		if (isContainer(thisNode)) {
			const otherNode = (other as PreactElement).node;
			const search = (node: DOMElement): boolean => {
				if (node === otherNode) {
					return true
				}
				for (const child of (node.childNodes ?? [])) {
					if (search(child as DOMElement)) {
						return true
					}
				}
				return false
			}
			return search(thisNode as DOMElement)
		}
		throw new Error('This is not a container');
	}
	get childNodes(): PreactElement[] {
		const thisNode = this.node;
		if (isContainer(thisNode)) {
			return thisNode.childNodes.map(domNode2PreactElement.get).filter(Boolean) as PreactElement[]
		}
		return []
	};
	get firstChild(): PreactElement | null {
		const thisNode = this.node;
		if (isContainer(thisNode)) {
			return domNode2PreactElement.get(thisNode.childNodes[0]) || null
		}
		throw new Error('This is not a container');
	};
	get nextSibling(): PreactElement | null {
		const p = this.node.parentNode
		if (p) {
			const index = p.childNodes.indexOf(this.node)
			if (index >= 0) {
				return domNode2PreactElement.get(p.childNodes[index + 1]) || null
			}
		}
		return null
	}
	get parentNode(): PreactElement {
		return domNode2PreactElement.get(this.node.parentNode!)!
	}
	nodeType: number;

	static scheduleOutput = () => {
	}
	static root: DOMRootElement
}


export type RenderOptions = {
	/**
	 * Output stream where app will be rendered.
	 *
	 * @default process.stdout
	 */
	stdout?: NodeJS.WriteStream;
	/**
	 * Input stream where app will listen for input.
	 *
	 * @default process.stdin
	 */
	stdin?: NodeJS.ReadStream;
	/**
	 * Error stream.
	 * @default process.stderr
	 */
	stderr?: NodeJS.WriteStream;
	/**
	 * If true, each update will be rendered as a separate output, without replacing the previous one.
	 *
	 * @default false
	 */
	debug?: boolean;
	/**
	 * Configure whether Ink should listen to Ctrl+C keyboard input and exit the app. This is needed in case `process.stdin` is in raw mode, because then Ctrl+C is ignored by default and process is expected to handle it manually.
	 *
	 * @default true
	 */
	exitOnCtrlC?: boolean;
	/**
	 * If true, Ink will use the alternative screen buffer to render the app.
	 * @default false
	 */
	alternativeScreen?: boolean

	/**
	 * Patch console methods to ensure console output doesn't mix with Ink output.
	 *
	 * @default true
	 */
	patchConsole?: boolean;
};

export type Instance = {
	/**
	 * Replace previous root node with a new one or update props of the current root node.
	 */
	rerender: Ink['render'];
	/**
	 * Manually unmount the whole Ink app.
	 */
	unmount: Ink['unmount'];
	/**
	 * Returns a promise, which resolves when app is unmounted.
	 */
	waitUntilExit: Ink['waitUntilExit'];
	cleanup: () => void;

	/**
	 * Clear output.
	 */
	clear: () => void;
};

export function render(node: VNode,

	options?: NodeJS.WriteStream | RenderOptions,
) {

	const inkOptions: InkOptions = {
		stdout: process.stdout,
		stdin: process.stdin,
		stderr: process.stderr,
		debug: false,
		exitOnCtrlC: true,
		patchConsole: true,
		alternativeScreen: false,
		...getOptions(options),
	};

	const instance: Ink = getInstance(
		inkOptions.stdout,
		() => new Ink(inkOptions),
	);

	let flush: NodeJS.Timeout | null;
	PreactElement.scheduleOutput = () => {
		if (flush == null) {
			flush = setTimeout(() => {
				//console.log("")
				instance.calculateLayout()
				instance.onRender()
				flush = null
			})
		}
	}
	PreactElement.root = instance.rootNode

	prender(
		instance.render(node),
		new PreactElement(instance.rootNode)
	)
	PreactElement.scheduleOutput()

	return {
		rerender: instance.render,
		unmount() {
			instance.unmount();
		},
		waitUntilExit: instance.waitUntilExit,
		cleanup: () => instances.delete(inkOptions.stdout),
		clear: instance.clear,
	};

}

const getOptions = (
	stdout: NodeJS.WriteStream | RenderOptions | undefined = {},
): RenderOptions => {
	if (stdout instanceof Stream) {
		return {
			stdout,
			stdin: process.stdin,
		};
	}

	return stdout;
};
const getInstance = (
	stdout: NodeJS.WriteStream,
	createInstance: () => Ink,
): Ink => {
	let instance = instances.get(stdout);

	if (!instance) {
		instance = createInstance();
		instances.set(stdout, instance);
	}

	return instance;
};
