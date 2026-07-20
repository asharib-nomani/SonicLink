// Protocol round-trip test — validates the complete encode/decode pipeline
// in Node.js without any Web Audio API dependencies.
const fs = require('fs');

let utils, protocol;

// Patch const to bare assignment for eval
function loadModule(filename) {
    let code = fs.readFileSync(filename, 'utf8');
    // Replace all `const VAR =` at top level with `VAR =` for eval visibility
    code = code.replace(/^const (utils|protocol) = /m, '$1 = ');
    eval(code); // eslint-disable-line no-eval
}

loadModule('./utils.js');
loadModule('./protocol.js');

let passed = 0, failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log('✅ PASS:', name);
        passed++;
    } catch(e) {
        console.error('❌ FAIL:', name, '-', e.message);
        if (process.env.VERBOSE) console.error(e.stack);
        failed++;
    }
}

// ─── Test 1: Encode/Decode round-trip without any bit errors ────────────────
test('Short message round-trip (no errors)', () => {
    const msg = 'Hello!';
    const packets = protocol.encodeMessage(msg);

    const decoder = new protocol.StreamDecoder();
    let received = null;
    decoder.onComplete = (m) => { received = m; };

    // Feed all bits from all packets
    for (const pktBits of packets) {
        for (let i = 0; i < pktBits.length; i++) {
            decoder.pushBit(pktBits[i], 30);
        }
    }

    if (received === null) throw new Error('No message decoded');
    if (received !== msg) throw new Error(`Expected "${msg}", got "${received}"`);
});

// ─── Test 2: Long message (multiple packets) ─────────────────────────────────
test('Long message round-trip (multiple packets)', () => {
    const msg = 'SonicLink v2 Protocol Test! '.repeat(20); // 560 chars = ~20 packets
    const packets = protocol.encodeMessage(msg);
    console.log(`    Encoded into ${packets.length} packets`);

    const decoder = new protocol.StreamDecoder();
    let received = null;
    decoder.onComplete = (m) => { received = m; };
    decoder.onProgress = (recv, total) => { /* silent */ };

    for (const pktBits of packets) {
        for (let i = 0; i < pktBits.length; i++) {
            decoder.pushBit(pktBits[i], 25);
        }
    }

    if (received === null) throw new Error('No message decoded');
    if (received !== msg) throw new Error(`Message mismatch — first diff at char ${[...msg].findIndex((c,i) => received[i] !== c)}`);
});

// ─── Test 3: Robustness to bit-level noise (FEC correction) ─────────────────
test('Single-bit error per packet corrected by Hamming FEC', () => {
    const msg = 'FEC Test Message';
    const packets = protocol.encodeMessage(msg);
    console.log(`    ${packets.length} packet(s), each with 1-bit error injected post-sync-header`);

    const decoder = new protocol.StreamDecoder();
    let received = null;
    decoder.onComplete = (m) => { received = m; };

    for (const pktBits of packets) {
        // Inject 1-bit error in the middle of the data region (after 64-bit sync header)
        const corrupted = new Uint8Array(pktBits);
        const errorPos = 64 + 8; // after sync header, in first data byte
        corrupted[errorPos] ^= 1;

        for (let i = 0; i < corrupted.length; i++) {
            decoder.pushBit(corrupted[i], 25);
        }
    }

    if (received === null) throw new Error('No message decoded — FEC failed to recover');
    if (received !== msg) throw new Error(`FEC produced wrong output: "${received}"`);
    console.log('    Hamming FEC successfully recovered all corrupted bits');
});

// ─── Test 4: Duplicate packet detection ─────────────────────────────────────
test('Duplicate packet detection', () => {
    const msg = 'Dedup Test';
    const packets = protocol.encodeMessage(msg);

    const decoder = new protocol.StreamDecoder();
    let completions = 0;
    decoder.onComplete = () => { completions++; };

    // Send all packets twice
    for (let round = 0; round < 2; round++) {
        for (const pktBits of packets) {
            for (let i = 0; i < pktBits.length; i++) {
                decoder.pushBit(pktBits[i], 25);
            }
        }
    }

    if (completions !== 1) throw new Error(`Expected 1 completion, got ${completions}`);
    console.log('    Duplicate packets ignored, decoded exactly once');
});

// ─── Test 5: Unicode message ─────────────────────────────────────────────────
test('Unicode message round-trip', () => {
    const msg = '\u0645\u0631\u062d\u0628\u0627 \u4f60\u597d \uD83C\uDFB5 SonicLink';
    const packets = protocol.encodeMessage(msg);

    const decoder = new protocol.StreamDecoder();
    let received = null;
    decoder.onComplete = (m) => { received = m; };

    for (const pktBits of packets) {
        for (let i = 0; i < pktBits.length; i++) {
            decoder.pushBit(pktBits[i], 20);
        }
    }

    if (received !== msg) throw new Error(`Unicode failed: "${received}" !== "${msg}"`);
});

// ─── Test 6: Noise bits before/after packet ──────────────────────────────────
test('Decoder rejects noise before valid packet', () => {
    const msg = 'Noise Test';
    const packets = protocol.encodeMessage(msg);

    const decoder = new protocol.StreamDecoder();
    let received = null;
    decoder.onComplete = (m) => { received = m; };

    // Prepend 256 random noise bits
    for (let i = 0; i < 256; i++) {
        decoder.pushBit(Math.random() > 0.5 ? 1 : 0, 5); // low SNR — treated as signal
    }
    // Then send real packets
    for (const pktBits of packets) {
        for (let i = 0; i < pktBits.length; i++) {
            decoder.pushBit(pktBits[i], 25);
        }
    }

    if (received === null) throw new Error('Decoder failed after noise prefix');
    if (received !== msg) throw new Error(`Got "${received}", expected "${msg}"`);
});

// ─── Test 7: Validate sync header properties ─────────────────────────────────
test('Sync header is exactly 64 bits', () => {
    const hdr = protocol.SYNC_HEADER_BITS;
    if (hdr.length !== 64) throw new Error(`Expected 64, got ${hdr.length}`);
    console.log('    Sync header:', Array.from(hdr).join(''));
});

test('Sync header FSW differs from clock pattern', () => {
    const clock = utils.bytesToBits(protocol.CLOCK_SYNC_BYTES);
    const fsw = utils.bytesToBits(protocol.FRAME_START_BYTES);
    const same = Array.from(clock).every((b, i) => b === fsw[i]);
    if (same) throw new Error('Clock sync and FSW are identical — FSW won\'t be detectable');
});

console.log('');
console.log(`Tests complete: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
