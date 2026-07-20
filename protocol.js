/**
 * protocol.js — SonicLink v2 Acoustic Communication Protocol
 *
 * ARCHITECTURE OVERVIEW
 * ─────────────────────
 * The protocol uses a layered design:
 *
 *  1. SYNCHRONIZATION FRAME
 *     • 32-bit alternating preamble (clock sync): 0xAAAAAAAA
 *     • 32-bit frame start word (FSW): 0x16F3A5C8
 *     These two together form a 64-bit synchronization header that is statistically
 *     impossible to produce by environmental noise alone (1 in 2^64 chance).
 *
 *  2. PACKET STRUCTURE (before FEC encoding)
 *     ┌─────────────┬───────────────────────────────────────────────────────────┐
 *     │ FIELD        │ SIZE     │ DESCRIPTION                                   │
 *     ├─────────────┼──────────┼───────────────────────────────────────────────┤
 *     │ INDEX        │ 1 byte   │ Packet sequence number (0–254)                │
 *     │ TOTAL        │ 1 byte   │ Total packets in message (1–255)              │
 *     │ FLAGS        │ 1 byte   │ Bit flags: 0x01=last, 0x02=retransmit        │
 *     │ LENGTH       │ 1 byte   │ Payload byte count (1–MAX_PAYLOAD)            │
 *     │ PAYLOAD      │ N bytes  │ UTF-8 message chunk                           │
 *     │ CRC-32       │ 4 bytes  │ CRC of INDEX+TOTAL+FLAGS+LENGTH+PAYLOAD       │
 *     └─────────────┴──────────┴───────────────────────────────────────────────┘
 *
 *  3. FEC LAYER
 *     After the packet is serialized, Hamming(7,4) is applied to every byte.
 *     Each byte doubles in size (2×7-bit codewords). This corrects all single-bit
 *     errors per byte automatically at the receiver — no retransmit needed for
 *     single-bit flips.
 *
 *  4. DIFFERENTIAL ENCODING
 *     The final bit stream is differentially encoded (DBFSK): a '1' is represented
 *     by a frequency change, a '0' by no change. This eliminates dependency on
 *     absolute phase reference and makes decoding robust to partial clock slips.
 *
 * TOTAL OVERHEAD PER PACKET: preamble(8B) + FSW(4B) + header(4B) + CRC(4B) = 20 bytes
 * EFFECTIVE PAYLOAD: 32 bytes per packet (configurable)
 */

