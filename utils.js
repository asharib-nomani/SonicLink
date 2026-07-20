/**
 * utils.js
 * Utility functions for SonicLink
 */

const utils = {
    /**
     * Convert a string to an array of bytes
     */
    stringToBytes: function(str) {
        const encoder = new TextEncoder();
        return encoder.encode(str);
    },

    /**
     * Convert an array of bytes back to a string
     */
    bytesToString: function(bytes) {
        const decoder = new TextDecoder();
        return decoder.decode(new Uint8Array(bytes));
    },

    /**
     * Calculate an 8-bit CRC for a given byte array
     * using the polynomial 0x31 (x^8 + x^5 + x^4 + 1, Dallas/Maxim)
     */
    crc8: function(bytes) {
        let crc = 0x00;
        for (let i = 0; i < bytes.length; i++) {
            crc ^= bytes[i];
            for (let j = 0; j < 8; j++) {
                if ((crc & 0x80) !== 0) {
                    crc = ((crc << 1) ^ 0x31) & 0xFF;
                } else {
                    crc = (crc << 1) & 0xFF;
                }
            }
        }
        return crc;
    },

    /**
     * Convert a byte array to an array of bits (0s and 1s)
     * MSB first
     */
    bytesToBits: function(bytes) {
        const bits = [];
        for (let i = 0; i < bytes.length; i++) {
            for (let j = 7; j >= 0; j--) {
                bits.push((bytes[i] >> j) & 1);
            }
        }
        return bits;
    },

    /**
     * Convert an array of bits back to a byte array
     */
    bitsToBytes: function(bits) {
        const bytes = [];
        for (let i = 0; i < bits.length; i += 8) {
            let byte = 0;
            for (let j = 0; j < 8; j++) {
                if (i + j < bits.length && bits[i + j] === 1) {
                    byte |= (1 << (7 - j));
                }
            }
            bytes.push(byte);
        }
        return bytes;
    },

    /**
     * Simple throttle function
     */
    throttle: function(func, limit) {
        let inThrottle;
        return function() {
            const args = arguments;
            const context = this;
            if (!inThrottle) {
                func.apply(context, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        }
    }
};
