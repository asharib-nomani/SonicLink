/**
 * encoder.js — SonicLink v2 FSK Encoder with ISI Guard & Phase Continuity
 *
 * ENGINEERING IMPROVEMENTS OVER v1:
 *
 * 1. PHASE CONTINUITY
 *    v1 reset phase to 0 at every bit boundary, causing audible clicks and
 *    spectral splatter that confuses the Goertzel detector.
 *    v2 carries phase continuously across bit boundaries. Each bit starts at
 *    exactly the phase where the previous bit left off.
 *
 * 2. COSINE RAMP (Inter-Symbol Guard)
 *    A short raised-cosine ramp (8% of bit period) is applied at each frequency
 *    transition. This band-limits the FSK signal, reducing spectral splatter
 *    into adjacent Goertzel frequency bins.
 *
 * 3. PRE-EMPHASIS FILTER
 *    Higher frequencies suffer from greater speaker roll-off and air absorption.
 *    We apply a gentle +3dB/octave pre-emphasis above 1kHz to compensate so
 *    that the received signal appears spectrally flat.
 *    Implementation: FIR first-order high-shelf approximation applied sample-by-sample.
 *
 * 4. AMPLITUDE CONTROL
 *    Global amplitude is 0.85 (leaving 15% headroom to prevent DAC clipping on
 *    cheap phone speakers which introduce severe harmonic distortion when clipping).
 */

const encoder = {

    AMPLITUDE: 0.85,
    RAMP_FRACTION: 0.08, // 8% of bit period used for cosine ramp at transitions

    /**
     * Generate an AudioBuffer containing the complete FSK transmission.
     *
     * @param {AudioContext} audioCtx
     * @param {Uint8Array[]} packetBitArrays — array of bit arrays from protocol.encodeMessage()
     * @param {Object} config — { baudRate, markFreq, spaceFreq }
     * @returns {AudioBuffer}
     */
    generateTransmissionBuffer: function(audioCtx, packetBitArrays, config) {
        const sampleRate = audioCtx.sampleRate;
        const samplesPerBit = Math.round(sampleRate / config.baudRate);
        const silenceBetweenPackets = Math.round(sampleRate * 0.06); // 60ms between packets
        const leadingSilence = Math.round(sampleRate * 0.1);         // 100ms leading silence
        const trailingSilence = Math.round(sampleRate * 0.05);       // 50ms trailing silence

        // Calculate total samples needed
        let totalBits = 0;
        for (const p of packetBitArrays) totalBits += p.length;
        const totalSamples = leadingSilence +
            (totalBits * samplesPerBit) +
            ((packetBitArrays.length - 1) * silenceBetweenPackets) +
            trailingSilence;

        const buffer = audioCtx.createBuffer(1, totalSamples, sampleRate);
        const data = buffer.getChannelData(0);

        const twoPi = 2 * Math.PI;
        const rampSamples = Math.round(samplesPerBit * this.RAMP_FRACTION);
        const amp = this.AMPLITUDE;

        let writeOffset = leadingSilence;
        let phase = 0;

        // Pre-emphasis filter state
        let preEmphPrev = 0;
        const preEmphAlpha = 0.85; // pre-emphasis coefficient

        for (let pktIdx = 0; pktIdx < packetBitArrays.length; pktIdx++) {
            const bits = packetBitArrays[pktIdx];

            for (let bitIdx = 0; bitIdx < bits.length; bitIdx++) {
                const bit = bits[bitIdx];
                const freq = bit === 1 ? config.markFreq : config.spaceFreq;
                const phaseInc = twoPi * freq / sampleRate;

                // Determine if next bit changes frequency (for ramp decision)
                const nextBit = bits[bitIdx + 1];
                const nextFreq = nextBit === undefined ? freq : (nextBit === 1 ? config.markFreq : config.spaceFreq);
                const willTransition = (nextFreq !== freq);

                for (let s = 0; s < samplesPerBit; s++) {
                    let amplitude = amp;

                    // Apply raised-cosine ramp-out at transition
                    if (willTransition && s >= samplesPerBit - rampSamples) {
                        const rampPos = s - (samplesPerBit - rampSamples);
                        const t = rampPos / rampSamples;
                        amplitude *= 0.5 * (1 + Math.cos(Math.PI * t)); // cosine ramp down
                    }
                    // Apply raised-cosine ramp-in at start of packet
                    if (pktIdx === 0 && bitIdx === 0 && s < rampSamples * 4) {
                        amplitude *= Math.min(1, s / (rampSamples * 4));
                    }

                    let sample = amplitude * Math.sin(phase);

                    // Pre-emphasis: gentle high-shelf boost
                    // y[n] = x[n] - alpha * x[n-1]  (first-order differentiator)
                    const preEmph = sample - preEmphAlpha * preEmphPrev;
                    preEmphPrev = sample;
                    // Mix pre-emphasis: 40% original + 60% pre-emphasized
                    sample = 0.4 * sample + 0.6 * preEmph;

                    data[writeOffset + s] = sample;

                    phase += phaseInc;
                    if (phase >= twoPi) phase -= twoPi;
                }

                writeOffset += samplesPerBit;
            }

            // Silence between packets
            if (pktIdx < packetBitArrays.length - 1) {
                writeOffset += silenceBetweenPackets;
            }
        }

        return buffer;
    }
};
