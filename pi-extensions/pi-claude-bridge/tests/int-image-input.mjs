#!/usr/bin/env node

import { deflateSync } from "node:zlib";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const name = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
	return Buffer.concat([length, name, data, checksum]);
}

function twoColorPng(left, right) {
	const width = 64;
	const height = 32;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const rows = [];
	for (let y = 0; y < height; y += 1) {
		const row = Buffer.alloc(1 + width * 3);
		for (let x = 0; x < width; x += 1) {
			const offset = 1 + x * 3;
			if (x < width / 2) row.set(left, offset);
			else row.set(right, offset);
		}
		rows.push(row);
	}
	return Buffer.concat([
		Buffer.from("89504e470d0a1a0a", "hex"),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

const harness = createRpcHarness({
	name: "image-input",
	args: ["--model", BRIDGE_MODEL],
	defaultTimeout: TIMEOUT,
});
const { start, stop, send, waitForEvent, collectText, DEBUG_LOG, RPC_LOG } = harness;
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

let finishing = false;
function finish(code, message) {
	if (finishing) return;
	finishing = true;
	console.log(message);
	if (code !== 0) {
		console.log(`  RPC log:    ${RPC_LOG}`);
		console.log(`  Debug log:  ${DEBUG_LOG}`);
	}
	stop().then(() => process.exit(code));
}

start();
await new Promise((resolve) => setTimeout(resolve, 2_000));

try {
	const collector = collectText();
	await send({
		type: "prompt",
		message:
			"Inspect the attached image. Reply exactly: RED LEFT, BLUE RIGHT. Do not infer; answer only from the image.",
		images: [
			{
				type: "image",
				data: twoColorPng(RED, BLUE).toString("base64"),
				mimeType: "image/png",
			},
		],
	});
	await waitForEvent("agent_end", TIMEOUT);
	const response = collector.stop().replace(/[*_`]/g, " ").replace(/\s+/g, " ").trim();
	if (!/red\s+left/i.test(response) || !/blue\s+right/i.test(response)) {
		finish(1, `FAIL: Claude did not identify the attached image: ${response}`);
	}

	const interruptedCollector = collectText();
	await send({
		type: "prompt",
		message:
			"Study this NEW attached image. Write at least 1000 words of private analysis before naming either color, and put the color orientation only in the final sentence.",
		images: [
			{
				type: "image",
				data: twoColorPng(BLUE, RED).toString("base64"),
				mimeType: "image/png",
			},
		],
	});
	const interruptedEnd = waitForEvent("agent_end", TIMEOUT);
	await new Promise((resolve) => setTimeout(resolve, 750));
	await send({ type: "abort" });
	await interruptedEnd;
	interruptedCollector.stop();

	const recoveryCollector = collectText();
	await send({
		type: "prompt",
		message:
			"For the most recently attached image from the interrupted turn, reply exactly: BLUE LEFT, RED RIGHT.",
	});
	await waitForEvent("agent_end", TIMEOUT);
	const recovered = recoveryCollector.stop().replace(/[*_`]/g, " ").replace(/\s+/g, " ").trim();
	if (!/blue\s+left/i.test(recovered) || !/red\s+right/i.test(recovered)) {
		finish(1, `FAIL: Claude lost the image during abort recovery: ${recovered}`);
	} else {
		finish(0, `PASS: fresh=${response}; recovered=${recovered}`);
	}
} catch (error) {
	finish(1, `FAIL: ${error instanceof Error ? error.stack : String(error)}`);
}
