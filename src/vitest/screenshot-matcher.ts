// @ts-nocheck
// vitest（@vitest/browser 5.0.3, MIT License, Copyright (c) 2021-Present VoidZero Inc. and Vitest contributors）の
// dist/index.js から toMatchScreenshot の比較処理（__vitest_screenshotMatcher）を抜き出したもの。
// 書き換えたのは import と、ファイル書き込みの許可チェックを外した点だけ。

import { mkdir, readFile as readFile$1, writeFile as writeFile$1 } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "pathe";
import { diff } from "@blazediff/core";
import { deepMerge } from "@vitest/utils/helpers";
import { PNG } from "pngjs";

function assertBrowserApiWrite() {}
function assertBrowserFileAccess() {}

const codec = {
	decode: (buffer, options) => {
		const { data, alpha, bpp, color, colorType, depth, height, interlace, palette, width } = PNG.sync.read(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), options);
		return {
			metadata: {
				alpha,
				bpp,
				color,
				colorType,
				depth,
				height,
				interlace,
				palette,
				width
			},
			data
		};
	},
	encode: ({ data, metadata: { height, width } }, options) => {
		const png = new PNG({
			height,
			width
		});
		png.data = Buffer.isBuffer(data) ? data : Buffer.from(data);
		return PNG.sync.write(png, options);
	}
};

function getCodec(type) {
	switch (type) {
		case "png": return codec;
		default: throw new Error(`No codec found for type ${type}`);
	}
}

const defaultOptions$1 = {
	allowedMismatchedPixelRatio: undefined,
	allowedMismatchedPixels: undefined,
	threshold: .1,
	includeAA: false,
	alpha: .1,
	aaColor: [
		255,
		255,
		0
	],
	diffColor: [
		255,
		0,
		0
	],
	diffColorAlt: undefined,
	diffMask: false
};
const pixelmatch = (reference, actual, { createDiff, ...options }) => {
	if (reference.metadata.height !== actual.metadata.height || reference.metadata.width !== actual.metadata.width) {
		return {
			pass: false,
			diff: null,
			message: `Expected image dimensions to be ${reference.metadata.width}×${reference.metadata.height}px, but received ${actual.metadata.width}×${actual.metadata.height}px.`
		};
	}
	const optionsWithDefaults = {
		...defaultOptions$1,
		...options
	};
	const diffBuffer = createDiff ? new Uint8Array(reference.data.length) : undefined;
	const mismatchedPixels = diff(reference.data, actual.data, diffBuffer, reference.metadata.width, reference.metadata.height, optionsWithDefaults);
	const imageArea = reference.metadata.width * reference.metadata.height;
	let allowedMismatchedPixels = Math.min(optionsWithDefaults.allowedMismatchedPixels ?? Number.POSITIVE_INFINITY, (optionsWithDefaults.allowedMismatchedPixelRatio ?? Number.POSITIVE_INFINITY) * imageArea);
	if (allowedMismatchedPixels === Number.POSITIVE_INFINITY) {
		allowedMismatchedPixels = 0;
	}
	const pass = mismatchedPixels <= allowedMismatchedPixels;
	return {
		pass,
		diff: diffBuffer ?? null,
		message: pass ? null : `${mismatchedPixels} pixels (ratio ${
		// as we compare using `<=`, use `Math.ceil` to ensure the reported ratio
		// doesn't appear equal to the allowed limit when it's a bit over
		(Math.ceil(mismatchedPixels / imageArea * 100) / 100).toFixed(2)}) differ.`
	};
};

const comparators = { pixelmatch };
function getComparator(comparator, context) {
	if (comparator in comparators) {
		return comparators[comparator];
	}
	const customComparators = context.project.config.browser.expect?.toMatchScreenshot?.comparators;
	if (customComparators && comparator in customComparators) {
		return customComparators[comparator];
	}
	throw new Error(`Unrecognized comparator ${comparator}`);
}

