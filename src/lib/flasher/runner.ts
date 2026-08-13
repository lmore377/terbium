// Translation layer: v2 flash archives → fastboot.
//
// Flash archives are written against the amlogic vendor burn-mode protocol
// (bulkcmd, writeUserArea, restorePartition, …). Terbium no longer speaks it —
// the device runs our mainline u-boot and answers fastboot. Rather than break
// every published archive, each v2 step is translated into the equivalent
// fastboot operation here. The mapping:
//
//   writeUserArea       raw LBA write via a `fastboot_raw_partition_*` alias
//   writeBootPartition  flash:mmc0boot0 / flash:mmc0boot1  (+ hwpart reset)
//   restorePartition    the stock partition's LBA range, else a GPT name
//   writeEnv            download + `env import -t` + `saveenv`
//   bulkcmd             rewritten vendor command via `oem console`
//   identify            getvar
//   bl2Boot & friends   dropped — the bootstrap happens at connect time
//
// Raw writes deliberately go through `flash:` rather than `mmc write`: u-boot
// then does its own bounds checking and sparse-image handling, and we get one
// round trip per chunk instead of two.

import type { DataOrFile, FlashConfig, FlashStep, StringOrFile } from 'libsuperbird/meta';
import type { Bytes } from '$lib/bytes';
import { Fastboot } from '$lib/fastboot/client';
import type { FlashArchive } from './archive';
import { ProgressTracker, StreamChunker, type FlashProgress, type StreamSource } from './types';

export interface StepEvent {
	stepIndex: number;
	totalSteps: number;
	label: string;
	progress?: FlashProgress;
}

export interface RunnerCallbacks {
	onStep?: (event: StepEvent) => void;
	onLog?: (message: string) => void;
	signal?: AbortSignal;
	forceSparse?: boolean;
}

const SECTOR_BYTES = 512;

/**
 * Alias used for raw-LBA writes. Kept to two characters on purpose: the whole
 * `oem console setenv fastboot_raw_partition_tb <lba> <sectors>` line has to
 * fit in u-boot's 64-byte fastboot command buffer.
 */
const RAW_ALIAS = 'tb';

/**
 * Host-side chunk ceiling. The device will usually accept 112 MiB
 * (CONFIG_FASTBOOT_BUF_SIZE), but holding that much in a browser tab per chunk
 * is wasteful and makes progress reporting lumpy.
 */
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

/** CONFIG_FASTBOOT_BUF_ADDR on our u-boot — where a download lands in DRAM. */
const FASTBOOT_BUF_ADDR = 0x6000000;

/**
 * Stock amlogic user-area layout, in 512-byte sectors. `restorePartition`
 * is a vendor-layout concept, so a step naming one of these means the stock
 * offsets, not whatever GPT the device happens to be carrying right now.
 */
const STOCK_PARTITIONS: Record<string, { offset: number; size: number }> = {
	bootloader: { offset: 0, size: 4096 },
	reserved: { offset: 73728, size: 131072 },
	cache: { offset: 221184, size: 0 },
	env: { offset: 237568, size: 16384 },
	fip_a: { offset: 270336, size: 8192 },
	fip_b: { offset: 294912, size: 8192 },
	logo: { offset: 319488, size: 16384 },
	dtbo_a: { offset: 352256, size: 8192 },
	dtbo_b: { offset: 376832, size: 8192 },
	vbmeta_a: { offset: 401408, size: 2048 },
	vbmeta_b: { offset: 419840, size: 2048 },
	boot_a: { offset: 438272, size: 32768 },
	boot_b: { offset: 487424, size: 32768 },
	system_a: { offset: 536576, size: 1056856 },
	system_b: { offset: 1609816, size: 1056856 },
	misc: { offset: 2683056, size: 16384 },
	settings: { offset: 2715824, size: 524288 },
	data: { offset: 3256496, size: 4476752 }
};

export function stepLabel(step: FlashStep): string {
	switch (step.type) {
		case 'bulkcmd':
		case 'bulkcmdStat':
			return `running command: ${step.value}`;
		case 'restorePartition':
			return `flashing ${step.value.name}`;
		case 'writeBootPartition':
			return `writing boot${step.value.hwpart - 1} bootloader`;
		case 'writeUserArea':
			return `writing disk image at sector ${step.value.lba}`;
		case 'writeEnv':
			return 'writing environment';
		case 'identify':
			return 'identifying the device';
		case 'validatePartitionSize':
			return `checking ${step.value.name}`;
		case 'log':
			return step.value;
		case 'wait':
			return 'waiting';
		default:
			return (step as FlashStep).type;
	}
}