const protocol = {

    // ─── Synchronization Constants ─────────────────────────────────────────────

    /** 32-bit alternating clock sync pattern (4 bytes: 0xAA 0xAA 0xAA 0xAA) */
    CLOCK_SYNC_BYTES: new Uint8Array([0xAA, 0xAA, 0xAA, 0xAA]),

    /** 32-bit Frame Start Word — unique pattern, low autocorrelation with noise */
    FRAME_START_BYTES: new Uint8Array([0x16, 0xF3, 0xA5, 0xC8]),

    get CLOCK_SYNC_BITS() {
        if (!this._clockSyncBits) this._clockSyncBits = utils.bytesToBits(this.CLOCK_SYNC_BYTES);
        return this._clockSyncBits;
    },

    get FRAME_START_BITS() {
        if (!this._frameStartBits) this._frameStartBits = utils.bytesToBits(this.FRAME_START_BYTES);
        return this._frameStartBits;
    },

    // Combined 64-bit sync header bits (clock + FSW)
    get SYNC_HEADER_BITS() {
        if (!this._syncHeaderBits) {
            this._syncHeaderBits = new Uint8Array([...this.CLOCK_SYNC_BITS, ...this.FRAME_START_BITS]);
        }
        return this._syncHeaderBits;
    },

    MAX_PAYLOAD_SIZE: 28, // bytes per packet (reduced to keep packets short = fewer error chances)

    // ─── FLAGS ─────────────────────────────────────────────────────────────────
    FLAG_LAST:        0x01,
    FLAG_RETRANSMIT:  0x02,

    // ─── Encoding ──────────────────────────────────────────────────────────────

    /**
     * Encode a text message into a sequence of transmission bit arrays.
     * Each element in the returned array is one fully framed, FEC-encoded,
     * differentially-encoded packet ready for the FSK encoder.
     *
     * @param {string} message
     * @returns {Uint8Array[]} array of bit arrays, one per packet
     */
    encodeMessage: function(message) {
        const bytes = utils.stringToBytes(message);
        const totalPackets = Math.ceil(bytes.length / this.MAX_PAYLOAD_SIZE);
        const packetBitArrays = [];

        for (let i = 0; i < totalPackets; i++) {
            const start = i * this.MAX_PAYLOAD_SIZE;
            const payload = bytes.slice(start, start + this.MAX_PAYLOAD_SIZE);
            const flags = (i === totalPackets - 1) ? this.FLAG_LAST : 0;
            const bits = this._buildPacketBits(i, totalPackets, flags, payload);
            packetBitArrays.push(bits);
        }
        return packetBitArrays;
    },

    /**
     * Build the complete bit stream for one packet:
     *   sync_header | hamming(header + payload + crc32) | differentially_encoded
     */
    _buildPacketBits: function(index, total, flags, payload) {
        // 1. Build raw packet bytes: [index, total, flags, length, ...payload, crc32×4]
        const header = new Uint8Array([index, total, flags, payload.length]);
        const dataToCrc = new Uint8Array([...header, ...payload]);
        const crc = utils.crc32(dataToCrc);
        const crcBytes = utils.crc32ToBytes(crc);
        const rawPacket = new Uint8Array([...header, ...payload, ...crcBytes]);

        // 2. Apply Hamming(7,4) FEC — corrects all single-bit errors per byte
        const fecEncoded = utils.hammingEncode(rawPacket);

        // 3. Convert to bits
        const dataBits = utils.bytesToBits(fecEncoded);

        // 4. Prepend sync header (not FEC encoded — it's specifically designed for pattern detection)
        const fullBits = new Uint8Array(this.SYNC_HEADER_BITS.length + dataBits.length);
        fullBits.set(this.SYNC_HEADER_BITS, 0);
        fullBits.set(dataBits, this.SYNC_HEADER_BITS.length);

        // 5. Apply differential encoding to the ENTIRE stream (including sync header)
        return this._differentialEncode(fullBits);
    },

    /**
     * Differential encoding: output[0] = input[0], output[i] = input[i] XOR output[i-1]
     * On the receiver side, the inverse is: decoded[i] = received[i] XOR received[i-1]
     * This makes the bitstream robust to single-polarity phase inversions.
     */
    _differentialEncode: function(bits) {
        const out = new Uint8Array(bits.length);
        out[0] = bits[0];
        for (let i = 1; i < bits.length; i++) {
            out[i] = bits[i] ^ out[i - 1];
        }
        return out;
    },

    // ─── Decoding ──────────────────────────────────────────────────────────────

    /**
     * StreamDecoder: receives a continuous stream of raw decoded bits
     * and extracts, validates, and reconstructs packets.
     *
     * State machine:
     *   HUNTING → SYNCED → HEADER_READ → PAYLOAD_READ → VALIDATE
     */
    StreamDecoder: class {
        constructor() {
            // Circular bit buffer — fixed allocation to avoid GC pressure
            this.BUF_SIZE = 8192;
            this.bitBuffer = new Uint8Array(this.BUF_SIZE);
            this.writePos = 0;
            this.readPos = 0;
            this.bufferedBits = 0;

            // Differential decode state
            this.lastRawBit = 0;

            // Packet store keyed by index, values are Uint8Array payloads
            this.receivedPackets = new Map();
            this.totalPackets = -1;
            this.seenPacketIds = new Set(); // duplicate detection

            // Noise floor for adaptive SNR estimation
            this.recentMagnitudes = new Float32Array(64);
            this.magIdx = 0;

            // Callbacks
            this.onProgress = null;
            this.onComplete = null;
            this.onSignalUpdate = null; // (snr, noiseFloor) => void

            // Preamble pattern for fast search
            this.syncHeader = utils.bytesToBits(
                new Uint8Array([0xAA, 0xAA, 0xAA, 0xAA, 0x16, 0xF3, 0xA5, 0xC8])
            );
            // Differentially encode the sync header for comparison
            // (because all bits on wire are differentially encoded)
            this.syncHeaderEncoded = this._differentialEncode(this.syncHeader);

            // State
            this.syncFound = false;
            this.syncBitPos = 0; // where the sync header ended in buffer
        }

        _differentialEncode(bits) {
            const out = new Uint8Array(bits.length);
            out[0] = bits[0];
            for (let i = 1; i < bits.length; i++) out[i] = bits[i] ^ out[i - 1];
            return out;
        }

        /**
         * Push a raw FSK-decoded bit (0 or 1) and magnitude into the stream.
         * Differential decoding is performed here, before buffering.
         */
        pushBit(rawBit, magnitude) {
            // Update noise floor tracking
            this.recentMagnitudes[this.magIdx % 64] = magnitude;
            this.magIdx++;

            // Differential decode
            const bit = rawBit ^ this.lastRawBit;
            this.lastRawBit = rawBit;

            // Write to circular buffer
            this.bitBuffer[this.writePos % this.BUF_SIZE] = bit;
            this.writePos++;
            this.bufferedBits = Math.min(this.bufferedBits + 1, this.BUF_SIZE);

            this._tryDecode();
        }

        _getBit(absPos) {
            return this.bitBuffer[absPos % this.BUF_SIZE];
        }

        /**
         * Try to find and extract packets from the buffer.
         * Uses a sliding window search for the 64-bit sync header.
         */
        _tryDecode() {
            const syncLen = this.syncHeaderEncoded.length; // 64 bits

            // We need at least sync header + minimum packet to act
            // Minimum FEC-encoded packet: (4+1+4)×2 bytes = 18 bytes = 144 bits
            const minPacketBits = syncLen + 144;
            if (this.bufferedBits < minPacketBits) return;

            const searchStart = this.writePos - this.bufferedBits;
            const searchEnd = this.writePos - minPacketBits;

            for (let pos = searchStart; pos <= searchEnd; pos++) {
                // Check if sync header matches at this position
                if (!this._matchSyncAt(pos)) continue;

                // Sync found! Parse packet starting after sync header.
                const packetStart = pos + syncLen;
                const result = this._tryParsePacket(packetStart);

                if (result === null) {
                    // Not enough data yet — stop searching and wait
                    break;
                }
                if (result === false) {
                    // Invalid packet (CRC fail) — continue sliding
                    continue;
                }

                // Valid packet parsed. Advance read pointer past this packet.
                const bitsConsumed = (packetStart - searchStart) + result.bitsConsumed;
                this.bufferedBits -= bitsConsumed;

                // Store packet
                this._storePacket(result);
                return; // restart search from new position
            }

            // Trim old bits to keep buffer from growing indefinitely
            // Keep the last (syncLen + min packet) bits in case sync spans a boundary
            const keepBits = minPacketBits;
            if (this.bufferedBits > keepBits + 256) {
                const discard = this.bufferedBits - keepBits;
                this.bufferedBits -= discard;
            }
        }

        /**
         * Check whether the encoded sync header matches at buffer position `pos`.
         * Uses early-exit for performance.
         */
        _matchSyncAt(pos) {
            const h = this.syncHeaderEncoded;
            for (let i = 0; i < h.length; i++) {
                if (this._getBit(pos + i) !== h[i]) return false;
            }
            return true;
        }

        /**
         * Attempt to parse a packet starting at buffer bit position `packetStart`.
         * Returns:
         *   null  — not enough data yet (wait for more bits)
         *   false — data present but CRC invalid (bad packet, skip)
         *   {index, total, flags, payload, bitsConsumed} — valid packet
         */
        _tryParsePacket(packetStart) {
            // Each byte of the raw packet is 2 Hamming-encoded bytes = 16 bits on wire.
            // Minimum raw packet: 4 (header) + 1 (min payload) + 4 (crc32) = 9 raw bytes
            // → 18 FEC bytes → 144 bits
            // But we read the header first (4 raw bytes = 8 FEC bytes = 64 bits)

            const bitsAvail = this.writePos - packetStart;

            // Header: 4 raw bytes → 8 FEC bytes → 64 bits
            const headerFecBits = 4 * 2 * 8;
            if (bitsAvail < headerFecBits) return null;

            const headerFecBytes = this._readBytes(packetStart, 8);
            const headerResult = utils.hammingDecode(headerFecBytes);
            const headerBytes = headerResult.data;

            const index = headerBytes[0];
            const total = headerBytes[1];
            const flags = headerBytes[2];
            const length = headerBytes[3];

            // Sanity checks on header values
            if (total === 0 || total > 255 || index >= total ||
                length === 0 || length > protocol.MAX_PAYLOAD_SIZE) {
                return false;
            }

            // Payload: `length` raw bytes → `length*2` FEC bytes → `length*16` bits
            // CRC-32: 4 raw bytes → 8 FEC bytes → 64 bits
            const payloadFecBits = length * 2 * 8;
            const crcFecBits = 4 * 2 * 8;
            const totalBitsNeeded = headerFecBits + payloadFecBits + crcFecBits;

            if (bitsAvail < totalBitsNeeded) return null;

            // Read payload FEC bytes
            const payloadFecBytes = this._readBytes(packetStart + headerFecBits, length * 2);
            const payloadResult = utils.hammingDecode(payloadFecBytes);
            const payload = payloadResult.data;

            // Read CRC FEC bytes
            const crcFecBytes = this._readBytes(packetStart + headerFecBits + payloadFecBits, 8);
            const crcResult = utils.hammingDecode(crcFecBytes);
            const crcBytes = crcResult.data;

            // Verify CRC-32
            const dataToCrc = new Uint8Array([...headerBytes, ...payload]);
            const computedCrc = utils.crc32(dataToCrc);
            const receivedCrc = utils.bytesToCrc32(crcBytes, 0);

            if (computedCrc !== receivedCrc) return false;

            return {
                index, total, flags, payload,
                bitsConsumed: totalBitsNeeded,
                correctedBits: headerResult.corrected + payloadResult.corrected + crcResult.corrected
            };
        }

        /**
         * Read `byteCount` bytes from the circular buffer starting at bit position `bitPos`.
         * Each byte is extracted from 8 consecutive bits.
         */
        _readBytes(bitPos, byteCount) {
            const out = new Uint8Array(byteCount);
            for (let i = 0; i < byteCount; i++) {
                let b = 0;
                for (let j = 0; j < 8; j++) {
                    b = (b << 1) | this._getBit(bitPos + i * 8 + j);
                }
                out[i] = b;
            }
            return out;
        }

        /**
         * Store a valid decoded packet, trigger progress/complete callbacks.
         */
        _storePacket(result) {
            const { index, total, payload } = result;

            this.totalPackets = total;

            // Duplicate detection
            if (this.seenPacketIds.has(index)) return;
            this.seenPacketIds.add(index);
            this.receivedPackets.set(index, payload);

            // SNR estimation
            const mags = this.recentMagnitudes;
            const sortedMags = [...mags].filter(v => v > 0).sort((a, b) => a - b);
            let snrEstimate = '--';
            if (sortedMags.length > 8) {
                const noise = sortedMags[Math.floor(sortedMags.length * 0.1)];
                const signal = sortedMags[Math.floor(sortedMags.length * 0.9)];
                const snrDb = noise > 0 ? Math.round(20 * Math.log10(signal / noise)) : 0;
                snrEstimate = `${snrDb} dB`;
                if (this.onSignalUpdate) this.onSignalUpdate(snrEstimate, noise);
            }

            if (this.onProgress) {
                this.onProgress(this.receivedPackets.size, total, snrEstimate, result.correctedBits);
            }

            if (this.receivedPackets.size === total) {
                this._reconstructMessage();
            }
        }

        _reconstructMessage() {
            let fullBytes = [];
            for (let i = 0; i < this.totalPackets; i++) {
                const p = this.receivedPackets.get(i);
                if (p) fullBytes.push(...p);
            }
            const message = utils.bytesToString(fullBytes);
            if (this.onComplete) this.onComplete(message);
            this.reset();
        }

        reset() {
            this.writePos = 0;
            this.readPos = 0;
            this.bufferedBits = 0;
            this.lastRawBit = 0;
            this.receivedPackets.clear();
            this.seenPacketIds.clear();
            this.totalPackets = -1;
            this.syncFound = false;
        }
    }
};