const defaultOptions = {
	comparatorName: "pixelmatch",
	// these are handled by each comparator on its own
	comparatorOptions: {},
	screenshotOptions: {
		animations: "disabled",
		caret: "hide",
		fullPage: false,
		maskColor: "#ff00ff",
		omitBackground: false,
		scale: "device"
	},
	timeout: 5e3,
	strict: true,
	resolveDiffPath: ({ arg, ext, root, attachmentsDir, browserName, platform, testFileDirectory, testFileName }) => resolve(root, attachmentsDir, testFileDirectory, testFileName, `${arg}-${browserName}-${platform}${ext}`),
	resolveScreenshotPath: ({ arg, ext, root, screenshotDirectory, testFileDirectory, testFileName, browserName }) => resolve(root, testFileDirectory, screenshotDirectory, testFileName, `${arg}-${browserName}-${platform}${ext}`)
};
const supportedExtensions = ["png"];
function resolveOptions({ context, name, options, testName }) {
	if (context.testPath === undefined) {
		throw new Error("`resolveOptions` has to be used in a test file");
	}
	const resolvedOptions = deepMerge(Object.create(null), defaultOptions, context.project.config.browser.expect?.toMatchScreenshot ?? {}, options);
	const extensionFromName = extname(name);
	// technically the type is a lie, but we check beneath and reassign otherwise
	let extension = extensionFromName.replace(/^\./, "");
	// when `type` will be supported in `screenshotOptions`:
	// - `'png'` should end up in `defaultOptions.screenshotOptions.type`
	// - this condition should be switched around
	// - the assignment should be `resolvedOptions.screenshotOptions.type = extension`
	// - everything using `extension` should use `resolvedOptions.screenshotOptions.type`
	if (supportedExtensions.includes(extension) === false) {
		extension = "png";
	}
	const { root } = context.project.serializedConfig;
	const resolvePathData = {
		arg: sanitizeArg(
			// remove the extension only if it ends up being used
			extensionFromName.endsWith(extension) ? basename(name, extensionFromName) : name
		),
		ext: `.${extension}`,
		platform: platform(),
		root,
		screenshotDirectory: context.project.config.browser.expect?.toMatchScreenshot?.screenshotDirectory ?? "__screenshots__",
		attachmentsDir: relative(root, context.project.config.attachmentsDir),
		testFileDirectory: relative(root, dirname(context.testPath)),
		testFileName: basename(context.testPath),
		testName: sanitize(testName, false),
		browserName: context.project.config.browser.name,
		project: context.project
	};
	return {
		codec: getCodec(extension),
		comparator: getComparator(resolvedOptions.comparatorName, context),
		resolvedOptions,
		paths: {
			reference: resolvedOptions.resolveScreenshotPath(resolvePathData),
			// lazily initialize this, as it might not be needed at all
			get diffs() {
				const diffs = {
					reference: resolvedOptions.resolveDiffPath({
						...resolvePathData,
						arg: `${resolvePathData.arg}-reference`
					}),
					actual: resolvedOptions.resolveDiffPath({
						...resolvePathData,
						arg: `${resolvePathData.arg}-actual`
					}),
					diff: resolvedOptions.resolveDiffPath({
						...resolvePathData,
						arg: `${resolvePathData.arg}-diff`
					})
				};
				Object.defineProperty(this, "diffs", { value: diffs });
				return diffs;
			}
		}
	};
}
/**
* Sanitizes a string by removing or transforming characters to ensure it is
* safe for use as a filename or path segment. It supports two modes:
*
* 1. Non-path mode (`keepPaths === false`):
*    - Replaces one or more whitespace characters (`\s+`) with a single hyphen (`-`).
*    - Removes any character that is not a word character (`\w`) or a hyphen (`-`).
*    - Collapses multiple consecutive hyphens (`-{2,}`) into a single hyphen.
*
* 2. Path-preserving mode (`keepPaths === true`):
*    - Splits the input string on the path separator.
*    - Sanitizes each path segment individually in non-path mode.
*    - Joins the sanitized segments back together.
*
* @param input - The raw string to sanitize.
* @param keepPaths - If `false`, performs a flat sanitization (drops path segments).
* If `true`, treats `input` as a path: each segment is sanitized independently,
* preserving separators.
*/
function sanitize(input, keepPaths) {
	if (keepPaths === false) {
		return input.replace(/\s+/g, "-").replace(/[^\w-]+/g, "").replace(/-{2,}/g, "-");
	}
	return input.split("/").map((path) => sanitize(path, false)).join("/");
}
/**
* Takes a string, treats it as a potential path or filename, and ensures it cannot
* escape the root directory or contain invalid characters. Internally, it:
*
* 1. Prepends the path separator to the raw input to form a path-like string.
* 2. Uses {@linkcode relative|relative('/', <that-path>)} to compute a relative
* path from the root, which effectively strips any leading separators and prevents
* traversal above the root.
* 3. Passes the resulting relative path into {@linkcode sanitize|sanitize(..., true)},
* preserving any path separators but sanitizing each segment.
*
* @param input - The raw string to clean.
*/
function sanitizeArg(input) {
	return sanitize(relative("/", join("/", input)), true);
}
/**
* Takes a screenshot and decodes it using the provided codec.
*
* The screenshot is taken as a base64 string and then decoded into the format
* expected by the comparator.
*
* @returns `Promise` resolving to the decoded screenshot data
*/
function takeScreenshotBuffer({ context, element, name, screenshotOptions, target }) {
	return context.triggerCommand("__vitest_takeScreenshot", name, {
		...screenshotOptions,
		save: false,
		element,
		target
	}).then(({ buffer }) => buffer);
}
function takeDecodedScreenshot({ codec, ...options }) {
	return takeScreenshotBuffer(options).then((buffer) => codec.decode(buffer, {}));
}
/**
* Creates a promise that resolves to `null` after the specified timeout.
* If the timeout is `0`, the promise resolves immediately.
*
* @param timeout - The delay in milliseconds before the promise resolves
* @returns `Promise` that resolves to `null` after the timeout
*/
function asyncTimeout(timeout) {
	return new Promise((resolve) => {
		if (timeout === 0) {
			resolve(null);
		} else {
			setTimeout(resolve, timeout, null);
		}
	});
}

