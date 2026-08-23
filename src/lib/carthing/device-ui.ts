import type { PartId, ScreenPoint, ScreenRect } from './carthing-engine';

/** A toy of the stock Car Thing UI, driven by the same physical controls as the
 * real thing: four presets, a settings key, a back button and the rotary dial.
 *
 * Hit regions are recorded while drawing rather than declared separately, so a
 * moved control can never quietly stop being tappable. Everything is laid out
 * in an 800x480 design space to match the real panel; `draw` maps that onto
 * whatever ScreenRect the engine hands over.
 */

const DESIGN_W = 800;
const DESIGN_H = 480;

const FONT = "'Comic Sans MS', 'Comic Neue', cursive";
const GREEN = '#1ed760';
const WHITE = '#ffffff';
const DIM = 'rgba(255, 255, 255, 0.55)';
const FAINT = 'rgba(255, 255, 255, 0.14)';

export type Mode = 'home' | 'nowplaying' | 'settings';

interface Tile {
	label: string;
	artist: string;
	top: string;
	bottom: string;
	duration: number;
}

interface Region {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

const TILES: Tile[] = [
	{ label: 'Discover Weekly', artist: 'Spotify', top: '#3b4d5c', bottom: '#131b22', duration: 214 },
	{ label: 'Release Radar', artist: 'Spotify', top: '#4d3b58', bottom: '#1a1220', duration: 187 },
	{ label: 'Daily Mix 1', artist: 'Kavinsky', top: '#39503f', bottom: '#101a13', duration: 258 },
	{ label: 'Night Drive', artist: 'Chromatics', top: '#5c3b3b', bottom: '#1f1010', duration: 301 },
	{ label: 'Liked Songs', artist: 'You', top: '#3b425c', bottom: '#111420', duration: 176 },
	{ label: 'Terbium FM', artist: 'lmore377', top: '#34d399', bottom: '#0c3a2c', duration: 233 }
];

const SETTINGS_ROWS = ['Brightness', 'Volume', 'Comic Sans', 'About'] as const;

export class DeviceUi {
	mode: Mode = 'home';
	sel = 0;
	playing = false;
	progress = 0;
	volume = 0.65;
	brightness = 0.8;
	comicSans = true;
	settingsSel = 0;
	/** Animated strip offset, in tile indices, chasing `sel`. */
	private _scroll = 0;
	private _toast: { text: string; until: number } | null = null;
	private _regions: Region[] = [];
	private _dirty = true;

	get track(): Tile {
		return TILES[this.sel];
	}

	/** Something changed that the caller has not painted yet. */
	get dirty(): boolean {
		return this._dirty;
	}

	private _touch(): void {
		this._dirty = true;
	}

	private _toastNow(text: string): void {
		this._toast = { text, until: performance.now() + 1400 };
		this._touch();
	}

	/** Advance time-based state. Returns whether anything needs repainting. */
	tick(dt: number): boolean {
		if (this.playing) {
			this.progress += dt;
			if (this.progress >= this.track.duration) this.progress = 0;
			this._touch();
		}
		const target = this.sel;
		if (Math.abs(this._scroll - target) > 0.001) {
			this._scroll += (target - this._scroll) * Math.min(1, dt * 9);
			this._touch();
		} else if (this._scroll !== target) {
			this._scroll = target;
			this._touch();
		}
		if (this._toast && performance.now() > this._toast.until) {
			this._toast = null;
			this._touch();
		}
		return this._dirty;
	}

	/** A physical button. Returns true if the press did something. */
	key(part: PartId): boolean {
		const preset = ['preset1', 'preset2', 'preset3', 'preset4'].indexOf(part);
		if (preset >= 0) {
			this.sel = preset;
			this.progress = 0;
			this.playing = true;
			this.mode = 'nowplaying';
			this._toastNow(`Preset ${preset + 1}`);
			return true;
		}
		if (part === 'settings') {
			this.mode = this.mode === 'settings' ? 'home' : 'settings';
			this._touch();
			return true;
		}
		if (part === 'back') {
			this.mode = 'home';
			this._touch();
			return true;
		}
		if (part === 'dial') {
			if (this.mode === 'home') {
				this.mode = 'nowplaying';
				this.playing = true;
				this.progress = 0;
			} else if (this.mode === 'settings') {
				if (SETTINGS_ROWS[this.settingsSel] === 'Comic Sans') this.comicSans = !this.comicSans;
			} else {
				this.playing = !this.playing;
			}
			this._touch();
			return true;
		}
		return false;
	}

