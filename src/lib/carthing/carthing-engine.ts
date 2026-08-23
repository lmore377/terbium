export type FlashTarget =
	'preset1' | 'preset2' | 'preset3' | 'preset4' | 'settings' | 'back' | 'usb' | 'dial' | 'tag';

/** Anything the pointer can land on. `body` and `hump` are hit-tested purely so
 * they occlude the parts behind them; they are not interactive. */
export type PartId = FlashTarget | 'screen' | 'body' | 'hump';

export type ViewName = 'front' | 'screen' | 'back' | 'keys' | 'dial' | 'usb';

/** Point on the emulated LCD, in the coordinate space of the UI canvas that
 * `setScreenDraw` paints into (so it shares an origin with `ScreenRect`). */
export interface ScreenPoint {
	x: number;
	y: number;
}

export type RGB = [number, number, number];
export type Color = string | RGB;

export interface ViewSpec {
	yaw: number;
	pitch: number;
	dist?: number;
}

export interface FlashOptions {
	duration?: number;
	flashes?: number;
	infinite?: boolean;
}

export interface PanOptions {
	duration?: number;
}

export interface SpinOptions {
	turns?: number;
	duration?: number;
	infinite?: boolean;
	speed?: number;
}

export interface ScreenRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface EngineOptions {
	interactive?: boolean;
	defaultUi?: boolean;
	/** Hit-test the pointer against the model and drive press/hover state.
	 * Costs one extra offscreen pass per pointer move. Defaults to `interactive`. */
	pickable?: boolean;
}

export interface EngineHandlers {
	/** Fires on pointer-down over a pressable part, before any drag disambiguation. */
	onpress?: (part: PartId) => void;
	/** A press that was released without turning into a camera drag. */
	ontap?: (part: PartId) => void;
	onhover?: (part: PartId | null) => void;
	/** Tap on the LCD, in UI-canvas coordinates. */
	onscreentap?: (p: ScreenPoint) => void;
	/** Dial rotation. `detents` is the accumulated whole-click count since the
	 * last callback, sign-carrying; the real dial is a rotary encoder. */
	ondial?: (detents: number) => void;
}

/** How far each pressable part travels when pushed, in model units (mm). */
const PRESS_TRAVEL: Partial<Record<PartId, number>> = {
	preset1: 0.9,
	preset2: 0.9,
	preset3: 0.9,
	preset4: 0.9,
	settings: 0.9,
	back: 0.7,
	dial: 0.6
};

const PRESS_DOWN_MS = 70;
const PRESS_UP_MS = 130;
/** Radians of dial rotation per encoder detent. */
const DIAL_DETENT = Math.PI / 12;
/** Pointer travel that converts a press into a camera drag. */
const DRAG_SLOP = 6;

/** Parts small enough on screen to deserve a forgiving hit radius. Seen from
 * the default front view the keys are nearly edge-on -- a literal one-pixel
 * test makes them a ~4px tall target. */
const SLOPPY = new Set<PartId>([
	'preset1',
	'preset2',
	'preset3',
	'preset4',
	'settings',
	'back',
	'tag',
	'usb'
]);
/** Pick slop in framebuffer pixels. */
const PICK_SLOP = 5;

/** Parts that light up and switch the cursor under the pointer. */
const HOVERABLE = new Set<PartId>([
	'preset1',
	'preset2',
	'preset3',
	'preset4',
	'settings',
	'back',
	'dial',
	'screen',
	'usb',
	'tag'
]);

/** Pick-pass id byte per part. 0 is reserved for "nothing". */
const PICK_IDS: PartId[] = [
	'body',
	'hump',
	'screen',
	'preset1',
	'preset2',
	'preset3',
	'preset4',
	'settings',
	'back',
	'dial',
	'usb',
	'tag'
];

export type ScreenDrawFn = (ctx: CanvasRenderingContext2D, lcd: ScreenRect) => void;

type Pt = [number, number];

interface Mesh {
	posBuf: WebGLBuffer;
	nrmBuf: WebGLBuffer;
	count: number;
}

interface FlashState {
	color: RGB;
	t0: number;
	period: number;
	end: number;
}

interface CamState {
	yaw: number;
	pitch: number;
	dist: number;
}

interface CamTween {
	t0: number;
	duration: number;
	from: CamState;
	to: CamState;
}

type SpinState =
	| { infinite: true; speed: number }
	| { infinite?: false; t0: number; duration: number; from: number; to: number };

const BODY_W = 116.8,
	BODY_H = 63.5,
	BODY_D = 4.8;
const DIAL_R = 18,
	DIAL_X = 47.6,
	DIAL_Y = 9,
	DIAL_D = 9.5;
const GLASS_W = 114.8,
	GLASS_H = 61.5,
	GLASS_Z = BODY_D / 2 + 0.1;
const KEYS = { first: -46, last: 46, roll: 0.2, corner: 5, pd: 0.5, pr: 0.4, pw: 4.5 };
const BACK = { w: 45, h: 63.6, rise: 4, fadeLR: 4, slopeTB: 15, bow: 0, cy: 0 };
const BACK_PIN = 38;
const PZ_OUT = BODY_D / 2 - 0.13;
const PZ_IN = Math.min(2.2, PZ_OUT - 0.07);
const LCD: ScreenRect = { x: 43, y: 39, w: 691, h: 426 };
const UI_W = 918,
	UI_H = 492;

const VIEWS: Record<ViewName, Required<ViewSpec>> = {
	front: { yaw: -0.35, pitch: 0.15, dist: 230 },
	screen: { yaw: 0, pitch: 0, dist: 190 },
	back: { yaw: Math.PI - 0.25, pitch: 0.3, dist: 230 },
	keys: { yaw: 0.02, pitch: 1.2, dist: 180 },
	dial: { yaw: -0.6, pitch: 0.2, dist: 150 },
	usb: { yaw: Math.PI - 0.8, pitch: 0.25, dist: 150 }
};