/**
* Browser command that compares a screenshot against a stored reference.
*
* The comparison workflow is organized as follows:
*
* 1. Load existing reference (if any)
* 2. Capture a stable screenshot (retrying until the page stops changing)
* 3. Determine the outcome based on capture results and update settings
* 4. Write any necessary files (new references, diffs)
* 5. Return result for the test runner
*/
const screenshotMatcher = async (context, name, testName, options) => {
	if (!context.testPath) {
		throw new Error("Cannot compare screenshots without a test path");
	}
	const { element, target } = options;
	const { codec, comparator, paths, resolvedOptions: { comparatorName, comparatorOptions, screenshotOptions, timeout } } = resolveOptions({
		context,
		name,
		testName,
		options
	});
	const screenshotName = `${Date.now()}-${basename(paths.reference)}`;
	const screenshotCaptureOptions = {
		context,
		element,
		name: screenshotName,
		screenshotOptions,
		target
	};
	const referenceFile = await readFile$1(paths.reference).catch(() => null);
	let reference = null;
	let initialScreenshot = null;
	if (referenceFile) {
		// Reuse this capture in the stability loop so the byte fast path doesn't add another screenshot.
		const initialScreenshotBuffer = await takeScreenshotBuffer(screenshotCaptureOptions);
		// Keep custom comparator semantics intact: only the built-in pixelmatch
		// comparator is known to pass byte-identical PNGs without side effects.
		if (comparatorName === "pixelmatch" && Buffer.compare(referenceFile, initialScreenshotBuffer) === 0) {
			return buildOutput({ type: "matched-immediately" }, timeout);
		}
		[reference, initialScreenshot] = await Promise.all([codec.decode(referenceFile, {}), takeScreenshotData({
			...screenshotCaptureOptions,
			buffer: initialScreenshotBuffer,
			codec
		})]);
	}
	const screenshotResult = await waitForStableScreenshot({
		codec,
		comparator,
		comparatorOptions,
		context,
		element,
		initialScreenshot,
		name: screenshotName,
		reference,
		screenshotOptions,
		target
	}, timeout);
	const outcome = await determineOutcome({
		reference,
		screenshot: screenshotResult && screenshotResult.actual,
		screenshotBuffer: screenshotResult?.buffer,
		retries: screenshotResult?.retries ?? 0,
		updateSnapshot: context.project.serializedConfig.snapshotOptions.updateSnapshot,
		paths,
		comparator,
		comparatorOptions
	});
	await performSideEffects(outcome, codec, context.project);
	return buildOutput(outcome, timeout);
};
/**
* Core comparison logic that produces a {@linkcode MatchOutcome}.
*
* All branching logic lives here. This is the single source of truth for "what happened".
*
* The outcome carries all data needed by {@linkcode performSideEffects} and {@linkcode buildOutput}.
*/
async function determineOutcome({ comparator, comparatorOptions, paths, reference, retries, screenshot, screenshotBuffer, updateSnapshot }) {
	if (screenshot === null) {
		return {
			type: "unstable-screenshot",
			reference: reference && {
				image: reference,
				path: paths.reference
			}
		};
	}
	// no reference to compare against - create one based on update settings
	if (reference === null) {
		if (updateSnapshot === "all") {
			return {
				type: "update-reference",
				reference: {
					image: screenshot,
					path: paths.reference,
					buffer: screenshotBuffer
				}
			};
		}
		const location = updateSnapshot === "none" ? "diffs" : "reference";
		return {
			type: "missing-reference",
			location,
			reference: {
				image: screenshot,
				path: location === "reference" ? paths.reference : paths.diffs.reference,
				buffer: screenshotBuffer
			}
		};
	}
	// first capture matched reference (used as baseline) - no further comparison needed
	if (retries === 0) {
		return { type: "matched-immediately" };
	}
	const comparisonResult = await comparator(reference, screenshot, {
		createDiff: true,
		...comparatorOptions
	});
	if (comparisonResult.pass) {
		return { type: "matched-after-comparison" };
	}
	if (updateSnapshot === "all") {
		return {
			type: "update-reference",
			reference: {
				image: screenshot,
				path: paths.reference,
				buffer: screenshotBuffer
			}
		};
	}
	return {
		type: "mismatch",
		reference: {
			image: reference,
			path: paths.reference
		},
		actual: {
			image: screenshot,
			path: paths.diffs.actual,
			buffer: screenshotBuffer
		},
		diff: comparisonResult.diff && {
			image: {
				data: comparisonResult.diff,
				// `comparator` only returns pixel data; diff dimensions always match reference
				metadata: reference.metadata
			},
			path: paths.diffs.diff
		},
		message: comparisonResult.message
	};
}
/**
* Writes files to disk based on the outcome.
*
* Only `missing-reference`, `update-reference`, and `mismatch` write files. Successful matches produce no side effects.
*/
async function performSideEffects(outcome, codec, project) {
	switch (outcome.type) {
		case "missing-reference":
		case "update-reference": {
			await writeScreenshot(outcome.reference.path, await encodeScreenshot(outcome.reference, codec), project);
			break;
		}
		case "mismatch": {
			await writeScreenshot(outcome.actual.path, await encodeScreenshot(outcome.actual, codec), project);
			if (outcome.diff) {
				await writeScreenshot(outcome.diff.path, await codec.encode(outcome.diff.image, {}), project);
			}
			break;
		}
	}
}
function encodeScreenshot(screenshot, codec) {
	return screenshot.buffer ?? codec.encode(screenshot.image, {});
}
/**
* Transforms a {@linkcode MatchOutcome} into the output format expected by the test runner.
*
* Maps each outcome to a pass/fail result with metadata and error messages.
*/
function buildOutput(outcome, timeout) {
	switch (outcome.type) {
		case "unstable-screenshot": return {
			pass: false,
			outcome: outcome.type,
			reference: outcome.reference && {
				path: outcome.reference.path,
				width: outcome.reference.image.metadata.width,
				height: outcome.reference.image.metadata.height
			},
			actual: null,
			diff: null,
			message: `Could not capture a stable screenshot within ${timeout}ms.`
		};
		case "missing-reference": {
			return {
				pass: false,
				outcome: outcome.type,
				reference: {
					path: outcome.reference.path,
					width: outcome.reference.image.metadata.width,
					height: outcome.reference.image.metadata.height
				},
				actual: null,
				diff: null,
				message: outcome.location === "reference" ? "No existing reference screenshot found; a new one was created. Review it before running tests again." : "No existing reference screenshot found."
			};
		}
		case "update-reference":
		case "matched-immediately":
		case "matched-after-comparison": return {
			pass: true,
			outcome: outcome.type
		};
		case "mismatch": return {
			pass: false,
			outcome: outcome.type,
			reference: {
				path: outcome.reference.path,
				width: outcome.reference.image.metadata.width,
				height: outcome.reference.image.metadata.height
			},
			actual: {
				path: outcome.actual.path,
				width: outcome.actual.image.metadata.width,
				height: outcome.actual.image.metadata.height
			},
			diff: outcome.diff && {
				path: outcome.diff.path,
				width: outcome.diff.image.metadata.width,
				height: outcome.diff.image.metadata.height
			},
			message: `Screenshot does not match the stored reference.${outcome.message ? `\n${outcome.message}` : ""}`
		};
		default: {
			return {
				pass: false,
				outcome: null,
				actual: null,
				reference: null,
				diff: null,
				message: `Outcome (${outcome.type}) not handled. This is a bug in Vitest. Please, open an issue with reproduction.`
			};
		}
	}
}
/**
* Captures a stable screenshot with timeout handling.
*
* Wraps {@linkcode getStableScreenshot} with an abort controller that triggers when the timeout expires. Returns `null` if the page never stabilizes.
*/
async function waitForStableScreenshot(options, timeout) {
	const abortController = new AbortController();
	const stableScreenshot = getStableScreenshot(options, abortController.signal);
	const result = await (timeout === 0 ? stableScreenshot : Promise.race([stableScreenshot, asyncTimeout(timeout).finally(() => abortController.abort())]));
	return result;
}
/**
* Takes screenshots repeatedly until the page reaches a visually stable state.
*
* This function compares consecutive screenshots and continues taking new ones until two consecutive screenshots match according to the provided comparator.
*
* The process works as follows:
*
* 1. Uses as baseline an optional reference screenshot or takes a new screenshot
* 2. Takes a screenshot and compares with baseline
* 3. If they match, the page is considered stable and the function returns
* 4. If they don't match, it continues with the newer screenshot as the baseline
* 5. Repeats until stability is achieved or the operation is aborted
*
* @returns `Promise` resolving to an object containing the retry count and final screenshot
*/
async function getStableScreenshot({ codec, context, comparator, comparatorOptions, element, initialScreenshot, name, reference, screenshotOptions, target }, signal) {
	const screenshotArgument = {
		codec,
		context,
		element,
		name,
		screenshotOptions,
		target
	};
	let retries = 0;
	let decodedBaseline = reference;
	let nextScreenshot = initialScreenshot;
	let lastCapturedScreenshot = null;
	while (signal.aborted === false) {
		if (decodedBaseline === null) {
			decodedBaseline = takeDecodedScreenshot(screenshotArgument);
		}
		const [image1, capturedScreenshot] = await Promise.all([decodedBaseline, nextScreenshot ?? takeScreenshotData(screenshotArgument)]);
		const { image: image2 } = capturedScreenshot;
		lastCapturedScreenshot = capturedScreenshot;
		const isStable = (await comparator(image1, image2, {
			...comparatorOptions,
			createDiff: false
		})).pass;
		decodedBaseline = image2;
		nextScreenshot = null;
		if (isStable) {
			return {
				retries,
				actual: image2,
				buffer: capturedScreenshot.buffer
			};
		}
		retries += 1;
	}
	lastCapturedScreenshot ??= await takeScreenshotData(screenshotArgument);
	return {
		retries,
		actual: lastCapturedScreenshot.image,
		buffer: lastCapturedScreenshot.buffer
	};
}
async function takeScreenshotData({ buffer, codec, context, element, name, screenshotOptions, target }) {
	const screenshot = buffer ?? await takeScreenshotBuffer({
		context,
		element,
		name,
		screenshotOptions,
		target
	});
	return {
		buffer: screenshot,
		image: await codec.decode(screenshot, {})
	};
}
/** Writes encoded images to disk, creating parent directories as needed. */
async function writeScreenshot(path, image, project) {
	try {
		assertBrowserApiWrite(project, path);
		assertBrowserFileAccess(project, path);
		await mkdir(dirname(path), { recursive: true });
		await writeFile$1(path, image);
	} catch (cause) {
		throw new Error("Couldn't write file to fs", { cause });
	}
}


export { screenshotMatcher };
