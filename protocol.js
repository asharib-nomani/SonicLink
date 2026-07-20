/**
 * protocol.js
 * Defines the acoustic transmission protocol, packet framing, and reconstruction.
 */

const protocol = {
    // 16-bit Preamble for synchronization: 10101010 11001100 (0xAA 0xCC)
    PREAMBLE_BYTES: [0xAA, 0xCC],
    PREAMBLE_BITS: [1,0,1,0,1,0,1,0, 1,1,0,0,1,1,0,0],

    MAX_PAYLOAD_SIZE: 32, // bytes per packet

    /**
     * Frame a message into a series of packet bits.
     * @param {string} message The text message to send
     * @returns {Array<Array<number>>} Array of packet bit arrays
     */
    encodeMessage: function(message) {
        const bytes = utils.stringToBytes(message);
        const packets = [];
        const totalPackets = Math.ceil(bytes.length / this.MAX_PAYLOAD_SIZE);

        for (let i = 0; i < totalPackets; i++) {
            const start = i * this.MAX_PAYLOAD_SIZE;
            const end = Math.min(start + this.MAX_PAYLOAD_SIZE, bytes.length);
            const payload = bytes.slice(start, end);

            const packetBytes = this.createPacket(i, totalPackets, payload);
            packets.push(utils.bytesToBits(packetBytes));
        }

        return packets;
    },

    /**
     * Create a single packet
     * Header: Preamble (2 bytes)
     * Meta: Packet Index (1 byte), Total Packets (1 byte), Payload Length (1 byte)
     * Payload: (N bytes)
     * Checksum: CRC8 of Meta + Payload (1 byte)
     */
    createPacket: function(index, total, payload) {
        const meta = [index, total, payload.length];
        const dataToCrc = [...meta, ...payload];
        const crc = utils.crc8(dataToCrc);

        return [...this.PREAMBLE_BYTES, ...meta, ...payload, crc];
    },

    /**
     * Scan a continuous stream of bits to find packets
     */
    StreamDecoder: class {
        constructor() {
            this.bitBuffer = [];
            this.receivedPackets = new Map(); // index -> payload bytes
            this.totalPackets = -1;
            this.onProgress = null;
            this.onComplete = null;
        }

        pushBit(bit) {
            this.bitBuffer.push(bit);
            this.checkBuffer();
        }

        checkBuffer() {
            // Keep buffer from growing infinitely (e.g. max ~1000 bits)
            if (this.bitBuffer.length > 2000) {
                this.bitBuffer.splice(0, 1000);
            }

            // Look for preamble
            const preambleLen = protocol.PREAMBLE_BITS.length;
            if (this.bitBuffer.length < preambleLen) return;

            // Search from end backwards to find latest preamble
            for (let i = 0; i <= this.bitBuffer.length - preambleLen; i++) {
                let match = true;
                for (let j = 0; j < preambleLen; j++) {
                    if (this.bitBuffer[i + j] !== protocol.PREAMBLE_BITS[j]) {
                        match = false;
                        break;
                    }
                }

                if (match) {
                    // Preamble found! Let's see if we have enough bits for a header
                    // Header is 3 bytes (index, total, length) = 24 bits
                    if (this.bitBuffer.length >= i + preambleLen + 24) {
                        const headerBits = this.bitBuffer.slice(i + preambleLen, i + preambleLen + 24);
                        const headerBytes = utils.bitsToBytes(headerBits);
                        const index = headerBytes[0];
                        const total = headerBytes[1];
                        const length = headerBytes[2];

                        // Sanity check
                        if (length > protocol.MAX_PAYLOAD_SIZE || length === 0 || total === 0) {
                            continue; // invalid header, ignore this preamble
                        }

                        const totalPacketBits = preambleLen + 24 + (length * 8) + 8; // preamble + header + payload + crc
                        if (this.bitBuffer.length >= i + totalPacketBits) {
                            // We have the full packet!
                            const packetBits = this.bitBuffer.slice(i + preambleLen, i + totalPacketBits);
                            const packetBytes = utils.bitsToBytes(packetBits);
                            
                            // CRC check
                            const dataToCrc = packetBytes.slice(0, 3 + length);
                            const receivedCrc = packetBytes[3 + length];
                            const calculatedCrc = utils.crc8(dataToCrc);

                            if (receivedCrc === calculatedCrc) {
                                // Valid packet!
                                const payload = packetBytes.slice(3, 3 + length);
                                this.receivedPackets.set(index, payload);
                                this.totalPackets = total;

                                // Report progress
                                if (this.onProgress) {
                                    this.onProgress(this.receivedPackets.size, this.totalPackets);
                                }

                                // Check if complete
                                if (this.receivedPackets.size === this.totalPackets) {
                                    this.reconstructMessage();
                                }

                                // Remove this packet from buffer
                                this.bitBuffer.splice(0, i + totalPacketBits);
                                return; // check again on next push
                            } else {
                                // Invalid CRC, skip this preamble but keep buffer
                                // console.log("CRC error");
                            }
                        }
                    }
                }
            }
        }

        reconstructMessage() {
            let fullBytes = [];
            for (let i = 0; i < this.totalPackets; i++) {
                const payload = this.receivedPackets.get(i);
                if (payload) {
                    fullBytes.push(...payload);
                }
            }
            
            const message = utils.bytesToString(fullBytes);
            if (this.onComplete) {
                this.onComplete(message);
            }
            
            // Reset state
            this.receivedPackets.clear();
            this.totalPackets = -1;
        }

        reset() {
            this.bitBuffer = [];
            this.receivedPackets.clear();
            this.totalPackets = -1;
        }
    }
};