	/** Rotary dial, in encoder clicks. Sign follows the twist direction. */
	dial(detents: number): void {
		if (this.mode === 'home') {
			this.sel = Math.max(0, Math.min(TILES.length - 1, this.sel + detents));
		} else if (this.mode === 'nowplaying') {
			this.volume = Math.max(0, Math.min(1, this.volume + detents * 0.05));
		} else {
			const row = SETTINGS_ROWS[this.settingsSel];
			if (row === 'Brightness')
				this.brightness = Math.max(0.1, Math.min(1, this.brightness + detents * 0.05));
			else if (row === 'Volume')
				this.volume = Math.max(0, Math.min(1, this.volume + detents * 0.05));
			else
				this.settingsSel = Math.max(
					0,
					Math.min(SETTINGS_ROWS.length - 1, this.settingsSel + detents)
				);
		}
		this._touch();
	}

	/** A tap on the LCD, in UI-canvas coordinates. */
	tap(p: ScreenPoint): boolean {
		const hit = this._regions.find(
			(r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
		);
		if (!hit) return false;
		if (hit.id.startsWith('tile:')) {
			const i = Number(hit.id.slice(5));
			if (i === this.sel) {
				this.mode = 'nowplaying';
				this.playing = true;
				this.progress = 0;
			} else {
				this.sel = i;
			}
		} else if (hit.id === 'play') {
			this.playing = !this.playing;
		} else if (hit.id === 'next') {
			this.sel = (this.sel + 1) % TILES.length;
			this.progress = 0;
		} else if (hit.id === 'prev') {
			if (this.progress > 3) this.progress = 0;
			else {
				this.sel = (this.sel + TILES.length - 1) % TILES.length;
				this.progress = 0;
			}
		} else if (hit.id === 'back') {
			this.mode = 'home';
		} else if (hit.id.startsWith('row:')) {
			this.settingsSel = Number(hit.id.slice(4));
			if (SETTINGS_ROWS[this.settingsSel] === 'Comic Sans') this.comicSans = !this.comicSans;
		} else if (hit.id.startsWith('seek:')) {
			const [, x, w] = hit.id.split(':').map(Number);
			this.progress = Math.max(0, Math.min(1, (p.x - x) / w)) * this.track.duration;
		}
		this._touch();
		return true;
	}

	draw(ctx: CanvasRenderingContext2D, lcd: ScreenRect): void {
		this._regions = [];
		this._dirty = false;
		const s = lcd.w / DESIGN_W;
		const oy = lcd.y + (lcd.h - DESIGN_H * s) / 2;
		const X = (dx: number) => lcd.x + dx * s;
		const Y = (dy: number) => oy + dy * s;
		const font = (size: number, weight = 700) =>
			`${weight} ${Math.round(size * s)}px ${this.comicSans ? FONT : 'system-ui, sans-serif'}`;
		const region = (id: string, dx: number, dy: number, dw: number, dh: number) =>
			this._regions.push({ id, x: X(dx), y: Y(dy), w: dw * s, h: dh * s });

		ctx.fillStyle = '#000';
		ctx.fillRect(lcd.x, lcd.y, lcd.w, lcd.h);
		ctx.textAlign = 'left';
		ctx.textBaseline = 'alphabetic';

		if (this.mode === 'home') this._drawHome(ctx, s, X, Y, font, region);
		else if (this.mode === 'nowplaying') this._drawNowPlaying(ctx, s, X, Y, font, region);
		else this._drawSettings(ctx, s, X, Y, font, region);

		if (this._toast) {
			const text = this._toast.text;
			ctx.font = font(24, 700);
			const w = ctx.measureText(text).width + 40 * s;
			const h = 44 * s;
			const x = X(DESIGN_W / 2) - w / 2;
			ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
			ctx.beginPath();
			ctx.roundRect(x, Y(14), w, h, h / 2);
			ctx.fill();
			ctx.strokeStyle = 'rgba(52, 211, 153, 0.5)';
			ctx.lineWidth = 2 * s;
			ctx.stroke();
			ctx.fillStyle = '#34d399';
			ctx.textAlign = 'center';
			ctx.fillText(text, X(DESIGN_W / 2), Y(14) + h * 0.68);
			ctx.textAlign = 'left';
		}

		// Screen dimming is the one setting with a visible effect, so it is worth
		// having: everything above is painted, then veiled.
		if (this.brightness < 1) {
			ctx.fillStyle = `rgba(0, 0, 0, ${(1 - this.brightness) * 0.7})`;
			ctx.fillRect(lcd.x, lcd.y, lcd.w, lcd.h);
		}
	}

	private _drawHome(
		ctx: CanvasRenderingContext2D,
		s: number,
		X: (n: number) => number,
		Y: (n: number) => number,
		font: (size: number, weight?: number) => string,
		region: (id: string, dx: number, dy: number, dw: number, dh: number) => void
	): void {
		ctx.font = font(30);
		const tabs = ['Music', 'Podcasts', 'Your Library'];
		let tx = 44;
		tabs.forEach((label, i) => {
			ctx.fillStyle = i === 0 ? WHITE : DIM;
			ctx.fillText(label, X(tx), Y(62));
			if (i === 0) {
				const w = ctx.measureText(label).width;
				ctx.fillStyle = GREEN;
				ctx.fillRect(X(tx), Y(72), w, 4 * s);
			}
			tx += ctx.measureText(label).width / s + 44;
		});

		const tile = 220;
		const gap = 28;
		const ty = 120;
		const first = X(52) - this._scroll * (tile + gap) * s;
		TILES.forEach((entry, i) => {
			const x = first + i * (tile + gap) * s;
			if (x > X(DESIGN_W) || x + tile * s < X(0)) return;
			const active = i === this.sel;
			region(`tile:${i}`, (x - X(0)) / s, ty, tile, tile + 60);
			const g = ctx.createLinearGradient(x, Y(ty), x, Y(ty + tile));
			g.addColorStop(0, entry.top);
			g.addColorStop(1, entry.bottom);
			ctx.globalAlpha = active ? 1 : 0.72;
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.roundRect(x, Y(ty), tile * s, tile * s, 10 * s);
			ctx.fill();
			ctx.fillStyle = FAINT;
			ctx.beginPath();
			ctx.arc(x + (tile * s) / 2, Y(ty + tile / 2), tile * s * 0.22, 0, Math.PI * 2);
			ctx.fill();
			if (active) {
				ctx.strokeStyle = WHITE;
				ctx.lineWidth = 4 * s;
				ctx.beginPath();
				ctx.roundRect(x - 8 * s, Y(ty) - 8 * s, tile * s + 16 * s, tile * s + 16 * s, 14 * s);
				ctx.stroke();
			}
			ctx.font = font(26);
			ctx.fillStyle = active ? WHITE : DIM;
			ctx.fillText(entry.label, x, Y(ty + tile + 42), tile * s);
			ctx.globalAlpha = 1;
		});

		ctx.font = font(20, 400);
		ctx.fillStyle = DIM;
		ctx.fillText('turn the dial to browse  ·  press it to play', X(52), Y(452));
	}

	private _drawNowPlaying(
		ctx: CanvasRenderingContext2D,
		s: number,
		X: (n: number) => number,
		Y: (n: number) => number,
		font: (size: number, weight?: number) => string,
		region: (id: string, dx: number, dy: number, dw: number, dh: number) => void
	): void {
		const t = this.track;
		const art = 232;
		const ax = 52;
		const ay = 92;
		const g = ctx.createLinearGradient(X(ax), Y(ay), X(ax), Y(ay + art));
		g.addColorStop(0, t.top);
		g.addColorStop(1, t.bottom);
		ctx.save();
		ctx.beginPath();
		ctx.roundRect(X(ax), Y(ay), art * s, art * s, 10 * s);
		ctx.clip();
		ctx.fillStyle = g;
		ctx.fillRect(X(ax), Y(ay), art * s, art * s);
		ctx.fillStyle = 'rgba(255,255,255,0.10)';
		ctx.beginPath();
		ctx.arc(X(ax + art / 2), Y(ay + art * 0.5), art * s * 0.26, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();

		const cx = ax + art + 40;
		ctx.fillStyle = GREEN;
		ctx.font = font(19, 700);
		ctx.fillText(this.playing ? 'Now playing' : 'Paused', X(cx), Y(132));
		ctx.fillStyle = WHITE;
		ctx.font = font(42);
		ctx.fillText(t.label, X(cx), Y(186), (DESIGN_W - cx - 52) * s);
		ctx.fillStyle = DIM;
		ctx.font = font(24, 400);
		ctx.fillText(t.artist, X(cx), Y(224));

		const barX = ax;
		const barW = DESIGN_W - ax * 2;
		const barY = 352;
		region(`seek:${X(barX)}:${barW * s}`, barX, barY - 14, barW, 34);
		ctx.strokeStyle = 'rgba(255,255,255,0.22)';
		ctx.lineWidth = 4 * s;
		ctx.lineCap = 'round';
		ctx.beginPath();
		ctx.moveTo(X(barX), Y(barY));
		ctx.lineTo(X(barX + barW), Y(barY));
		ctx.stroke();
		const frac = Math.min(1, this.progress / t.duration);
		ctx.strokeStyle = WHITE;
		ctx.beginPath();
		ctx.moveTo(X(barX), Y(barY));
		ctx.lineTo(X(barX + barW * frac), Y(barY));
		ctx.stroke();
		ctx.fillStyle = WHITE;
		ctx.beginPath();
		ctx.arc(X(barX + barW * frac), Y(barY), 7 * s, 0, Math.PI * 2);
		ctx.fill();

		ctx.font = font(18, 400);
		ctx.fillStyle = DIM;
		ctx.fillText(clock(this.progress), X(barX), Y(barY + 30));
		ctx.textAlign = 'right';
		ctx.fillText(clock(t.duration), X(barX + barW), Y(barY + 30));
		ctx.textAlign = 'left';

		const rowY = 424;
		const mid = DESIGN_W / 2;
		region('prev', mid - 150, rowY - 30, 60, 60);
		region('play', mid - 34, rowY - 34, 68, 68);
		region('next', mid + 90, rowY - 30, 60, 60);
		region('back', 40, rowY - 30, 60, 60);

		ctx.fillStyle = WHITE;
		// prev
		ctx.fillRect(X(mid - 148), Y(rowY - 14), 4 * s, 28 * s);
		tri(ctx, X(mid - 108), Y(rowY), -26 * s, 15 * s);
		// play / pause
		ctx.beginPath();
		ctx.arc(X(mid), Y(rowY), 30 * s, 0, Math.PI * 2);
		ctx.fillStyle = WHITE;
		ctx.fill();
		ctx.fillStyle = '#000';
		if (this.playing) {
			ctx.fillRect(X(mid) - 11 * s, Y(rowY) - 14 * s, 7 * s, 28 * s);
			ctx.fillRect(X(mid) + 4 * s, Y(rowY) - 14 * s, 7 * s, 28 * s);
		} else {
			tri(ctx, X(mid) - 9 * s, Y(rowY), 24 * s, 14 * s);
		}
		ctx.fillStyle = WHITE;
		// next
		tri(ctx, X(mid + 96), Y(rowY), 26 * s, 15 * s);
		ctx.fillRect(X(mid + 144), Y(rowY - 14), 4 * s, 28 * s);
		// back chevron
		ctx.strokeStyle = DIM;
		ctx.lineWidth = 4 * s;
		ctx.beginPath();
		ctx.moveTo(X(78), Y(rowY - 12));
		ctx.lineTo(X(58), Y(rowY));
		ctx.lineTo(X(78), Y(rowY + 12));
		ctx.stroke();

		// volume, on the right, where the dial lives on the real hardware
		const vW = 120;
		const vX = DESIGN_W - vW - 52;
		ctx.fillStyle = 'rgba(255,255,255,0.18)';
		ctx.beginPath();
		ctx.roundRect(X(vX), Y(rowY - 4), vW * s, 8 * s, 4 * s);
		ctx.fill();
		ctx.fillStyle = GREEN;
		ctx.beginPath();
		ctx.roundRect(X(vX), Y(rowY - 4), vW * s * this.volume, 8 * s, 4 * s);
		ctx.fill();
		ctx.font = font(16, 400);
		ctx.fillStyle = DIM;
		ctx.fillText(`vol ${Math.round(this.volume * 100)}`, X(vX), Y(rowY - 18));
	}

	private _drawSettings(
		ctx: CanvasRenderingContext2D,
		s: number,
		X: (n: number) => number,
		Y: (n: number) => number,
		font: (size: number, weight?: number) => string,
		region: (id: string, dx: number, dy: number, dw: number, dh: number) => void
	): void {
		ctx.fillStyle = WHITE;
		ctx.font = font(34);
		ctx.fillText('Settings', X(52), Y(72));

		const rowH = 72;
		SETTINGS_ROWS.forEach((label, i) => {
			const y = 110 + i * rowH;
			const active = i === this.settingsSel;
			region(`row:${i}`, 40, y, DESIGN_W - 80, rowH - 8);
			if (active) {
				ctx.fillStyle = 'rgba(52, 211, 153, 0.12)';
				ctx.beginPath();
				ctx.roundRect(X(40), Y(y), (DESIGN_W - 80) * s, (rowH - 8) * s, 12 * s);
				ctx.fill();
			}
			ctx.fillStyle = active ? WHITE : DIM;
			ctx.font = font(26, active ? 700 : 400);
			ctx.fillText(label, X(64), Y(y + 42));

			ctx.textAlign = 'right';
			if (label === 'Brightness' || label === 'Volume') {
				const value = label === 'Brightness' ? this.brightness : this.volume;
				const bw = 180;
				const bx = DESIGN_W - 64 - bw;
				ctx.fillStyle = 'rgba(255,255,255,0.18)';
				ctx.beginPath();
				ctx.roundRect(X(bx), Y(y + 28), bw * s, 8 * s, 4 * s);
				ctx.fill();
				ctx.fillStyle = active ? GREEN : DIM;
				ctx.beginPath();
				ctx.roundRect(X(bx), Y(y + 28), bw * s * value, 8 * s, 4 * s);
				ctx.fill();
			} else if (label === 'Comic Sans') {
				ctx.fillStyle = this.comicSans ? GREEN : DIM;
				ctx.font = font(24, 700);
				ctx.fillText(this.comicSans ? 'ON' : 'off', X(DESIGN_W - 64), Y(y + 42));
			} else {
				ctx.fillStyle = DIM;
				ctx.font = font(20, 400);
				ctx.fillText('terbium test build', X(DESIGN_W - 64), Y(y + 42));
			}
			ctx.textAlign = 'left';
		});

		ctx.font = font(20, 400);
		ctx.fillStyle = DIM;
		ctx.fillText('dial adjusts  ·  back returns home', X(52), Y(452));
	}
}

function clock(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Filled triangle pointing along +x when `w` is positive. */
function tri(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
	ctx.beginPath();
	ctx.moveTo(x, y - h);
	ctx.lineTo(x + w, y);
	ctx.lineTo(x, y + h);
	ctx.closePath();
	ctx.fill();
}