function weightOf(step: FlashStep, archive: FlashArchive): number {
	const file = fileOf(step);
	if (file && archive.has(file)) return archive.entries.get(file)!.uncompressedSize;
	return 64 * 1024;
}

function fileOf(step: FlashStep): string | undefined {
	switch (step.type) {
		case 'restorePartition':
		case 'writeUserArea':
		case 'writeBootPartition':
		case 'writeSimpleMemory':
		case 'writeLargeMemory':
		case 'writeAMLCData': {
			const data = step.value.data;
			return typeof data === 'object' && 'filePath' in data ? data.filePath : undefined;
		}
		case 'writeEnv':
			return typeof step.value === 'object' ? step.value.filePath : undefined;
		default:
			return undefined;
	}
}

export function stepWeights(config: FlashConfig, archive: FlashArchive): number[] {
	return config.steps.map((step) => weightOf(step, archive));
}

async function dataBytes(archive: FlashArchive, data: DataOrFile): Promise<Bytes> {
	if (Array.isArray(data)) return new Uint8Array(data);
	return archive.bytesOf(data.filePath);
}

async function textValue(archive: FlashArchive, value: StringOrFile): Promise<string> {
	if (typeof value === 'string') return value;
	return archive.textOf(value.filePath);
}

async function sourceFor(archive: FlashArchive, data: DataOrFile): Promise<StreamSource> {
	if (Array.isArray(data)) {
		const bytes = new Uint8Array(data);
		return {
			size: bytes.byteLength,
			stream: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				}
			})
		};
	}
	return archive.sourceOf(data.filePath);
}

export async function runFlashConfig(
	fastboot: Fastboot,
	config: FlashConfig,
	archive: FlashArchive,
	callbacks: RunnerCallbacks = {}
): Promise<void> {
	const { onStep, onLog, signal, forceSparse } = callbacks;
	const totalSteps = config.steps.length;

	for (const [stepIndex, step] of config.steps.entries()) {
		signal?.throwIfAborted();
		const emit = (progress?: FlashProgress) =>
			onStep?.({ stepIndex, totalSteps, label: stepLabel(step), progress });
		emit();
		const sparse = sparseFlag(step) || forceSparse === true;

		switch (step.type) {
			case 'log':
				onLog?.(step.value);
				break;

			case 'wait':
				if (step.value.type === 'time') await sleep(step.value.time);
				break;

			case 'writeUserArea':
				await flashRaw(fastboot, step.value.lba, await sourceFor(archive, step.value.data), {
					sparse,
					signal,
					onProgress: emit
				});
				break;

			case 'writeBootPartition': {
				// mmc0boot0 / mmc0boot1 are u-boot's names for the eMMC boot hwparts.
				const target = step.value.hwpart === 1 ? 'mmc0boot0' : 'mmc0boot1';
				const bytes = await dataBytes(archive, step.value.data);
				const tracker = new ProgressTracker(bytes.byteLength);
				await fastboot.download(bytes, {
					signal,
					onProgress: (sent) => emit(tracker.snapshot(sent))
				});
				await fastboot.flash(target);
				tracker.markWritten(bytes.byteLength);
				emit(tracker.snapshot());
				// Flashing a boot hwpart leaves it selected; anything touching the
				// user area next would land in the wrong place.
				await fastboot.selectHwpart(0);
				break;
			}

			case 'restorePartition': {
				const name = step.value.name;
				const source = await sourceFor(archive, step.value.data);
				const stock = STOCK_PARTITIONS[name];
				if (stock) {
					const limit = stock.size * SECTOR_BYTES;
					if (stock.size > 0 && source.size > limit) {
						throw new Error(
							`${name} image is ${source.size} bytes but the partition only holds ${limit}`
						);
					}
					await flashRaw(fastboot, stock.offset, source, { sparse, signal, onProgress: emit });
				} else {
					// Not a stock partition — assume the device's GPT names it.
					onLog?.(`${name} is not a stock partition, flashing it by GPT name`);
					await flashByName(fastboot, name, source, { signal, onProgress: emit });
				}
				break;
			}

			case 'writeEnv': {
				const text = await textValue(archive, step.value);
				await writeEnv(fastboot, text, { signal });
				break;
			}

			case 'bulkcmd':
			case 'bulkcmdStat': {
				const translated = translateVendorCommand(step.value);
				if (!translated) {
					onLog?.(`skipping vendor-only command: ${step.value}`);
					break;
				}
				if (translated !== step.value) {
					onLog?.(`${step.value} -> ${translated}`);
				}
				const output = await fastboot.console(translated);
				if (output.trim()) onLog?.(output);
				if (/unknown command/i.test(output)) {
					throw new Error(`the bootloader does not understand "${translated}"`);
				}
				break;
			}

			case 'identify': {
				const version = await fastboot.getvar('version-bootloader').catch(() => 'unknown');
				const product = await fastboot.getvar('product').catch(() => 'unknown');
				onLog?.(`device: ${product}, bootloader ${version}`);
				break;
			}

			case 'validatePartitionSize': {
				const name = step.value.name;
				const stock = STOCK_PARTITIONS[name];
				if (stock) {
					onLog?.(`${name}: ${stock.size} sectors`);
					break;
				}
				const size = await fastboot.getvar(`partition-size:${name}`);
				onLog?.(`${name}: ${size}`);
				break;
			}

			// Mask-ROM-only steps. An archive carrying these is describing its own
			// bootstrap, which terbium now performs at connect time instead — by
			// the time we get here the device is already running our u-boot.
			case 'bl2Boot':
			case 'run':
			case 'writeSimpleMemory':
			case 'writeLargeMemory':
			case 'writeAMLCData':
			case 'getBootAMLC':
				onLog?.(`skipping ${step.type}: the device is already booted into fastboot`);
				break;

			case 'readSimpleMemory':
			case 'readLargeMemory':
				throw new Error(`${step.type} has no fastboot equivalent`);

			default:
				throw new Error(`unsupported step type: ${(step as FlashStep).type}`);
		}
	}
}

