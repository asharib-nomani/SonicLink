// Node.js test harness for SonicLink utils.js
// Uses Function() to eval in a scope where const becomes accessible via globalThis trick
const fs = require('fs');

// utils.js uses const utils = {...} — we wrap it so we can extract it
let utils;
const code = fs.readFileSync('./utils.js', 'utf8');
// Replace the terminal const declaration with a global assignment for testing
const patchedCode = code.replace('const utils = {', 'utils = {');
eval(patchedCode); // eslint-disable-line no-eval

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log('✅ PASS:', name);
        passed++;
    } catch(e) {
        console.error('❌ FAIL:', name, '-', e.message);
        failed++;
    }
}

// CRC-32
test('CRC-32 round-trip', () => {
    const b = new Uint8Array([1,2,3,4,5,255]);
    const crc = utils.crc32(b);
    const bytes = utils.crc32ToBytes(crc);
    const back = utils.bytesToCrc32(bytes, 0);
    if (crc !== back) throw new Error(`${crc} !== ${back}`);
    console.log('    CRC value: 0x' + crc.toString(16).toUpperCase().padStart(8,'0'));
});

test('CRC-32 detects corruption', () => {
    const b = new Uint8Array([72,101,108,108,111]);
    const crc = utils.crc32(b);
    const b2 = new Uint8Array(b);
    b2[2] ^= 0xFF;
    const crc2 = utils.crc32(b2);
    if (crc === crc2) throw new Error('CRC did not change after corruption');
});

test('CRC-32 known value (empty array)', () => {
    // CRC32 of [] should be 0x00000000
    const crc = utils.crc32(new Uint8Array([]));
    if (crc !== 0x00000000) throw new Error('Expected 0, got 0x' + crc.toString(16));
});

// Bit conversion
test('Bytes-to-bits-to-bytes round-trip', () => {
    const b = new Uint8Array([0xAA, 0xCC, 0x16, 0xF3]);
    const bits = utils.bytesToBits(b);
    if (bits.length !== 32) throw new Error('Expected 32 bits, got ' + bits.length);
    const back = utils.bitsToBytes(bits);
    for (let i = 0; i < b.length; i++) {
        if (back[i] !== b[i]) throw new Error(`Byte ${i}: expected 0x${b[i].toString(16)}, got 0x${back[i].toString(16)}`);
    }
});

test('0xAA bit pattern is 10101010', () => {
    const bits = utils.bytesToBits(new Uint8Array([0xAA]));
    const expected = [1,0,1,0,1,0,1,0];
    for (let i = 0; i < 8; i++) {
        if (bits[i] !== expected[i]) throw new Error(`bit ${i}: expected ${expected[i]}, got ${bits[i]}`);
    }
});

test('0xFF encodes to all 1s', () => {
    const bits = utils.bytesToBits(new Uint8Array([0xFF]));
    for (let i = 0; i < 8; i++) {
        if (bits[i] !== 1) throw new Error(`bit ${i} should be 1`);
    }
});

test('0x00 encodes to all 0s', () => {
    const bits = utils.bytesToBits(new Uint8Array([0x00]));
    for (let i = 0; i < 8; i++) {
        if (bits[i] !== 0) throw new Error(`bit ${i} should be 0`);
    }
});

// Hamming(7,4) FEC
test('Hamming encode produces 2x output length', () => {
    const msg = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]);
    const enc = utils.hammingEncode(msg);
    if (enc.length !== msg.length * 2) throw new Error(`Expected ${msg.length*2} bytes, got ${enc.length}`);
});

test('Hamming encode/decode - no errors', () => {
    const msg = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]);
    const enc = utils.hammingEncode(msg);
    const { data, corrected } = utils.hammingDecode(enc);
    if (corrected !== 0) throw new Error('Expected 0 corrections, got ' + corrected);
    for (let i = 0; i < msg.length; i++) {
        if (data[i] !== msg[i]) throw new Error(`Byte ${i}: ${data[i]} !== ${msg[i]}`);
    }
});

test('Hamming corrects 1-bit errors in all encoded bytes', () => {
    const msg = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]);
    const enc = utils.hammingEncode(msg);
    let totalFixed = 0;
    for (let byteIdx = 0; byteIdx < enc.length; byteIdx++) {
        for (let bitPos = 0; bitPos < 7; bitPos++) {
            const damaged = new Uint8Array(enc);
            damaged[byteIdx] ^= (1 << bitPos);
            const { data, corrected } = utils.hammingDecode(damaged);
            if (corrected < 1) throw new Error(`encoded[${byteIdx}] bit ${bitPos}: no correction reported`);
            for (let j = 0; j < msg.length; j++) {
                if (data[j] !== msg[j]) throw new Error(`After correcting enc[${byteIdx}] bit ${bitPos}: decoded byte ${j} wrong`);
            }
            totalFixed++;
        }
    }
    console.log(`    Corrected ${totalFixed} individual 1-bit errors — all OK`);
});

// Hann window
test('Hann window shape', () => {
    const w = utils.makeHannWindow(1024);
    if (w[0] > 0.001) throw new Error('Hann[0] should be ~0, got ' + w[0]);
    if (w[512] < 0.999) throw new Error('Hann[512] should be ~1, got ' + w[512]);
    if (w[1023] > 0.001) throw new Error('Hann[1023] should be ~0, got ' + w[1023]);
});

// String round-trips
test('String UTF-8 round-trip (ASCII)', () => {
    const str = 'Hello, SonicLink!';
    const back = utils.bytesToString(utils.stringToBytes(str));
    if (back !== str) throw new Error(`${back} !== ${str}`);
});

test('String UTF-8 round-trip (Unicode)', () => {
    const str = '\u0645\u0631\u062d\u0628\u0627 \u4f60\u597d \uD83C\uDFB5';
    const back = utils.bytesToString(utils.stringToBytes(str));
    if (back !== str) throw new Error('Unicode round-trip failed');
});

console.log('');
console.log(`Tests complete: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