const LIT_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
uniform mat4 uMVP;
uniform mat3 uNrm;
varying vec3 vN;
void main() {
  vN = uNrm * aNrm;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const LIT_FS = `
precision mediump float;
varying vec3 vN;
uniform vec3 uColor;
uniform float uGloss;
void main() {
  vec3 n = normalize(vN);
  vec3 key = normalize(vec3(0.45, 0.65, 0.62));
  vec3 fill = normalize(vec3(-0.6, -0.15, 0.45));
  float d = max(dot(n, key), 0.0) * 0.85 + max(dot(n, fill), 0.0) * 0.3;
  float hemi = 0.28 + 0.14 * (n.y * 0.5 + 0.5);
  vec3 h = normalize(key + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, h), 0.0), 48.0) * uGloss;
  vec3 c = uColor * (d + hemi) + vec3(spec);
  gl_FragColor = vec4(c, 1.0);
}`;

const TEX_VS = `
attribute vec3 aPos;
attribute vec2 aUV;
uniform mat4 uMVP;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const TEX_FS = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
void main() {
  gl_FragColor = texture2D(uTex, vUV);
}`;

const PICK_VS = `
attribute vec3 aPos;
uniform mat4 uMVP;
void main() {
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const PICK_FS = `
precision mediump float;
uniform float uId;
void main() {
  gl_FragColor = vec4(uId, 0.0, 0.0, 1.0);
}`;

function mat4Identity(): Float32Array {
	return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
function mat4Mul(a: Float32Array, b: Float32Array): Float32Array {
	const o = new Float32Array(16);
	for (let c = 0; c < 4; c++)
		for (let r = 0; r < 4; r++) {
			o[c * 4 + r] =
				a[r] * b[c * 4] +
				a[4 + r] * b[c * 4 + 1] +
				a[8 + r] * b[c * 4 + 2] +
				a[12 + r] * b[c * 4 + 3];
		}
	return o;
}
function mat4Perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
	const f = 1 / Math.tan(fov / 2);
	const o = new Float32Array(16);
	o[0] = f / aspect;
	o[5] = f;
	o[10] = (far + near) / (near - far);
	o[11] = -1;
	o[14] = (2 * far * near) / (near - far);
	return o;
}
function mat4Translate(x: number, y: number, z: number): Float32Array {
	const o = mat4Identity();
	o[12] = x;
	o[13] = y;
	o[14] = z;
	return o;
}
function mat4RotX(a: number): Float32Array {
	const c = Math.cos(a),
		s = Math.sin(a);
	return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}
function mat4RotY(a: number): Float32Array {
	const c = Math.cos(a),
		s = Math.sin(a);
	return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}
function mat4RotZ(a: number): Float32Array {
	const c = Math.cos(a),
		s = Math.sin(a);
	return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
function mat3FromMat4(m: Float32Array): Float32Array {
	return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
}

function roundedRectProfile(w: number, h: number, r: number, seg: number): Pt[] {
	const pts: Pt[] = [];
	r = Math.min(r, w / 2 - 0.01, h / 2 - 0.01);
	const cx = w / 2 - r,
		cy = h / 2 - r;
	const corners: Array<[number, number, number]> = [
		[cx, cy, 0],
		[-cx, cy, 90],
		[-cx, -cy, 180],
		[cx, -cy, 270]
	];
	for (const [x, y, start] of corners) {
		for (let i = 0; i <= seg; i++) {
			const a = ((start + (i / seg) * 90) * Math.PI) / 180;
			pts.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
		}
	}
	return pts;
}
function circleProfile(r: number, seg: number): Pt[] {
	const pts: Pt[] = [];
	for (let i = 0; i < seg; i++) {
		const a = (i / seg) * Math.PI * 2;
		pts.push([r * Math.cos(a), r * Math.sin(a)]);
	}
	return pts;
}
function bowedProfile(w: number, h: number, bow: number, seg: number): Pt[] {
	const pts: Pt[] = [];
	const hs = h / 2 - bow;
	pts.push([w / 2, -hs], [w / 2, hs]);
	for (let i = 1; i < seg; i++) {
		const x = w / 2 - (i / seg) * w;
		pts.push([x, h / 2 - bow * Math.pow((2 * x) / w, 2)]);
	}
	pts.push([-w / 2, hs], [-w / 2, -hs]);
	for (let i = 1; i < seg; i++) {
		const x = -w / 2 + (i / seg) * w;
		pts.push([x, -h / 2 + bow * Math.pow((2 * x) / w, 2)]);
	}
	return pts;
}
function fanCap(profile: Pt[], z: number, flip: boolean): number[] {
	const pos: number[] = [];
	let cx = 0,
		cy = 0;
	for (const p of profile) {
		cx += p[0];
		cy += p[1];
	}
	cx /= profile.length;
	cy /= profile.length;
	const n = profile.length;
	for (let i = 0; i < n; i++) {
		const a = profile[i],
			b = profile[(i + 1) % n];
		if (flip) pos.push(cx, cy, z, b[0], b[1], z, a[0], a[1], z);
		else pos.push(cx, cy, z, a[0], a[1], z, b[0], b[1], z);
	}
	return pos;
}
function ring(pFront: Pt[], zFront: number, pBack: Pt[], zBack: number): number[] {
	const pos: number[] = [];
	const n = pFront.length;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		const a = pFront[i],
			a2 = pFront[j],
			b = pBack[i],
			b2 = pBack[j];
		pos.push(b[0], b[1], zBack, b2[0], b2[1], zBack, a2[0], a2[1], zFront);
		pos.push(b[0], b[1], zBack, a2[0], a2[1], zFront, a[0], a[1], zFront);
	}
	return pos;
}
function roundedSolid(
	makeProfile: (inset: number) => Pt[],
	d: number,
	r: number,
	steps: number,
	extraZ?: number[]
): number[] {
	const rings: Array<[Pt[], number]> = [];
	for (let i = 0; i <= steps; i++) {
		const th = ((1 - i / steps) * Math.PI) / 2;
		rings.push([makeProfile(r * (1 - Math.cos(th))), d / 2 - r + r * Math.sin(th)]);
	}
	if (extraZ) for (const ez of extraZ) rings.push([makeProfile(0), ez]);
	rings.push([makeProfile(0), -(d / 2 - r)]);
	for (let i = 1; i <= steps; i++) {
		const th = ((i / steps) * Math.PI) / 2;
		rings.push([makeProfile(r * (1 - Math.cos(th))), -(d / 2 - r) - r * Math.sin(th)]);
	}
	let pos = fanCap(rings[0][0], d / 2, false);
	for (let i = 0; i < rings.length - 1; i++) {
		pos = pos.concat(ring(rings[i][0], rings[i][1], rings[i + 1][0], rings[i + 1][1]));
	}
	return pos.concat(fanCap(rings[rings.length - 1][0], -d / 2, true));
}
function extrude(profile: Pt[], depth: number): number[] {
	return fanCap(profile, depth / 2, false)
		.concat(ring(profile, depth / 2, profile, -depth / 2))
		.concat(fanCap(profile, -depth / 2, true));
}
function transform(
	pos: number[],
	fn: (x: number, y: number, z: number) => [number, number, number]
): number[] {
	for (let i = 0; i < pos.length; i += 3) {
		const [x, y, z] = fn(pos[i], pos[i + 1], pos[i + 2]);
		pos[i] = x;
		pos[i + 1] = y;
		pos[i + 2] = z;
	}
	return pos;
}
function flatNormals(pos: number[]): Float32Array {
	const nrm = new Float32Array(pos.length);
	for (let i = 0; i < pos.length; i += 9) {
		const ax = pos[i],
			ay = pos[i + 1],
			az = pos[i + 2];
		const bx = pos[i + 3],
			by = pos[i + 4],
			bz = pos[i + 5];
		const cx2 = pos[i + 6],
			cy2 = pos[i + 7],
			cz = pos[i + 8];
		const ux = bx - ax,
			uy = by - ay,
			uz = bz - az;
		const vx = cx2 - ax,
			vy = cy2 - ay,
			vz = cz - az;
		let nx = uy * vz - uz * vy,
			ny = uz * vx - ux * vz,
			nz = ux * vy - uy * vx;
		const len = Math.hypot(nx, ny, nz) || 1;
		nx /= len;
		ny /= len;
		nz /= len;
		for (let k = 0; k < 3; k++) {
			nrm[i + k * 3] = nx;
			nrm[i + k * 3 + 1] = ny;
			nrm[i + k * 3 + 2] = nz;
		}
	}
	return nrm;
}
function smoothNormals(pos: number[], limitDot: number): Float32Array {
	const flat = flatNormals(pos);
	const map = new Map<string, number[]>();
	for (let i = 0; i < pos.length; i += 3) {
		const k = pos[i].toFixed(2) + ',' + pos[i + 1].toFixed(2) + ',' + pos[i + 2].toFixed(2);
		let bucket = map.get(k);
		if (!bucket) {
			bucket = [];
			map.set(k, bucket);
		}
		bucket.push(i);
	}
	const out = new Float32Array(flat.length);
	for (const idxs of map.values()) {
		for (const i of idxs) {
			if (flat[i + 2] < -0.999) {
				out[i] = flat[i];
				out[i + 1] = flat[i + 1];
				out[i + 2] = flat[i + 2];
				continue;
			}
			let nx = 0,
				ny = 0,
				nz = 0;
			for (const j of idxs) {
				const d = flat[i] * flat[j] + flat[i + 1] * flat[j + 1] + flat[i + 2] * flat[j + 2];
				if (d > limitDot) {
					nx += flat[j];
					ny += flat[j + 1];
					nz += flat[j + 2];
				}
			}
			const l = Math.hypot(nx, ny, nz) || 1;
			out[i] = nx / l;
			out[i + 1] = ny / l;
			out[i + 2] = nz / l;
		}
	}
	return out;
}
function subdividedProfileMaker(
	makeProfile: (inset: number) => Pt[],
	maxLen: number | ((a: Pt, b: Pt) => number)
): (inset: number) => Pt[] {
	const base = makeProfile(0);
	const lenFor = typeof maxLen === 'function' ? maxLen : () => maxLen;
	const kArr = base.map((p, i) => {
		const q = base[(i + 1) % base.length];
		return Math.max(
			1,
			Math.min(320, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / lenFor(p, q)))
		);
	});
	return (inset: number) => {
		const raw = makeProfile(inset);
		const out: Pt[] = [];
		for (let j = 0; j < raw.length; j++) {
			const a = raw[j],
				b = raw[(j + 1) % raw.length];
			for (let m = 0; m < kArr[j]; m++) {
				out.push([a[0] + ((b[0] - a[0]) * m) / kArr[j], a[1] + ((b[1] - a[1]) * m) / kArr[j]]);
			}
		}
		return out;
	};
}
function pocketDeform(x: number, y: number, z: number): [number, number, number] {
	const floor = BODY_H / 2 - KEYS.pd;
	const d = Math.abs(x - KEYS.last);
	if (Math.abs(z) <= (PZ_IN + PZ_OUT) / 2 && y > floor && d < KEYS.pw + KEYS.pr) {
		const rise =
			d <= KEYS.pw ? 0 : KEYS.pd * (1 - Math.cos(((Math.PI / 2) * (d - KEYS.pw)) / KEYS.pr));
		y = Math.min(y, floor + rise);
	}
	return [x, y, z];
}
function humpMesh(
	W: number,
	H: number,
	R: number,
	rampX: number,
	rampY: number,
	rise: number
): number[] {
	const S = 12,
		NOTCH = 5.5;
	const xNotch = -W / 2 + rampX;
	function ringProfile(t: number): { prof: Pt[]; z: number } {
		const d01 = Math.sin((Math.PI * t) / 2);
		const ix = rampX * (1 - Math.pow(1 - d01, 3));
		const iy = rampY * t;
		const raw = bowedProfile(W - 2 * ix, H - 2 * iy, R, 16);
		const xFoot = -(W - 2 * ix) / 2;
		const out: Pt[] = [];
		for (let i = 0; i < raw.length; i++) {
			const p = raw[i],
				q = raw[(i + 1) % raw.length];
			out.push(p);
			const pWall = Math.abs(p[0] - xFoot) < 0.001,
				qWall = Math.abs(q[0] - xFoot) < 0.001;
			if (pWall && qWall && p[1] > q[1]) {
				if (p[1] > NOTCH && q[1] < NOTCH)
					out.push([xFoot, NOTCH], [Math.max(xFoot, xNotch), NOTCH]);
				if (p[1] > -NOTCH && q[1] < -NOTCH)
					out.push([Math.max(xFoot, xNotch), -NOTCH], [xFoot, -NOTCH]);
			}
		}
		return { prof: out, z: -(BODY_D / 2 - 0.1) - rise * d01 };
	}
	let pos: number[] = [];
	let prev: { prof: Pt[]; z: number } | null = null;
	for (let s = 0; s <= S; s++) {
		const cur = ringProfile(s / S);
		if (prev) pos = pos.concat(ring(prev.prof, prev.z, cur.prof, cur.z));
		prev = cur;
	}
	return pos.concat(fanCap(prev!.prof, prev!.z, true));
}
function backTopZ(): number {
	return -(BODY_D / 2 - 0.1) - BACK.rise;
}
function parseColor(c: Color): RGB {
	if (Array.isArray(c)) return c;
	let h = c.replace('#', '');
	if (h.length === 3)
		h = h
			.split('')
			.map((ch) => ch + ch)
			.join('');
	return [
		parseInt(h.slice(0, 2), 16) / 255,
		parseInt(h.slice(2, 4), 16) / 255,
		parseInt(h.slice(4, 6), 16) / 255
	];
}
function easeInOut(u: number): number {
	return u * u * (3 - 2 * u);
}

interface LitLocations {
	aPos: number;
	aNrm: number;
	uMVP: WebGLUniformLocation | null;
	uNrm: WebGLUniformLocation | null;
	uColor: WebGLUniformLocation | null;
	uGloss: WebGLUniformLocation | null;
}

interface TexLocations {
	aPos: number;
	aUV: number;
	uMVP: WebGLUniformLocation | null;
	uTex: WebGLUniformLocation | null;
}

interface PickLocations {
	aPos: number;
	uMVP: WebGLUniformLocation | null;
	uId: WebGLUniformLocation | null;
}

interface PressState {
	t0: number;
	releasedAt: number | null;
}

/** Rotate a vector about X. Matches mat4RotX's handedness. */
function rotXv(v: number[], a: number): number[] {
	const c = Math.cos(a),
		s = Math.sin(a);
	return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}
function rotYv(v: number[], a: number): number[] {
	const c = Math.cos(a),
		s = Math.sin(a);
	return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}

export class CarThingEngine {
	yaw: number;
	pitch: number;
	dist: number;

	private _canvas: HTMLCanvasElement;
	private _gl: WebGLRenderingContext;
	private _defaultUi: boolean;
	private _playing: boolean;
	private _flashes = new Map<FlashTarget, FlashState>();
	private _camTween: CamTween | null = null;
	private _spin: SpinState | null = null;
	private _dialAngle = 0;
	private _destroyed = false;
	private _listeners: Array<[EventTarget, string, EventListener]> = [];
	private _litProg: WebGLProgram;
	private _texProg: WebGLProgram;
	private _litLoc: LitLocations;
	private _texLoc: TexLocations;
	private _body: Mesh;
	private _dial: Mesh;
	private _dialDot: Mesh;
	private _backBtn: Mesh;
	private _edgeTab: Mesh;
	private _hump: Mesh;
	private _slot: Mesh;
	private _keys: Mesh[];
	private _mics: Mesh[];
	private _screenPosBuf: WebGLBuffer;
	private _screenUVBuf: WebGLBuffer;
	private _screenVerts: number;
	private _ui: HTMLCanvasElement;
	private _ctx: CanvasRenderingContext2D;
	private _track = { title: 'Nightcall', artist: 'Kavinsky', duration: 258 };
	private _progress = 74;
	private _tex: WebGLTexture;
	private _baseColors: Record<string, RGB>;
	private _velYaw = 0;
	private _velPitch = 0;
	private _dragging = false;
	private _prevT = 0;
	private _lastUiUpdate = 0;
	private _raf: number;

	/** Pointer interaction. */
	handlers: EngineHandlers = {};
	private _pickable: boolean;
	private _pickProg: WebGLProgram | null = null;
	private _pickLoc: PickLocations | null = null;
	private _pickFbo: WebGLFramebuffer | null = null;
	private _pickTex: WebGLTexture | null = null;
	private _pickDepth: WebGLRenderbuffer | null = null;
	private _pickW = 0;
	private _pickH = 0;
	private _press = new Map<PartId, PressState>();
	private _held: PartId | null = null;
	private _hover: PartId | null = null;
	/** Dial drag: accumulates raw radians so detents can be emitted as crossed.
	 * `turned` is unsigned travel, used to tell a twist from a click. */
	private _dialDrag: { angle: number; emitted: number; turned: number } | null = null;
	private _dialDetents = 0;
	private _pickCache: { x: number; y: number; t: number; part: PartId | null } | null = null;

	constructor(canvas: HTMLCanvasElement, opts: EngineOptions = {}) {
		const interactive = opts.interactive !== false;
		const gl = canvas.getContext('webgl', { antialias: true, alpha: true });
		if (!gl) throw new Error('WebGL unavailable');
		this._canvas = canvas;
		this._gl = gl;
		this._defaultUi = opts.defaultUi !== false;
		this._playing = this._defaultUi && !matchMedia('(prefers-reduced-motion: reduce)').matches;

		const compile = (type: number, src: string): WebGLShader => {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			return s;
		};
		const program = (vs: string, fs: string): WebGLProgram => {
			const p = gl.createProgram()!;
			gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
			gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
			gl.linkProgram(p);
			return p;
		};
		this._litProg = program(LIT_VS, LIT_FS);
		this._texProg = program(TEX_VS, TEX_FS);
		this._litLoc = {
			aPos: gl.getAttribLocation(this._litProg, 'aPos'),
			aNrm: gl.getAttribLocation(this._litProg, 'aNrm'),
			uMVP: gl.getUniformLocation(this._litProg, 'uMVP'),
			uNrm: gl.getUniformLocation(this._litProg, 'uNrm'),
			uColor: gl.getUniformLocation(this._litProg, 'uColor'),
			uGloss: gl.getUniformLocation(this._litProg, 'uGloss')
		};
		this._texLoc = {
			aPos: gl.getAttribLocation(this._texProg, 'aPos'),
			aUV: gl.getAttribLocation(this._texProg, 'aUV'),
			uMVP: gl.getUniformLocation(this._texProg, 'uMVP'),
			uTex: gl.getUniformLocation(this._texProg, 'uTex')
		};

		this._pickable = opts.pickable ?? interactive;
		if (this._pickable) {
			this._pickProg = program(PICK_VS, PICK_FS);
			this._pickLoc = {
				aPos: gl.getAttribLocation(this._pickProg, 'aPos'),
				uMVP: gl.getUniformLocation(this._pickProg, 'uMVP'),
				uId: gl.getUniformLocation(this._pickProg, 'uId')
			};
		}

		const uploadMesh = (pos: number[], nrm: Float32Array): Mesh => {
			const posBuf = gl.createBuffer()!;
			gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);
			const nrmBuf = gl.createBuffer()!;
			gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
			gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.STATIC_DRAW);
			return { posBuf, nrmBuf, count: pos.length / 3 };
		};
		const makeMesh = (pos: number[]): Mesh => uploadMesh(pos, flatNormals(pos));
		const makeMeshSmooth = (pos: number[], limitDot: number): Mesh =>
			uploadMesh(pos, smoothNormals(pos, limitDot));

		this._body = makeMesh(
			transform(
				roundedSolid(
					subdividedProfileMaker(
						(i) =>
							roundedRectProfile(
								BODY_W - 2 * i,
								BODY_H - 2 * i,
								Math.max(KEYS.corner - i, 0.5),
								10
							),
						(a, b) => (a[1] > 28 && b[1] > 28 ? 0.4 : 2)
					),
					BODY_D,
					KEYS.roll,
					4,
					[PZ_OUT, PZ_IN, -PZ_IN, -PZ_OUT]
				),
				(x, y, z) => pocketDeform(x, y, z)
			)
		);
		this._dial = makeMesh(roundedSolid((i) => circleProfile(DIAL_R - i, 96), DIAL_D, 3, 5));
		this._dialDot = makeMesh(extrude(circleProfile(1.5, 16), 0.3));
		this._backBtn = makeMesh(roundedSolid((i) => circleProfile(6 - i, 48), 4, 1.8, 4));
		this._edgeTab = makeMesh(
			transform(
				roundedSolid(
					(i) => roundedRectProfile(6.5 - 2 * i, 10.5 - 2 * i, Math.max(1 - i, 0.05), 6),
					2.4,
					0.6,
					3
				),
				(x, y, z) => [x - BODY_W / 2 + 0.2, y + 18, z]
			)
		);

		const wallX = BACK_PIN - BACK.w - BACK.fadeLR;
		const wallV = wallX + BACK.fadeLR;
		const wallZMid = (backTopZ() - (BODY_D / 2 - 0.1)) / 2;
		this._hump = makeMeshSmooth(
			transform(
				humpMesh(BACK.w + 2 * BACK.fadeLR, BACK.h, BACK.bow, BACK.fadeLR, BACK.slopeTB, BACK.rise),
				(x, y, z) => [x + BACK_PIN - BACK.w / 2, y + BACK.cy, z]
			),
			0.9
		);
		this._slot = makeMesh(
			transform(extrude(roundedRectProfile(7.4, 2.3, 1.15, 8), 0.3), (x, y, z) => [
				wallV - 0.1 - z,
				-x,
				y + wallZMid - 0.15
			])
		);

		const pitch = (KEYS.last - KEYS.first) / 4;
		this._keys = [];
		for (let k = 0; k < 4; k++) {
			this._keys.push(
				makeMesh(
					transform(
						roundedSolid(
							(i) => roundedRectProfile(11 - 2 * i, 2.6 - 2 * i, 1.2 - i, 4),
							1.8,
							0.6,
							3
						),
						(x, y, z) => [x + KEYS.first + k * pitch, z + BODY_H / 2, -y]
					)
				)
			);
		}
		this._keys.push(
			makeMesh(
				transform(
					roundedSolid((i) => roundedRectProfile(9 - 2 * i, 2.6 - 2 * i, 1.2 - i, 4), 2.6, 0.8, 3),
					(x, y, z) => [x + KEYS.last, z + BODY_H / 2 - 1.3, -y]
				)
			)
		);
		this._mics = [];
		for (let k = 0; k < 4; k++) {
			this._mics.push(
				makeMesh(
					transform(extrude(circleProfile(0.6, 10), 0.5), (x, y, z) => [
						x + KEYS.first + (k + 0.5) * pitch,
						z + BODY_H / 2 - 0.24,
						-y
					])
				)
			);
		}

		const glassProfile = roundedRectProfile(GLASS_W, GLASS_H, 3.5, 10);
		const screenPosArr: number[] = [],
			screenUVArr: number[] = [];
		for (let i = 0; i < glassProfile.length; i++) {
			const a = glassProfile[i],
				b = glassProfile[(i + 1) % glassProfile.length];
			for (const p of [[0, 0] as Pt, a, b]) {
				screenPosArr.push(p[0], p[1], GLASS_Z);
				screenUVArr.push(p[0] / GLASS_W + 0.5, p[1] / GLASS_H + 0.5);
			}
		}
		this._screenVerts = screenPosArr.length / 3;
		this._screenPosBuf = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this._screenPosBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(screenPosArr), gl.STATIC_DRAW);
		this._screenUVBuf = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this._screenUVBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(screenUVArr), gl.STATIC_DRAW);

		this._ui = document.createElement('canvas');
		this._ui.width = UI_W;
		this._ui.height = UI_H;
		this._ctx = this._ui.getContext('2d')!;
		this._tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, this._tex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		if (this._defaultUi) this._drawDefaultUi();
		else this._clearScreen();
		this.updateScreen();

		this._baseColors = {
			body: [0.082, 0.084, 0.088],
			hump: [0.082, 0.084, 0.088],
			slot: [0.015, 0.015, 0.017],
			tab: [0.075, 0.077, 0.081],
			key: [0.095, 0.098, 0.102],
			mic: [0.015, 0.015, 0.016],
			dial: [0.068, 0.07, 0.073],
			back: [0.075, 0.077, 0.08]
		};

		this.yaw = VIEWS.front.yaw;
		this.pitch = VIEWS.front.pitch;
		this.dist = VIEWS.front.dist;

		if (interactive) {
			let lastX = 0,
				lastY = 0,
				downX = 0,
				downY = 0;
			const on = <K extends keyof HTMLElementEventMap>(
				el: HTMLElement,
				ev: K,
				fn: (e: HTMLElementEventMap[K]) => void,
				opts2?: AddEventListenerOptions
			) => {
				el.addEventListener(ev, fn as EventListener, opts2);
				this._listeners.push([el, ev, fn as EventListener]);
			};
			on(canvas, 'pointerdown', (e) => {
				this._camTween = null;
				lastX = downX = e.clientX;
				lastY = downY = e.clientY;
				try {
					canvas.setPointerCapture(e.pointerId);
				} catch {
					// Capture is a nicety for drags that leave the canvas; never let
					// it stop the press itself from registering.
				}

				const hit = this._pick(e.clientX, e.clientY);
				// The dial takes the drag outright -- twisting it is the point, and
				// there is no sensible "orbit from the dial" gesture to preserve.
				if (hit === 'dial') {
					this._beginPress('dial');
					this._dialDrag = {
						angle: this._pointerDialAngle(e.clientX, e.clientY) ?? 0,
						emitted: 0,
						turned: 0
					};
					return;
				}
				if (hit && PRESS_TRAVEL[hit] !== undefined) {
					this._beginPress(hit);
					return;
				}
				// Screen and dead areas stay grabbable: a tap fires on release, but
				// moving past the slop threshold converts it into a camera orbit.
				this._held = hit;
				this._dragging = false;
			});
			on(canvas, 'pointermove', (e) => {
				if (this._dialDrag) {
					const a = this._pointerDialAngle(e.clientX, e.clientY);
					if (a !== null) {
						let d = a - this._dialDrag.angle;
						while (d > Math.PI) d -= Math.PI * 2;
						while (d < -Math.PI) d += Math.PI * 2;
						this._dialDrag.angle = a;
						this._dialDrag.turned += Math.abs(d);
						this._dialAngle += d;
						this._spin = null;
						this._emitDetents(d);
					}
					return;
				}

				const movedFar = Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_SLOP;
				if (e.buttons && !this._dragging && movedFar) {
					// Promote to an orbit and abandon whatever was being pressed.
					this._dragging = true;
					if (this._held) this._endPress(this._held);
					this._held = null;
				}

				if (this._dragging) {
					const dx = e.clientX - lastX,
						dy = e.clientY - lastY;
					this.yaw += dx * 0.008;
					this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + dy * 0.008));
					this._velYaw = dx * 0.008;
					this._velPitch = dy * 0.008;
				} else if (!e.buttons) {
					this._setHover(this._pick(e.clientX, e.clientY));
				}
				lastX = e.clientX;
				lastY = e.clientY;
			});
			on(canvas, 'pointerup', (e) => {
				const held = this._held;
				const dial = this._dialDrag;
				this._dialDrag = null;
				this._dragging = false;
				this._held = null;
				if (dial) {
					this._endPress('dial');
					// A twist is not a click. Straight-line distance is the wrong test
					// for a rotary control -- a full turn lands back on its start
					// point -- so gate on how far the dial actually rotated.
					if (dial.turned < DIAL_DETENT / 2) this.handlers.ontap?.('dial');
					return;
				}
				if (!held) return;
				this._endPress(held);
				if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_SLOP) return;
				this.handlers.ontap?.(held);
				if (held === 'screen') {
					const p = this._screenPoint(e.clientX, e.clientY);
					if (p) this.handlers.onscreentap?.(p);
				}
			});
			on(canvas, 'pointercancel', () => {
				if (this._held) this._endPress(this._held);
				this._held = null;
				this._dialDrag = null;
				this._dragging = false;
			});
			on(canvas, 'pointerleave', () => {
				this._setHover(null);
			});
			on(
				canvas,
				'wheel',
				(e) => {
					e.preventDefault();
					this._camTween = null;
					// Over the dial the wheel turns the dial instead of dollying --
					// it is the one control a scroll gesture maps onto naturally.
					if (this._pick(e.clientX, e.clientY) === 'dial') {
						const d = -e.deltaY * 0.0025;
						this._dialAngle += d;
						this._spin = null;
						this._emitDetents(d);
						return;
					}
					this.dist = Math.max(120, Math.min(500, this.dist + e.deltaY * 0.35));
				},
				{ passive: false }
			);
		}

		const frame = (t: number) => {
			if (this._destroyed) return;
			this._raf = requestAnimationFrame(frame);
			this._frame(t);
		};
		this._raf = requestAnimationFrame(frame);
	}

	flash(target: FlashTarget, color: Color, opts: FlashOptions = {}): void {
		const duration = opts.duration ?? 900;
		const flashes = opts.flashes ?? 2;
		const t0 = performance.now();
		this._flashes.set(target, {
			color: parseColor(color),
			t0,
			period: opts.infinite ? (opts.duration ?? 900) : duration / flashes,
			end: opts.infinite ? Infinity : t0 + duration
		});
	}

	stopFlash(target: FlashTarget): void {
		const f = this._flashes.get(target);
		if (!f) return;
		const now = performance.now();
		f.end = f.t0 + Math.ceil((now - f.t0) / f.period) * f.period;
	}

	panTo(view: ViewName | ViewSpec, opts: PanOptions = {}): void {
		const target = typeof view === 'string' ? VIEWS[view] : view;
		if (!target) throw new Error('unknown view: ' + String(view));
		let dYaw = (target.yaw - this.yaw) % (Math.PI * 2);
		if (dYaw > Math.PI) dYaw -= Math.PI * 2;
		if (dYaw < -Math.PI) dYaw += Math.PI * 2;
		this._camTween = {
			t0: performance.now(),
			duration: opts.duration ?? 850,
			from: { yaw: this.yaw, pitch: this.pitch, dist: this.dist },
			to: { yaw: this.yaw + dYaw, pitch: target.pitch, dist: target.dist ?? this.dist }
		};
	}

	setView(yaw: number, pitch: number, dist?: number): void {
		this._camTween = null;
		this.yaw = yaw;
		this.pitch = pitch;
		if (dist) this.dist = dist;
	}

	spinDial(direction: 'cw' | 'ccw' = 'cw', opts: SpinOptions = {}): void {
		const sign = direction === 'ccw' ? 1 : -1;
		const start = direction === 'ccw' ? -Math.PI / 2 : Math.PI / 2;
		this._dialAngle = start;
		if (opts.infinite) {
			this._spin = { infinite: true, speed: sign * (opts.speed ?? 0.55) * Math.PI * 2 };
			return;
		}
		const turns = opts.turns ?? 1;
		this._spin = {
			t0: performance.now(),
			duration: opts.duration ?? 1100 * turns,
			from: start,
			to: start + sign * turns * Math.PI * 2
		};
	}

	stopSpin(): void {
		this._spin = null;
	}

	screen(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; lcd: ScreenRect } {
		return { canvas: this._ui, ctx: this._ctx, lcd: { ...LCD } };
	}

	updateScreen(): void {
		const gl = this._gl;
		gl.bindTexture(gl.TEXTURE_2D, this._tex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._ui);
	}

	setScreenDraw(fn: ScreenDrawFn): void {
		this._defaultUi = false;
		this._clearScreen();
		fn(this._ctx, { ...LCD });
		this.updateScreen();
	}

	setScreenImage(src: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.crossOrigin = 'anonymous';
			img.onload = () => {
				this.setScreenDraw((ctx, lcd) => {
					const scale = Math.max(lcd.w / img.width, lcd.h / img.height);
					const w = img.width * scale,
						h = img.height * scale;
					ctx.save();
					ctx.beginPath();
					ctx.rect(lcd.x, lcd.y, lcd.w, lcd.h);
					ctx.clip();
					ctx.drawImage(img, lcd.x + (lcd.w - w) / 2, lcd.y + (lcd.h - h) / 2, w, h);
					ctx.restore();
				});
				resolve();
			};
			img.onerror = reject;
			img.src = src;
		});
	}

	setDefaultUi(on: boolean): void {
		this._defaultUi = on;
		this._playing = on;
		if (on) {
			this._drawDefaultUi();
			this.updateScreen();
		}
	}

	destroy(): void {
		this._destroyed = true;
		cancelAnimationFrame(this._raf);
		for (const [el, ev, fn] of this._listeners) el.removeEventListener(ev, fn);
		if (this._pickFbo) {
			this._gl.deleteFramebuffer(this._pickFbo);
			this._gl.deleteTexture(this._pickTex);
			this._gl.deleteRenderbuffer(this._pickDepth);
			this._pickFbo = null;
		}
		const ext = this._gl.getExtension('WEBGL_lose_context');
		if (ext) ext.loseContext();
	}

	/** Drive a press animation from code, e.g. to echo a physical button. */
	press(part: PartId, holdMs = 110): void {
		if (PRESS_TRAVEL[part] === undefined) return;
		this._beginPress(part);
		setTimeout(() => this._endPress(part), holdMs);
	}

	get hovered(): PartId | null {
		return this._hover;
	}

	private _beginPress(part: PartId): void {
		this._held = part;
		this._dragging = false;
		this._press.set(part, { t0: performance.now(), releasedAt: null });
		this.handlers.onpress?.(part);
	}

	private _endPress(part: PartId): void {
		const p = this._press.get(part);
		if (p && p.releasedAt === null) p.releasedAt = performance.now();
	}

	private _pressAmt(part: PartId, now: number): number {
		const p = this._press.get(part);
		if (!p) return 0;
		if (p.releasedAt === null) return Math.min(1, (now - p.t0) / PRESS_DOWN_MS);
		const peak = Math.min(1, (p.releasedAt - p.t0) / PRESS_DOWN_MS);
		const u = (now - p.releasedAt) / PRESS_UP_MS;
		if (u >= 1) {
			this._press.delete(part);
			return 0;
		}
		return peak * (1 - easeInOut(u));
	}

	private _setHover(part: PartId | null): void {
		const real = part && HOVERABLE.has(part) ? part : null;
		if (real === this._hover) return;
		this._hover = real;
		this._canvas.style.cursor = real ? 'pointer' : '';
		this.handlers.onhover?.(real);
	}

	private _emitDetents(deltaRadians: number): void {
		if (!this._dialDrag) {
			this._dialDetents += deltaRadians;
		} else {
			this._dialDrag.emitted += deltaRadians;
			this._dialDetents = this._dialDrag.emitted;
		}
		const whole = Math.trunc(this._dialDetents / DIAL_DETENT);
		if (!whole) return;
		this._dialDetents -= whole * DIAL_DETENT;
		if (this._dialDrag) this._dialDrag.emitted -= whole * DIAL_DETENT;
		this.handlers.ondial?.(whole);
	}

	/** Ray through the pointer, in model space. The view transform is a pure
	 * rotate-then-translate, so it inverts without a general matrix inverse. */
	private _rayModel(clientX: number, clientY: number): { o: number[]; d: number[] } | null {
		const r = this._canvas.getBoundingClientRect();
		if (!r.width || !r.height) return null;
		const ndcX = ((clientX - r.left) / r.width) * 2 - 1;
		const ndcY = 1 - ((clientY - r.top) / r.height) * 2;
		const tanF = Math.tan(0.5 / 2);
		const dView = [ndcX * tanF * (r.width / r.height), ndcY * tanF, -1];
		const untilt = (v: number[]) => rotYv(rotXv(v, -this.pitch), -this.yaw);
		return { o: untilt([0, 0, this.dist]), d: untilt(dView) };
	}

	/** Where the pointer ray crosses a model-space plane of constant z. */
	private _planeHit(clientX: number, clientY: number, z: number): number[] | null {
		const ray = this._rayModel(clientX, clientY);
		if (!ray || Math.abs(ray.d[2]) < 1e-6) return null;
		const t = (z - ray.o[2]) / ray.d[2];
		if (t <= 0) return null;
		return [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, z];
	}

	private _screenPoint(clientX: number, clientY: number): ScreenPoint | null {
		const p = this._planeHit(clientX, clientY, GLASS_Z);
		if (!p) return null;
		const u = p[0] / GLASS_W + 0.5;
		const v = p[1] / GLASS_H + 0.5;
		if (u < 0 || u > 1 || v < 0 || v > 1) return null;
		// The texture is uploaded flipped, so v runs bottom-up against the canvas.
		return { x: u * UI_W, y: (1 - v) * UI_H };
	}

	private _pointerDialAngle(clientX: number, clientY: number): number | null {
		const p = this._planeHit(clientX, clientY, BODY_D / 2 + DIAL_D - 1);
		if (!p) return null;
		return Math.atan2(p[1] - DIAL_Y, p[0] - DIAL_X);
	}

	private _ensurePickTargets(): boolean {
		const gl = this._gl;
		const w = this._canvas.width,
			h = this._canvas.height;
		if (!w || !h) return false;
		if (this._pickFbo && this._pickW === w && this._pickH === h) return true;
		if (this._pickFbo) {
			gl.deleteFramebuffer(this._pickFbo);
			gl.deleteTexture(this._pickTex);
			gl.deleteRenderbuffer(this._pickDepth);
		}
		this._pickTex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this._pickTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		this._pickDepth = gl.createRenderbuffer();
		gl.bindRenderbuffer(gl.RENDERBUFFER, this._pickDepth);
		gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
		this._pickFbo = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, this._pickFbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._pickTex, 0);
		gl.framebufferRenderbuffer(
			gl.FRAMEBUFFER,
			gl.DEPTH_ATTACHMENT,
			gl.RENDERBUFFER,
			this._pickDepth
		);
		const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		if (!ok) {
			this._pickFbo = null;
			return false;
		}
		this._pickW = w;
		this._pickH = h;
		return true;
	}

	/** Which part is under the pointer, by rendering ids to an offscreen buffer.
	 * Exact about occlusion, unlike testing analytic bounds part by part. */
	private _pick(clientX: number, clientY: number): PartId | null {
		if (!this._pickable || !this._pickProg) return null;
		const now = performance.now();
		if (
			this._pickCache &&
			now - this._pickCache.t < 16 &&
			Math.hypot(clientX - this._pickCache.x, clientY - this._pickCache.y) < 2
		) {
			return this._pickCache.part;
		}
		if (!this._ensurePickTargets()) return null;
		const gl = this._gl;
		const r = this._canvas.getBoundingClientRect();
		if (!r.width || !r.height) return null;
		const px = Math.round(((clientX - r.left) / r.width) * this._pickW);
		const py = Math.round((1 - (clientY - r.top) / r.height) * this._pickH);
		if (px < 0 || py < 0 || px >= this._pickW || py >= this._pickH) return null;

		gl.bindFramebuffer(gl.FRAMEBUFFER, this._pickFbo);
		gl.viewport(0, 0, this._pickW, this._pickH);
		gl.clearColor(0, 0, 0, 0);
		gl.enable(gl.DEPTH_TEST);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		const m = this._matrices();
		this._renderScene(m.base, m.baseNrm, m.rot, true);

		// Read a block rather than a texel: an exact hit wins outright, but if the
		// pointer merely grazes a small control, that control still gets the click.
		const slop = Math.max(1, Math.round((PICK_SLOP * this._pickW) / r.width));
		const x0 = Math.max(0, px - slop);
		const y0 = Math.max(0, py - slop);
		const bw = Math.min(this._pickW, px + slop + 1) - x0;
		const bh = Math.min(this._pickH, py + slop + 1) - y0;
		const block = new Uint8Array(bw * bh * 4);
		gl.readPixels(x0, y0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, block);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);

		const at = (bx: number, by: number): PartId | null => {
			const idx = block[(by * bw + bx) * 4] - 1;
			return idx >= 0 && idx < PICK_IDS.length ? PICK_IDS[idx] : null;
		};
		const cx = px - x0,
			cy = py - y0;
		let part = at(cx, cy);
		if (!part || !SLOPPY.has(part)) {
			let best: PartId | null = null;
			let bestD = Infinity;
			for (let by = 0; by < bh; by++) {
				for (let bx = 0; bx < bw; bx++) {
					const p = at(bx, by);
					if (!p || !SLOPPY.has(p)) continue;
					const d = (bx - cx) * (bx - cx) + (by - cy) * (by - cy);
					if (d < bestD) {
						bestD = d;
						best = p;
					}
				}
			}
			if (best) part = best;
		}
		this._pickCache = { x: clientX, y: clientY, t: now, part };
		return part;
	}

	private _matrices(): { base: Float32Array; baseNrm: Float32Array; rot: Float32Array } {
		const aspect = this._canvas.width / this._canvas.height;
		const proj = mat4Perspective(0.5, aspect, 10, 1200);
		const view = mat4Translate(0, 0, -this.dist);
		const rot = mat4Mul(mat4RotX(this.pitch), mat4RotY(this.yaw));
		return { base: mat4Mul(proj, mat4Mul(view, rot)), baseNrm: mat3FromMat4(rot), rot };
	}

	private _flashColor(target: FlashTarget, base: RGB): RGB {
		const f = this._flashes.get(target);
		if (!f) return base;
		const now = performance.now();
		if (now >= f.end) {
			this._flashes.delete(target);
			return base;
		}
		const k = Math.pow(Math.sin((Math.PI * (now - f.t0)) / f.period), 2);
		return [
			base[0] + (f.color[0] - base[0]) * k,
			base[1] + (f.color[1] - base[1]) * k,
			base[2] + (f.color[2] - base[2]) * k
		];
	}

	private _clearScreen(): void {
		const ctx = this._ctx;
		ctx.fillStyle = '#000000';
		ctx.fillRect(0, 0, UI_W, UI_H);
		ctx.fillStyle = '#0d0d0f';
		ctx.fillRect(LCD.x, LCD.y, LCD.w, LCD.h);
	}

	private _drawDefaultUi(): void {
		const ctx = this._ctx;
		this._clearScreen();
		ctx.save();
		ctx.translate(LCD.x - 32, LCD.y - 27);
		const artS = 250,
			artX = 76,
			artY = 96;
		ctx.save();
		ctx.beginPath();
		ctx.roundRect(artX, artY, artS, artS, 8);
		ctx.clip();
		const g = ctx.createLinearGradient(artX, artY, artX, artY + artS);
		g.addColorStop(0, '#10102e');
		g.addColorStop(0.65, '#3a1140');
		g.addColorStop(1, '#0c0c1c');
		ctx.fillStyle = g;
		ctx.fillRect(artX, artY, artS, artS);
		const sun = ctx.createLinearGradient(artX, artY + artS * 0.25, artX, artY + artS * 0.8);
		sun.addColorStop(0, '#ff5d73');
		sun.addColorStop(1, '#b3123f');
		ctx.fillStyle = sun;
		ctx.beginPath();
		ctx.arc(artX + artS / 2, artY + artS * 0.52, artS * 0.27, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = '#10102e';
		for (let k = 0; k < 4; k++) {
			ctx.fillRect(artX, artY + artS * (0.52 + k * 0.055), artS, artS * 0.014 + k * 0.6);
		}
		ctx.restore();
		const colX = artX + artS + 40;
		ctx.textAlign = 'left';
		ctx.fillStyle = '#1db954';
		ctx.font = '600 17px system-ui';
		ctx.fillText('Now playing', colX, 150);
		ctx.fillStyle = '#ffffff';
		ctx.font = '700 46px system-ui';
		ctx.fillText(this._track.title, colX, 205);
		ctx.fillStyle = '#b3b3b3';
		ctx.font = '400 26px system-ui';
		ctx.fillText(this._track.artist, colX, 245);
		const px0 = artX,
			px1 = LCD.x + LCD.w - 60,
			pyLine = 372;
		ctx.strokeStyle = '#3a3a3a';
		ctx.lineWidth = 3;
		ctx.lineCap = 'round';
		ctx.beginPath();
		ctx.moveTo(px0, pyLine);
		ctx.lineTo(px1, pyLine);
		ctx.stroke();
		const head = px0 + (px1 - px0) * (this._progress / this._track.duration);
		ctx.strokeStyle = '#ffffff';
		ctx.beginPath();
		ctx.moveTo(px0, pyLine);
		ctx.lineTo(head, pyLine);
		ctx.stroke();
		const rowY = 412,
			iconC = '#e8eef0';
		ctx.strokeStyle = iconC;
		ctx.fillStyle = iconC;
		ctx.lineWidth = 3;
		const shX = artX + 12;
		ctx.beginPath();
		ctx.moveTo(shX - 14, rowY - 9);
		ctx.lineTo(shX + 10, rowY + 9);
		ctx.moveTo(shX - 14, rowY + 9);
		ctx.lineTo(shX + 10, rowY - 9);
		ctx.stroke();
		const prevX = 262;
		ctx.fillRect(prevX - 14, rowY - 13, 4, 26);
		ctx.beginPath();
		ctx.moveTo(prevX + 14, rowY - 13);
		ctx.lineTo(prevX - 8, rowY);
		ctx.lineTo(prevX + 14, rowY + 13);
		ctx.closePath();
		ctx.fill();
		const midX = 400;
		if (this._playing) {
			ctx.fillRect(midX - 12, rowY - 15, 8, 30);
			ctx.fillRect(midX + 4, rowY - 15, 8, 30);
		} else {
			ctx.beginPath();
			ctx.moveTo(midX - 10, rowY - 15);
			ctx.lineTo(midX + 15, rowY);
			ctx.lineTo(midX - 10, rowY + 15);
			ctx.closePath();
			ctx.fill();
		}
		const nextX = 538;
		ctx.fillRect(nextX + 10, rowY - 13, 4, 26);
		ctx.beginPath();
		ctx.moveTo(nextX - 14, rowY - 13);
		ctx.lineTo(nextX + 8, rowY);
		ctx.lineTo(nextX - 14, rowY + 13);
		ctx.closePath();
		ctx.fill();
		ctx.restore();
	}

	private _frame(t: number): void {
		const gl = this._gl;
		const dt = Math.min((t - this._prevT) / 1000, 0.1) || 0.016;
		this._prevT = t;

		const dpr = Math.min(devicePixelRatio || 1, 2);
		const w = this._canvas.clientWidth,
			h = this._canvas.clientHeight;
		if (this._canvas.width !== w * dpr || this._canvas.height !== h * dpr) {
			this._canvas.width = w * dpr;
			this._canvas.height = h * dpr;
		}

		if (this._camTween) {
			const tw = this._camTween;
			const u = Math.min(1, (t - tw.t0) / tw.duration);
			const e = easeInOut(u);
			this.yaw = tw.from.yaw + (tw.to.yaw - tw.from.yaw) * e;
			this.pitch = tw.from.pitch + (tw.to.pitch - tw.from.pitch) * e;
			this.dist = tw.from.dist + (tw.to.dist - tw.from.dist) * e;
			if (u >= 1) this._camTween = null;
		} else if (!this._dragging) {
			this.yaw += this._velYaw;
			this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + this._velPitch));
			this._velYaw *= 0.94;
			this._velPitch *= 0.94;
		}

		let spinning = false;
		if (this._spin) {
			spinning = true;
			if (this._spin.infinite) {
				this._dialAngle += this._spin.speed * dt;
			} else {
				const sp = this._spin;
				const u = Math.min(1, (t - sp.t0) / sp.duration);
				this._dialAngle = sp.from + (sp.to - sp.from) * easeInOut(u);
				if (u >= 1) this._spin = null;
			}
		}

		if (this._defaultUi && this._playing) {
			this._progress += dt;
			if (this._progress >= this._track.duration) this._progress = 0;
			if (t - this._lastUiUpdate > 400) {
				this._lastUiUpdate = t;
				this._drawDefaultUi();
				this.updateScreen();
			}
		}

		gl.viewport(0, 0, this._canvas.width, this._canvas.height);
		gl.clearColor(0, 0, 0, 0);
		gl.enable(gl.DEPTH_TEST);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

		const m = this._matrices();
		this._renderScene(m.base, m.baseNrm, m.rot, false, spinning);
	}

	/** One geometry path for both passes, so what the pointer hits is exactly
	 * what is on screen -- press offsets included. */
	private _renderScene(
		base: Float32Array,
		baseNrm: Float32Array,
		rot: Float32Array,
		pick: boolean,
		spinning = false
	): void {
		const gl = this._gl;
		const C = this._baseColors;
		const now = performance.now();
		const sink = (part: PartId) => (PRESS_TRAVEL[part] ?? 0) * this._pressAmt(part, now);
		const draw = (
			mesh: Mesh,
			part: PartId,
			color: RGB,
			gloss: number,
			mvp: Float32Array,
			nrm: Float32Array
		) => {
			if (pick) this._drawPick(mesh, part, mvp);
			else this._drawLit(mesh, this._shade(part, color), gloss, mvp, nrm);
		};

		draw(this._body, 'body', C.body, 0.35, base, baseNrm);
		draw(this._hump, 'hump', C.hump, 0.3, base, baseNrm);
		draw(this._slot, 'usb', C.slot, 0.4, base, baseNrm);
		draw(this._edgeTab, 'tag', C.tab, 0.3, base, baseNrm);

		const keyNames: PartId[] = ['preset1', 'preset2', 'preset3', 'preset4', 'settings'];
		for (let i = 0; i < this._keys.length; i++) {
			const part = keyNames[i];
			// Keys were built lying along +Y, so they depress downward in world Y.
			const mvp = mat4Mul(base, mat4Translate(0, -sink(part), 0));
			draw(this._keys[i], part, C.key, 0.3, mvp, baseNrm);
		}
		for (const mic of this._mics) draw(mic, 'body', C.mic, 0.1, base, baseNrm);

		const dialLocal = mat4Mul(
			mat4Translate(DIAL_X, DIAL_Y, BODY_D / 2 + DIAL_D / 2 - 1 - sink('dial')),
			mat4RotZ(this._dialAngle)
		);
		const dialMVP = mat4Mul(base, dialLocal);
		const dialNrm = mat3FromMat4(mat4Mul(rot, mat4RotZ(this._dialAngle)));
		draw(this._dial, 'dial', C.dial, 0.12, dialMVP, dialNrm);
		// The index dot tracks the dial whenever it is turning by any means, so a
		// hand-twist reads as rotation and not just a spinning highlight.
		if (spinning || this._dialDrag || this._dialAngle % (Math.PI * 2) !== 0) {
			const dotMVP = mat4Mul(dialMVP, mat4Translate(0, DIAL_R - 4.5, DIAL_D / 2 + 0.1));
			draw(this._dialDot, 'dial', [0.16, 0.165, 0.17], 0.2, dotMVP, dialNrm);
		}

		const backMVP = mat4Mul(base, mat4Translate(46, -17.5, BODY_D / 2 - 0.55 - sink('back')));
		draw(this._backBtn, 'back', C.back, 0.12, backMVP, baseNrm);

		if (pick) {
			this._drawPickRaw(this._screenPosBuf, this._screenVerts, 'screen', base);
			return;
		}
		gl.useProgram(this._texProg);
		gl.bindBuffer(gl.ARRAY_BUFFER, this._screenPosBuf);
		gl.enableVertexAttribArray(this._texLoc.aPos);
		gl.vertexAttribPointer(this._texLoc.aPos, 3, gl.FLOAT, false, 0, 0);
		gl.bindBuffer(gl.ARRAY_BUFFER, this._screenUVBuf);
		gl.enableVertexAttribArray(this._texLoc.aUV);
		gl.vertexAttribPointer(this._texLoc.aUV, 2, gl.FLOAT, false, 0, 0);
		gl.uniformMatrix4fv(this._texLoc.uMVP, false, base);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this._tex);
		gl.uniform1i(this._texLoc.uTex, 0);
		gl.drawArrays(gl.TRIANGLES, 0, this._screenVerts);
	}

	/** Hover lift on top of whatever the flash animation is doing. */
	private _shade(part: PartId, base: RGB): RGB {
		let c = base;
		if (this._hover === part && HOVERABLE.has(part)) {
			c = [Math.min(1, base[0] + 0.06), Math.min(1, base[1] + 0.07), Math.min(1, base[2] + 0.065)];
		}
		return part === 'body' || part === 'hump' || part === 'screen'
			? c
			: this._flashColor(part as FlashTarget, c);
	}

	private _drawPick(mesh: Mesh, part: PartId, mvp: Float32Array): void {
		this._drawPickRaw(mesh.posBuf, mesh.count, part, mvp);
	}

	private _drawPickRaw(posBuf: WebGLBuffer, count: number, part: PartId, mvp: Float32Array): void {
		const gl = this._gl;
		const loc = this._pickLoc;
		if (!this._pickProg || !loc) return;
		const id = PICK_IDS.indexOf(part) + 1;
		gl.useProgram(this._pickProg);
		gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
		gl.enableVertexAttribArray(loc.aPos);
		gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);
		gl.uniformMatrix4fv(loc.uMVP, false, mvp);
		gl.uniform1f(loc.uId, id / 255);
		gl.drawArrays(gl.TRIANGLES, 0, count);
	}

	private _drawLit(
		mesh: Mesh,
		color: RGB,
		gloss: number,
		mvp: Float32Array,
		nrm3: Float32Array
	): void {
		const gl = this._gl;
		gl.useProgram(this._litProg);
		gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuf);
		gl.enableVertexAttribArray(this._litLoc.aPos);
		gl.vertexAttribPointer(this._litLoc.aPos, 3, gl.FLOAT, false, 0, 0);
		gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nrmBuf);
		gl.enableVertexAttribArray(this._litLoc.aNrm);
		gl.vertexAttribPointer(this._litLoc.aNrm, 3, gl.FLOAT, false, 0, 0);
		gl.uniformMatrix4fv(this._litLoc.uMVP, false, mvp);
		gl.uniformMatrix3fv(this._litLoc.uNrm, false, nrm3);
		gl.uniform3fv(this._litLoc.uColor, color);
		gl.uniform1f(this._litLoc.uGloss, gloss);
		gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
	}
}