interface WriteOptions {
	sparse?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: FlashProgress) => void;
}

/**
 * Write a stream to a raw LBA range, one download-buffer-sized chunk at a time.
 *
 * Each chunk points the throwaway `tb` alias at its own sector range and then
 * flashes it, so u-boot handles the actual block writes. With `sparse` set,
 * all-zero chunks are skipped entirely — that's what makes a 64 MiB unbrick
 * image or a mostly-empty rootfs finish in a fraction of the time.
 */
async function flashRaw(
	fastboot: Fastboot,
	startLba: number,
	source: StreamSource,
	options: WriteOptions = {}
): Promise<void> {
	const { sparse, signal, onProgress } = options;
	const limit = await fastboot.maxDownloadSize();
	const chunkBytes =
		Math.max(1, Math.floor(Math.min(limit, MAX_CHUNK_BYTES) / SECTOR_BYTES)) * SECTOR_BYTES;

	const chunker = new StreamChunker(source.stream);
	const tracker = new ProgressTracker(source.size);
	let lba = startLba;
	let offset = 0;

	try {
		while (offset < source.size) {
			signal?.throwIfAborted();
			const length = Math.min(chunkBytes, source.size - offset);
			const chunk = await chunker.read(length);
			offset += length;
			const sectors = Math.ceil(length / SECTOR_BYTES);

			if (sparse && isAllZero(chunk)) {
				tracker.markSkipped(length);
				onProgress?.(tracker.snapshot());
				lba += sectors;
				continue;
			}

			await fastboot.setRawTarget(RAW_ALIAS, lba, sectors);
			await fastboot.download(padToSector(chunk), {
				signal,
				onProgress: (sent) => onProgress?.(tracker.snapshot(sent))
			});
			await fastboot.flash(RAW_ALIAS);
			tracker.markWritten(length);
			onProgress?.(tracker.snapshot());
			lba += sectors;
		}
	} finally {
		await chunker.cancel();
		// Leave no stray alias behind: a later `flash tb` would otherwise hit a
		// stale range instead of failing loudly.
		await fastboot.clearRawTarget(RAW_ALIAS).catch(() => {});
	}
}

