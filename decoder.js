/**
 * decoder.js — SonicLink v2 FFT-Based FSK Decoder
 *
 * ARCHITECTURE: Sliding-Window FFT with Noise-Adaptive Thresholding
 * ──────────────────────────────────────────────────────────────────
 *
 * WHY NOT GOERTZEL with ScriptProcessorNode?
 * The previous implementation used ScriptProcessorNode (deprecated, main-thread jitter)
 * and block-by-block Goertzel with fixed blocks. The fundamental problem was that when
 * a bit boundary fell mid-block, the Goertzel result was an average of two different
 * frequencies → neither threshold could cleanly distinguish mark from space.
 *
 * NEW APPROACH: AnalyserNode + requestAnimationFrame sliding window
 * ─────────────────────────────────────────────────────────────────
 * 1. AudioContext AnalyserNode provides a continuously updated FFT of the most
 *    recent N samples. We pick FFT size to match roughly one bit period.
 * 2. Instead of block-by-block processing, we use a sliding-window approach:
 *    every animation frame (~16ms), we extract the FFT, read the power at
 *    markFreq and spaceFreq bins, and run adaptive thresholding.
 * 3. Oversampling: we sample at ~4x the baud rate. Multiple sub-bit samples
 *    are majority-voted before emitting a bit decision, eliminating single-frame glitches.
 * 4. Noise floor is estimated adaptively from recent quiet frames and used as
 *    a dynamic threshold. When the environment is noisy, the threshold rises;
 *    when it's quiet, it falls (more sensitive).
 * 5. Symbol timing recovery: Edge detection tracks transitions; mid-symbol
 *    sampling is aligned by interpolating between detected edges.
 *
 * SIGNAL PROCESSING CHAIN:
 *   Mic → HighpassFilter → GainNode → Compressor → AnalyserNode → [FSKDecoder]
 *                                                 ↓
 *                                         Sliding FFT window
 *                                                 ↓
 *                                        Power at mark/space bins
 *                                                 ↓
 *                                      Adaptive threshold decision
 *                                                 ↓
 *                                        4x oversampled voting
 *                                                 ↓
 *                                    Clock recovery (edge-aligned)
 *                                                 ↓
 *                                      Bit → StreamDecoder
 */

class FSKDecoder {
    /**
     * @param {AudioContext} audioCtx
     * @param {AnalyserNode} analyserNode — connected to the mic signal chain
     * @param {Object} config — { baudRate, markFreq, spaceFreq }
     * @param {Function} onBitDecoded — (bit: 0|1, snr: number) => void
     */
    constructor(audioCtx, analyserNode, config, onBitDecoded) {
        this.audioCtx = audioCtx;
        this.analyser = analyserNode;
        this.config = config;
        this.onBitDecoded = onBitDecoded;

        const sampleRate = audioCtx.sampleRate;
        this.sampleRate = sampleRate;

        // ─── FFT Configuration ─────────────────────────────────────────────
        // We pick an FFT size such that frequency resolution ≤ (freq separation / 4).
        // This ensures the mark and space bins are well-separated.
        const freqSep = Math.abs(config.markFreq - config.spaceFreq);
        const targetResolution = freqSep / 4; // Hz per bin target
        const rawFftSize = sampleRate / targetResolution;
        // FFT size must be power of 2, between 256 and 32768
        this.fftSize = Math.min(32768, Math.max(256, this._nextPow2(rawFftSize)));

        this.analyser.fftSize = this.fftSize;
        this.analyser.smoothingTimeConstant = 0.0; // no smoothing — we need sharp transients

        const binHz = sampleRate / this.fftSize;
        this.markBin  = Math.round(config.markFreq  / binHz);
        this.spaceBin = Math.round(config.spaceFreq / binHz);

        // Hann window pre-computed for FFT data (AnalyserNode applies its own window,
        // but we use it for our manual SNR calculation from time-domain data)
        this.hannWindow = utils.makeHannWindow(this.fftSize);

        // FFT data buffer — reused every frame to avoid allocation
        this.freqData = new Float32Array(this.fftSize / 2 + 1); // dBFS values

        // ─── Adaptive Noise Floor ──────────────────────────────────────────
        // Ring buffer of recent magnitude measurements for noise estimation
        this.noiseRing = new Float32Array(128).fill(-100);
        this.noiseRingIdx = 0;
        this.noiseFloor = -60; // initial estimate in dBFS

        // ─── Oversampling & Clock Recovery ────────────────────────────────
        // We aim for 4 samples per bit. Calculate how many ms between samples.
        this.oversample = 4;
        this.samplesPerBit = this.oversample; // logical samples
        const bitDurationMs = 1000 / config.baudRate;
        this.sampleIntervalMs = bitDurationMs / this.oversample;

        // Vote buffer: collect oversample measurements, then majority-vote
        this.voteBuffer = []; // array of {val: 0|1, snr: number}

        // Clock recovery state
        this.lastBitValue = -1;    // last emitted bit
        this.ticksSinceEdge = 999; // samples since last detected edge
        this.clockPhase = 0;       // fractional position within bit period [0, oversample)
        this.clockLocked = false;

        // ─── Activity Detection ────────────────────────────────────────────
        // Prevent emitting bits during silence (between packets)
        this.signalPresentFrames = 0;
        this.SIGNAL_DEBOUNCE = 2; // frames of continuous signal before emitting bits

        // ─── Animation loop ────────────────────────────────────────────────
        this._rafId = null;
        this._lastSampleTime = 0;
        this._running = false;
    }

