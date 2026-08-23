<script lang="ts">
	import {
		CarThingEngine,
		type Color,
		type EngineHandlers,
		type FlashOptions,
		type FlashTarget,
		type PanOptions,
		type PartId,
		type ScreenDrawFn,
		type ScreenPoint,
		type ScreenRect,
		type SpinOptions,
		type ViewName,
		type ViewSpec
	} from './carthing-engine';

	interface Props {
		interactive?: boolean;
		defaultUi?: boolean;
		onready?: (engine: CarThingEngine) => void;
		onpress?: (part: PartId) => void;
		ontap?: (part: PartId) => void;
		onhover?: (part: PartId | null) => void;
		onscreentap?: (p: ScreenPoint) => void;
		ondial?: (detents: number) => void;
	}

	let {
		interactive = true,
		defaultUi = true,
		onready,
		onpress,
		ontap,
		onhover,
		onscreentap,
		ondial
	}: Props = $props();
	let canvas: HTMLCanvasElement;
	let engine: CarThingEngine | undefined;

	export function flash(target: FlashTarget, color: Color, opts?: FlashOptions): void {
		engine?.flash(target, color, opts);
	}
	export function stopFlash(target: FlashTarget): void {
		engine?.stopFlash(target);
	}
	export function panTo(view: ViewName | ViewSpec, opts?: PanOptions): void {
		engine?.panTo(view, opts);
	}
	export function setView(yaw: number, pitch: number, dist?: number): void {
		engine?.setView(yaw, pitch, dist);
	}
	export function spinDial(direction?: 'cw' | 'ccw', opts?: SpinOptions): void {
		engine?.spinDial(direction, opts);
	}
	export function stopSpin(): void {
		engine?.stopSpin();
	}
	export function screen():
		{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; lcd: ScreenRect } | undefined {
		return engine?.screen();
	}
	export function updateScreen(): void {
		engine?.updateScreen();
	}
	export function setScreenDraw(fn: ScreenDrawFn): void {
		engine?.setScreenDraw(fn);
	}
	export function setScreenImage(src: string): Promise<void> | undefined {
		return engine?.setScreenImage(src);
	}
	export function setDefaultUi(on: boolean): void {
		engine?.setDefaultUi(on);
	}
	export function press(part: PartId, holdMs?: number): void {
		engine?.press(part, holdMs);
	}
	export function getEngine(): CarThingEngine | undefined {
		return engine;
	}

	$effect(() => {
		try {
			engine = new CarThingEngine(canvas, { interactive, defaultUi });
		} catch {
			engine = undefined;
			return;
		}
		onready?.(engine);
		return () => engine?.destroy();
	});

	// Kept out of the construction effect so swapping a handler does not tear
	// down the GL context and rebuild every mesh.
	$effect(() => {
		const h: EngineHandlers = { onpress, ontap, onhover, onscreentap, ondial };
		if (engine) engine.handlers = h;
	});
</script>

<canvas bind:this={canvas} aria-hidden="true"></canvas>

<style>
	canvas {
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
		cursor: grab;
	}
	canvas:active {
		cursor: grabbing;
	}
</style>