/**
 * Flash a partition the device resolves itself (a GPT name). Unlike a raw
 * write we can't split this across chunks — u-boot restarts at the partition
 * start for every `flash:` — so the image has to fit the download buffer.
 */
async function flashByName(
	fastboot: Fastboot,
	name: string,
	source: StreamSource,
	options: WriteOptions = {}
): Promise<void> {
	const { signal, onProgress } = options;
	const limit = await fastboot.maxDownloadSize();
	if (source.size > limit) {
		throw new Error(
			`${name} is ${source.size} bytes, larger than the device's ${limit}-byte download buffer; it needs to be a sparse image`
		);
	}

	const chunker = new StreamChunker(source.stream);
	const tracker = new ProgressTracker(source.size);
	try {
		const bytes = await chunker.read(source.size);
		await fastboot.download(bytes, {
			signal,
			onProgress: (sent) => onProgress?.(tracker.snapshot(sent))
		});
		await fastboot.flash(name);
		tracker.markWritten(source.size);
		onProgress?.(tracker.snapshot());
	} finally {
		await chunker.cancel();
	}
}

/**
 * Import a `key=value` environment into u-boot and persist it.
 *
 * The text goes into the download buffer and `env import -t` parses it in
 * place, which sidesteps the 64-byte command limit that a `setenv` per
 * variable would keep running into. Our u-boot keeps its environment in
 * `uboot.env` on the FAT `env` partition, so `saveenv` is what makes it stick.
 */
export async function writeEnv(
	fastboot: Fastboot,
	env: string,
	options: { signal?: AbortSignal; save?: boolean } = {}
): Promise<void> {
	const normalised = env.endsWith('\n') ? env : `${env}\n`;
	const bytes = new TextEncoder().encode(normalised);
	await fastboot.download(bytes, { signal: options.signal });
	const output = await fastboot.console(
		`env import -t 0x${FASTBOOT_BUF_ADDR.toString(16)} ${bytes.byteLength}`
	);
	if (/error|failed|unknown command/i.test(output)) {
		throw new Error(`the bootloader rejected the environment: ${output.trim()}`);
	}
	if (options.save !== false) {
		const saved = await fastboot.console('saveenv');
		if (/error|failed/i.test(saved)) {
			throw new Error(`saving the environment failed: ${saved.trim()}`);
		}
	}
}

/**
 * Rewrite a vendor burn-mode u-boot command for our u-boot, or return null if
 * it has no meaning here.
 *
 * Only a handful of differences matter in practice. Vendor burn-mode reaches
 * the eMMC as `mmc dev 1`; ours is `mmc dev 0`. The `amlmmc` command is the
 * vendor's fork of `mmc` and its partition/key subcommands operate on an
 * amlogic partition table that our layout doesn't have. Anything unrecognised
 * is passed through — u-boot will say so if it doesn't know the command.
 */
export function translateVendorCommand(command: string): string | null {
	const trimmed = command.trim();

	// Vendor partition-table / key-enclave setup: no equivalent, and nothing
	// downstream depends on it once we're writing raw LBAs.
	if (/^(amlmmc\s+(key|part|partition)|disk_initial)\b/i.test(trimmed)) return null;

	// Vendor burn-mode numbers the eMMC as device 1.
	if (/^mmc\s+dev\s+1\b/i.test(trimmed)) return 'mmc dev 0 0';
	if (/^amlmmc\s+dev\s+1\b/i.test(trimmed)) return 'mmc dev 0 0';

	// Everything else amlmmc does that we care about (read/write/erase) has the
	// same argument shape as plain mmc.
	if (/^amlmmc\b/i.test(trimmed)) return trimmed.replace(/^amlmmc\b/i, 'mmc');

	return trimmed;
}

function sparseFlag(step: FlashStep): boolean {
	if (!('value' in step) || typeof step.value !== 'object' || step.value === null) return false;
	return (step.value as { sparse?: boolean }).sparse === true;
}

function isAllZero(data: Bytes): boolean {
	for (let i = 0; i < data.byteLength; i++) {
		if (data[i] !== 0) return false;
	}
	return true;
}

function padToSector(data: Bytes): Bytes {
	const remainder = data.byteLength % SECTOR_BYTES;
	if (remainder === 0) return data;
	const padded = new Uint8Array(data.byteLength + (SECTOR_BYTES - remainder));
	padded.set(data);
	return padded;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
