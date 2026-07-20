/**
 * utils.js — SonicLink DSP Utilities
 *
 * Provides: CRC-32, Hamming(7,4) FEC, bit<->byte conversion,
 * and windowing functions for the signal processing pipeline.
 */

const utils = {

    // ─── Text <-> Bytes ────────────────────────────────────────────────────────

    stringToBytes: function(str) {
        return new TextEncoder().encode(str);
    },

    bytesToString: function(bytes) {
        return new TextDecoder().decode(new Uint8Array(bytes));
    },

    // ─── Bit Conversion ────────────────────────────────────────────────────────

    /**
     * Convert a Uint8Array (or array) to a flat bit array, MSB first.
     */
    bytesToBits: function(bytes) {
        const bits = new Uint8Array(bytes.length * 8);
        for (let i = 0; i < bytes.length; i++) {
            for (let j = 7; j >= 0; j--) {
                bits[i * 8 + (7 - j)] = (bytes[i] >> j) & 1;
            }
        }
        return bits;
    },

    /**
     * Convert a flat bit array to a Uint8Array, MSB first.
     * Pads with zeros if length is not a multiple of 8.
     */
    bitsToBytes: function(bits) {
        const byteLen = Math.ceil(bits.length / 8);
        const bytes = new Uint8Array(byteLen);
        for (let i = 0; i < byteLen; i++) {
            let b = 0;
            for (let j = 0; j < 8; j++) {
                const idx = i * 8 + j;
                if (idx < bits.length && bits[idx] === 1) {
                    b |= (1 << (7 - j));
                }
            }
            bytes[i] = b;
        }
        return bytes;
    },

    // ─── CRC-32 ────────────────────────────────────────────────────────────────

    /**
     * Pre-computed CRC-32 lookup table (IEEE 802.3 polynomial 0xEDB88320)
     */
    _crc32Table: (function() {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let j = 0; j < 8; j++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[i] = c;
        }
        return table;
    })(),

    /**
     * Calculate CRC-32 of a byte array.
     * @param {Uint8Array|Array} bytes
     * @returns {number} 32-bit unsigned integer
     */
    crc32: function(bytes) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) {
            crc = this._crc32Table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    },

    /**
     * Encode a 32-bit CRC value into 4 bytes (big-endian).
     */
    crc32ToBytes: function(crc) {
        return new Uint8Array([
            (crc >>> 24) & 0xFF,
            (crc >>> 16) & 0xFF,
            (crc >>> 8) & 0xFF,
            crc & 0xFF
        ]);
    },

    /**
     * Decode 4 big-endian bytes to a 32-bit unsigned integer.
     */
    bytesToCrc32: function(bytes, offset) {
        return ((bytes[offset] << 24) | (bytes[offset+1] << 16) |
                (bytes[offset+2] << 8) | bytes[offset+3]) >>> 0;
    },

    // ─── Hamming(7,4) Forward Error Correction ─────────────────────────────────
    // Each 4-bit nibble is encoded into 7 bits with 3 parity bits.
    // This corrects any single-bit error per nibble automatically.

    /**
     * Encode a Uint8Array with Hamming(7,4).
     * Each input byte becomes two Hamming(7,4) codewords (14 bits → padded to 2 bytes).
     * We pack two 7-bit codewords into 2 bytes (14 bits, top 2 bits of second byte unused).
     *
     * Output: Uint8Array that is ceil(inputLen * 14 / 8) bytes.
     * Simpler packing: each byte -> 2 codewords of 7 bits -> stored as 2 bytes
     * (upper nibble of first byte, lower nibble+parity packed). For simplicity
     * and speed, we pack each 7-bit codeword into 1 byte (1 bit wasted).
     */
    hammingEncode: function(bytes) {
        const out = new Uint8Array(bytes.length * 2);
        let outIdx = 0;
        for (let i = 0; i < bytes.length; i++) {
            out[outIdx++] = this._hammingEncodeNibble(bytes[i] >> 4);
            out[outIdx++] = this._hammingEncodeNibble(bytes[i] & 0x0F);
        }
        return out;
    },

    /**
     * Decode Hamming(7,4) encoded bytes back to original.
     * Returns { data: Uint8Array, corrected: number } where corrected = number of fixed errors.
     */
    hammingDecode: function(encoded) {
        if (encoded.length % 2 !== 0) return { data: new Uint8Array(0), corrected: 0, errors: 1 };
        const out = new Uint8Array(encoded.length / 2);
        let corrected = 0;
        for (let i = 0; i < encoded.length; i += 2) {
            const r0 = this._hammingDecodeNibble(encoded[i]);
            const r1 = this._hammingDecodeNibble(encoded[i + 1]);
            corrected += r0.corrected + r1.corrected;
            out[i / 2] = (r0.nibble << 4) | r1.nibble;
        }
        return { data: out, corrected };
    },

    /**
     * Encode a 4-bit nibble to a 7-bit Hamming codeword (stored in low 7 bits of byte).
     * Bit positions (1-indexed): p1=1, p2=2, d1=3, p4=4, d2=5, d3=6, d4=7
     */
    _hammingEncodeNibble: function(nibble) {
        const d1 = (nibble >> 3) & 1;
        const d2 = (nibble >> 2) & 1;
        const d3 = (nibble >> 1) & 1;
        const d4 = nibble & 1;
        const p1 = d1 ^ d2 ^ d4;
        const p2 = d1 ^ d3 ^ d4;
        const p4 = d2 ^ d3 ^ d4;
        return (p1 << 6) | (p2 << 5) | (d1 << 4) | (p4 << 3) | (d2 << 2) | (d3 << 1) | d4;
    },

    /**
     * Decode a 7-bit Hamming codeword (low 7 bits), correcting 1-bit errors.
     */
    _hammingDecodeNibble: function(codeword) {
        codeword &= 0x7F; // mask to 7 bits
        const p1 = (codeword >> 6) & 1;
        const p2 = (codeword >> 5) & 1;
        const d1 = (codeword >> 4) & 1;
        const p4 = (codeword >> 3) & 1;
        const d2 = (codeword >> 2) & 1;
        const d3 = (codeword >> 1) & 1;
        const d4 = codeword & 1;

        const s1 = p1 ^ d1 ^ d2 ^ d4;
        const s2 = p2 ^ d1 ^ d3 ^ d4;
        const s4 = p4 ^ d2 ^ d3 ^ d4;
        const syndrome = (s4 << 2) | (s2 << 1) | s1;

        let corrected = 0;
        if (syndrome !== 0) {
            // Flip the erroneous bit (syndrome is 1-indexed position)
            codeword ^= (1 << (7 - syndrome));
            corrected = 1;
        }
        const nibble = ((codeword >> 4) & 1) << 3 |
                       ((codeword >> 2) & 1) << 2 |
                       ((codeword >> 1) & 1) << 1 |
                       (codeword & 1);
        return { nibble, corrected };
    },

    // ─── Windowing ─────────────────────────────────────────────────────────────

    /**
     * Generate a Hann window of the given length.
     * Pre-computing is critical for performance — do it once.
     */
    makeHannWindow: function(len) {
        const w = new Float32Array(len);
        for (let i = 0; i < len; i++) {
            w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
        }
        return w;
    },

    // ─── DSP Helpers ───────────────────────────────────────────────────────────

    /**
     * Compute RMS amplitude of a Float32Array of samples.
     */
    rms: function(samples, start, len) {
        let sum = 0;
        const end = start + len;
        for (let i = start; i < end; i++) {
            sum += samples[i] * samples[i];
        }
        return Math.sqrt(sum / len);
    },

    /**
     * Fast median of a small array (used for noise floor estimation).
     */
    median: function(arr) {
        const s = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
    }
};