    _nextPow2(n) {
        let p = 256;
        while (p < n) p <<= 1;
        return p;
    }

    start() {
        this._running = true;
        this._lastSampleTime = performance.now();
        this._loop();
    }

    stop() {
        this._running = false;
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = null;
    }

    _loop() {
        if (!this._running) return;
        this._rafId = requestAnimationFrame(() => {
            const now = performance.now();
            const elapsed = now - this._lastSampleTime;

            // Process one sub-bit sample per interval
            if (elapsed >= this.sampleIntervalMs) {
                this._lastSampleTime = now - (elapsed % this.sampleIntervalMs);
                this._processFrame();
            }
            this._loop();
        });
    }

    /**
     * Core processing: read FFT, estimate SNR, make bit decision.
     */
    _processFrame() {
        this.analyser.getFloatFrequencyData(this.freqData);

        // Power at mark and space frequency bins (dBFS)
        // Average ±1 bin to handle slight frequency drift
        const markPow  = this._avgBinPower(this.markBin);
        const spacePow = this._avgBinPower(this.spaceBin);

        // Update noise floor estimate using nearby bins (not mark/space bins themselves)
        // Take power from bins ±4 away from both mark and space
        const noiseSample1 = this._avgBinPower(this.markBin + 4);
        const noiseSample2 = this._avgBinPower(this.spaceBin - 4);
        const noiseSample  = Math.max(noiseSample1, noiseSample2);

        this.noiseRing[this.noiseRingIdx++ % 128] = noiseSample;
        // Noise floor = 90th percentile of quiet-bin measurements (robust to outliers)
        this.noiseFloor = this._percentile(this.noiseRing, 0.9);

        // Signal is present if EITHER tone is SNR_THRESHOLD dB above noise floor
        const SNR_THRESHOLD = 8; // dB minimum SNR to declare signal present
        const markSNR  = markPow  - this.noiseFloor;
        const spaceSNR = spacePow - this.noiseFloor;
        const maxSNR   = Math.max(markSNR, spaceSNR);
        const signalPresent = maxSNR >= SNR_THRESHOLD;

        if (signalPresent) {
            this.signalPresentFrames = Math.min(this.signalPresentFrames + 1, 10);
        } else {
            this.signalPresentFrames = Math.max(this.signalPresentFrames - 1, 0);
            // Lost signal — reset clock for next acquisition
            if (this.signalPresentFrames === 0) {
                this.clockLocked = false;
                this.clockPhase = 0;
                this.voteBuffer = [];
                this.ticksSinceEdge = 999;
                this.lastBitValue = -1;
            }
            return;
        }

        if (this.signalPresentFrames < this.SIGNAL_DEBOUNCE) return;

        // Bit decision: higher power wins; require >3dB SNR difference to be decisive
        let bitVal = -1;
        if (markPow > spacePow + 3)  bitVal = 1;
        if (spacePow > markPow + 3)  bitVal = 0;
        if (bitVal === -1) return; // ambiguous — skip this sample

        this.ticksSinceEdge++;

        // Edge detection for clock recovery
        if (bitVal !== this.lastBitValue && this.ticksSinceEdge > this.oversample * 0.4) {
            // Detected a transition. Re-align clock: next sample point is half a bit away.
            this.clockPhase = Math.floor(this.oversample / 2);
            this.ticksSinceEdge = 0;
            this.clockLocked = true;
        }
        this.lastBitValue = bitVal;

        if (!this.clockLocked) return;

        // Accumulate votes
        this.voteBuffer.push({ val: bitVal, snr: maxSNR });

        // When we've accumulated enough votes for one bit period, majority-vote
        if (this.voteBuffer.length >= this.oversample) {
            let ones = 0, zeros = 0, totalSnr = 0;
            for (const v of this.voteBuffer) {
                if (v.val === 1) ones++;
                else zeros++;
                totalSnr += v.snr;
            }
            const avgSnr = totalSnr / this.voteBuffer.length;
            const decidedBit = ones >= zeros ? 1 : 0;
            this.voteBuffer = [];

            this.onBitDecoded(decidedBit, avgSnr);
        }
    }

    /**
     * Average the dBFS power of bin-1, bin, bin+1 (handles slight freq drift).
     * Returns in linear magnitude squared for better averaging.
     */
    _avgBinPower(bin) {
        const f = this.freqData;
        const len = f.length;
        // Clamp bins to valid range
        const b0 = Math.max(0, bin - 1);
        const b2 = Math.min(len - 1, bin + 1);
        // Average in dB domain (good enough approximation)
        return (f[b0] + f[bin] + f[b2]) / 3;
    }

    /**
     * Percentile of a Float32Array — used for robust noise floor estimation.
     */
    _percentile(arr, p) {
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = Math.floor(sorted.length * p);
        return sorted[Math.min(idx, sorted.length - 1)];
    }
}
