/**
 * encoder.js
 * Encodes binary data into FSK audio buffers
 */

const encoder = {
    /**
     * Generate an AudioBuffer containing the FSK modulated signal for the given bits
     * @param {AudioContext} audioCtx 
     * @param {Array<number>} bits 
     * @param {Object} config { baudRate, markFreq, spaceFreq }
     * @returns {AudioBuffer}
     */
    generateFSKBuffer: function(audioCtx, bits, config) {
        // Add some padding zeros (silence) at the start and end
        const paddedBits = [...Array(10).fill(0), ...bits, ...Array(10).fill(0)];
        
        const samplesPerBit = Math.floor(audioCtx.sampleRate / config.baudRate);
        const totalSamples = paddedBits.length * samplesPerBit;
        const buffer = audioCtx.createBuffer(1, totalSamples, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        
        let phase = 0;
        const twoPi = 2 * Math.PI;
        
        // Optional: apply a slight fade-in/fade-out envelope to avoid clicks
        for (let i = 0; i < paddedBits.length; i++) {
            const bit = paddedBits[i];
            const freq = bit === 1 ? config.markFreq : config.spaceFreq;
            const phaseIncrement = twoPi * freq / audioCtx.sampleRate;
            
            for (let j = 0; j < samplesPerBit; j++) {
                let sample = Math.sin(phase);
                
                // Very basic amplitude envelope on the whole transmission
                if (i === 0 && j < samplesPerBit / 2) {
                    sample *= (j / (samplesPerBit / 2)); // Fade in
                } else if (i === paddedBits.length - 1 && j > samplesPerBit / 2) {
                    sample *= (1 - ((j - samplesPerBit / 2) / (samplesPerBit / 2))); // Fade out
                }
                
                data[i * samplesPerBit + j] = sample;
                
                phase += phaseIncrement;
                if (phase >= twoPi) phase -= twoPi;
            }
        }
        
        return buffer;
    }
};
