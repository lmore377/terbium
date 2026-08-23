<script lang="ts">
	import CarThing from '$lib/carthing/CarThing.svelte';
	import type { FlashTarget, PartId, ScreenPoint, ScreenRect } from '$lib/carthing/carthing-engine';
	import { DeviceUi } from '$lib/carthing/device-ui';
	import { flasher } from '$lib/flasher/state.svelte';
	import { wizard } from '$lib/wizard/wizard.svelte';
	import { formatBytes } from '$lib/format';

	const ACCENT = '#34d399';
	const SCREEN_BG = '#080a09';
	const SCREEN_TEXT = '#e9fef6';
	const SCREEN_MUTED = 'rgba(233, 254, 246, 0.55)';
	const SCREEN_TRACK = 'rgba(255, 255, 255, 0.12)';

	/** The toy UI only owns the screen on steps that are not reporting progress;
	 * everywhere else the flasher needs the panel for status. */
	const PLAYABLE_STEPS = ['welcome', 'done'];
	/** Repainting the LCD means re-uploading a 918x492 texture, so cap it well
	 * below the render loop's rate. */
	const UI_FPS = 30;

	let ct = $state<CarThing>();
	let ready = $state(false);
	let lastScreenDraw = 0;

	const ui = new DeviceUi();
	const playable = $derived(PLAYABLE_STEPS.includes(wizard.step));

	function paintUi(): void {
		ct?.setScreenDraw((ctx, lcd) => ui.draw(ctx, lcd));
	}

	/** Every part except the inert surfaces has an LED the engine can pulse. */
	function flashable(part: PartId): part is FlashTarget {
		return part !== 'screen' && part !== 'body' && part !== 'hump';
	}

	function onTap(part: PartId): void {
		if (!playable) return;
		if (ui.key(part)) {
			paintUi();
			if (part !== 'dial' && flashable(part)) {
				ct?.flash(part, ACCENT, { flashes: 1, duration: 260 });
			}
		}
	}

	function onDial(detents: number): void {
		if (!playable) return;
		ui.dial(detents);
		paintUi();
	}

	function onScreenTap(p: ScreenPoint): void {
		if (!playable) return;
		if (ui.tap(p)) paintUi();
	}

	function drawBlack(): void {
		ct?.setScreenDraw((ctx, lcd) => {
			ctx.fillStyle = '#000';
			ctx.fillRect(lcd.x, lcd.y, lcd.w, lcd.h);
		});
	}

	function drawStatus(title: string, subtitle: string, percent: number | null): void {
		ct?.setScreenDraw((ctx, lcd: ScreenRect) => {
			ctx.fillStyle = SCREEN_BG;
			ctx.fillRect(lcd.x, lcd.y, lcd.w, lcd.h);
			ctx.textAlign = 'center';
			const centerX = lcd.x + lcd.w / 2;

			if (percent !== null) {
				ctx.fillStyle = SCREEN_TEXT;
				ctx.font = `600 ${Math.round(lcd.h * 0.3)}px 'Comic Sans MS', 'Comic Neue', cursive`;
				ctx.textBaseline = 'alphabetic';
				ctx.fillText(`${Math.floor(percent)}%`, centerX, lcd.y + lcd.h * 0.44);
			} else {
				ctx.fillStyle = ACCENT;
				ctx.font = `600 ${Math.round(lcd.h * 0.16)}px 'Comic Sans MS', 'Comic Neue', cursive`;
				ctx.textBaseline = 'middle';
				ctx.fillText('terbium', centerX, lcd.y + lcd.h * 0.38);
			}

			ctx.fillStyle = SCREEN_MUTED;
			ctx.font = `500 ${Math.round(lcd.h * 0.085)}px 'Comic Sans MS', 'Comic Neue', cursive`;
			ctx.textBaseline = 'middle';
			ctx.fillText(title, centerX, lcd.y + lcd.h * 0.58);
			if (subtitle) {
				ctx.fillText(subtitle, centerX, lcd.y + lcd.h * 0.68);
			}

			const barWidth = lcd.w * 0.6;
			const barHeight = Math.max(4, Math.round(lcd.h * 0.02));
			const barX = lcd.x + (lcd.w - barWidth) / 2;
			const barY = lcd.y + lcd.h * 0.8;
			ctx.fillStyle = SCREEN_TRACK;
			ctx.beginPath();
			ctx.roundRect(barX, barY, barWidth, barHeight, barHeight / 2);
			ctx.fill();
			if (percent !== null && percent > 0) {
				ctx.fillStyle = ACCENT;
				ctx.beginPath();
				ctx.roundRect(barX, barY, barWidth * Math.min(1, percent / 100), barHeight, barHeight / 2);
				ctx.fill();
			}
		});
	}

	function drawThrottled(title: string, subtitle: string, percent: number | null): void {
		const now = performance.now();
		if (now - lastScreenDraw < 120) return;
		lastScreenDraw = now;
		drawStatus(title, subtitle, percent);
	}

	$effect(() => {
		const step = wizard.step;
		const model = ct;
		if (!model || !ready) return;

		if (step === 'welcome') {
			model.panTo('front');
			paintUi();
		} else if (step === 'prepare') {
			model.panTo('keys');
			model.flash('preset1', ACCENT, { infinite: true, duration: 1300 });
			model.flash('preset4', ACCENT, { infinite: true, duration: 1300 });
			drawBlack();
		} else if (step === 'connect') {
			if (flasher.connectStatus === 'waiting-fastboot') {
				model.stopFlash('usb');
				drawBlack();
			} else {
				model.panTo('usb');
				model.flash('usb', ACCENT, { infinite: true, duration: 1300 });
				drawBlack();
			}
		} else if (step === 'firmware') {
			model.panTo('front');
			drawBlack();
		} else if (step === 'flash') {
			model.panTo('front');
		} else if (step === 'done') {
			model.panTo('front');
			model.flash('dial', ACCENT, { flashes: 3 });
			paintUi();
		}

		return () => {
			if (step === 'prepare') {
				model.stopFlash('preset1');
				model.stopFlash('preset4');
			} else if (step === 'connect') {
				model.stopFlash('usb');
			}
		};
	});

	$effect(() => {
		if (!playable || !ready || !ct) return;
		let raf = 0;
		let last = performance.now();
		let lastPaint = 0;
		const loop = (t: number) => {
			raf = requestAnimationFrame(loop);
			const dt = Math.min((t - last) / 1000, 0.1);
			last = t;
			if (ui.tick(dt) && t - lastPaint > 1000 / UI_FPS) {
				lastPaint = t;
				paintUi();
			}
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	});

	$effect(() => {
		const phase = flasher.phase;
		const model = ct;
		if (!model || !ready || wizard.step !== 'flash') return;

		if (phase === 'downloading') {
			const progress = flasher.downloadProgress;
			if (!progress) {
				drawStatus('starting download', '', 0);
			} else if (progress.phase === 'verifying') {
				drawThrottled('verifying download', '', 100);
			} else {
				const percent =
					progress.totalBytes > 0 ? (progress.receivedBytes / progress.totalBytes) * 100 : 0;
				drawThrottled(
					'downloading',
					`${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`,
					percent
				);
			}
		} else if (phase === 'preparing') {
			drawStatus('unpacking archive', '', null);
		} else if (phase === 'flashing') {
			drawThrottled(
				`step ${flasher.stepIndex + 1} of ${flasher.totalSteps}`,
				flasher.stepLabel,
				flasher.overallPercent
			);
		} else if (phase === 'error') {
			drawStatus('flash failed', 'check the log', null);
		} else if (phase === 'connected') {
			drawBlack();
		}
	});
</script>

<CarThing
	bind:this={ct}
	defaultUi={false}
	onready={() => (ready = true)}
	ontap={onTap}
	ondial={onDial}
	onscreentap={onScreenTap}
/>
