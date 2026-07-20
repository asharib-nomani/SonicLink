/**
 * audio.js — SonicLink v2 Audio Pipeline Manager
 *
 * SIGNAL PROCESSING CHAIN:
 *
 *  RECEIVE CHAIN:
 *    Mic → MediaStreamSource
 *         → BiquadFilter (highpass 400Hz, eliminates rumble)
 *         → BiquadFilter (lowpass 20kHz, eliminates aliasing)
 *         → GainNode (30x amplification for long-range sensitivity)
 *         → DynamicsCompressor (AGC: normalizes near and far signals)
 *         → AnalyserNode (FFT source for FSKDecoder)
 *
 *  SEND CHAIN:
 *    AudioBufferSource → AnalyserNode → destination
 *
 * DESIGN NOTES:
 *   • Highpass at 400Hz removes air conditioning rumble, body noise,
 *     and low-frequency mic self-noise without affecting FSK tones (≥800Hz).
 *   • 30x gain (≈29.5dB) compensates for 3–5m distance attenuation.
 *     At 1m a phone plays roughly 70 dBSPL; at 3m this drops 10dB.
 *     A 30x gain recovers ~30dB, allowing the system to decode from much further.
 *   • DynamicsCompressor prevents the 30x gain from clipping close-range signals.
 *     Threshold: –24dBFS, Ratio: 16:1, fast attack (1ms), moderate release (100ms).
 *   • The AnalyserNode connects to destination with zero gain via a GainNode(0)
 *     to prevent acoustic echo (the decoded mic signal playing through speakers).
 */

const audioManager = {
    audioCtx: null,

    // Send chain
    sendAnalyser: null,

    // Receive chain nodes
    micStream: null,
    micSource: null,
    hpFilter: null,     // highpass filter
    lpFilter: null,     // lowpass filter
    micGain: null,      // amplification
    compressor: null,   // AGC / limiter
    receiveAnalyser: null,
    silentGain: null,   // connects analyser to destination with 0 gain (required by some browsers)

    // Channel quality estimation
    noiseLevel: -100, // dBFS
    lastSnrDb: 0,

    /**
     * Initialize the AudioContext and send chain.
     */
    initContext: function() {
        if (this.audioCtx) {
            if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
            return;
        }
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new Ctx({ latencyHint: 'interactive' });

        // Send visualizer analyser
        this.sendAnalyser = this.audioCtx.createAnalyser();
        this.sendAnalyser.fftSize = 2048;
        this.sendAnalyser.connect(this.audioCtx.destination);
    },

    /**
     * Play an AudioBuffer and call onEnded when done.
     */
    playBuffer: function(buffer, onEnded) {
        this.initContext();
        const src = this.audioCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.sendAnalyser);
        src.onended = () => { if (onEnded) onEnded(); };
        src.start(0);
        return src;
    },

    /**
     * Request microphone access and set up the receive signal chain.
     * @param {Object} config — { markFreq, spaceFreq } — used to tune filters
     * @returns {Promise<boolean>}
     */
    requestMicrophone: async function(config) {
        this.initContext();

        if (!this.micStream) {
            try {
                this.micStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: false, // MUST be off — echo canceller destroys FSK tones
                        noiseSuppression: false, // MUST be off — noise suppressor kills quiet signals
                        autoGainControl: false   // MUST be off — we control gain manually
                    }
                });
            } catch (err) {
                console.error('Mic access denied:', err);
                return false;
            }
        }

        this._buildReceiveChain(config);
        return true;
    },

    /**
     * Rebuild the receive DSP chain for a given mode config.
     * Safe to call multiple times (tears down previous chain first).
     */
    _buildReceiveChain: function(config) {
        // Tear down existing chain
        this._teardownReceiveChain();

        const ctx = this.audioCtx;
        const sampleRate = ctx.sampleRate;

        // Mic source
        this.micSource = ctx.createMediaStreamSource(this.micStream);

        // 1. Highpass — cut everything below 400Hz (rumble, voice fundamentals)
        this.hpFilter = ctx.createBiquadFilter();
        this.hpFilter.type = 'highpass';
        this.hpFilter.frequency.value = 400;
        this.hpFilter.Q.value = 0.707; // Butterworth response

        // 2. Lowpass — cut everything above 20kHz (unless stealth mode)
        this.lpFilter = ctx.createBiquadFilter();
        this.lpFilter.type = 'lowpass';
        const lpCutoff = Math.max(config.markFreq, config.spaceFreq) * 2.5;
        this.lpFilter.frequency.value = Math.min(lpCutoff, sampleRate / 2 - 100);
        this.lpFilter.Q.value = 0.707;

        // 3. Gain — 30x amplification for range extension
        this.micGain = ctx.createGain();
        this.micGain.gain.value = 30.0;

        // 4. Dynamics Compressor — prevents clipping from the 30x gain for close-range
        this.compressor = ctx.createDynamicsCompressor();
        this.compressor.threshold.value = -24;
        this.compressor.knee.value = 12;
        this.compressor.ratio.value = 16;
        this.compressor.attack.value = 0.001; // 1ms fast attack
        this.compressor.release.value = 0.1;  // 100ms release

        // 5. AnalyserNode — FFT source for the decoder
        this.receiveAnalyser = ctx.createAnalyser();
        // FFT size set by decoder based on baud rate

        // 6. Silent gain node (gain=0) — connects analyser to destination
        // Required in some browsers for the analyser to receive data without
        // the decoded mic audio playing through speakers (acoustic echo)
        this.silentGain = ctx.createGain();
        this.silentGain.gain.value = 0;

        // Wire up the chain
        this.micSource.connect(this.hpFilter);
        this.hpFilter.connect(this.lpFilter);
        this.lpFilter.connect(this.micGain);
        this.micGain.connect(this.compressor);
        this.compressor.connect(this.receiveAnalyser);
        this.receiveAnalyser.connect(this.silentGain);
        this.silentGain.connect(ctx.destination);
    },

    _teardownReceiveChain: function() {
        const nodes = [this.micSource, this.hpFilter, this.lpFilter,
                       this.micGain, this.compressor, this.receiveAnalyser, this.silentGain];
        for (const n of nodes) {
            if (n) { try { n.disconnect(); } catch(e) {} }
        }
        this.micSource = this.hpFilter = this.lpFilter = this.micGain =
            this.compressor = this.receiveAnalyser = this.silentGain = null;
    },

    /**
     * Stop microphone and tear down receive chain.
     */
    stopMicrophone: function() {
        this._teardownReceiveChain();
        if (this.micStream) {
            this.micStream.getTracks().forEach(t => t.stop());
            this.micStream = null;
        }
    },

    /**
     * Measure ambient noise level (dBFS RMS over 1 second).
     * Used for environment calibration and mode recommendation.
     * @returns {Promise<number>} noise level in dBFS
     */
    measureNoiseLevel: function() {
        return new Promise(async (resolve) => {
            const success = await this.requestMicrophone({ markFreq: 2000, spaceFreq: 1000 });
            if (!success) { resolve(-100); return; }

            // Wait for analyser to fill
            await new Promise(r => setTimeout(r, 300));

            const analyser = this.receiveAnalyser;
            if (!analyser) { resolve(-100); return; }
            const data = new Uint8Array(analyser.fftSize);
            analyser.getByteTimeDomainData(data);

            let sum = 0;
            for (let i = 0; i < data.length; i++) {
                const s = (data[i] - 128) / 128;
                sum += s * s;
            }
            const rms = Math.sqrt(sum / data.length);
            const dbfs = rms > 0 ? 20 * Math.log10(rms) : -100;
            this.noiseLevel = dbfs;
            resolve(dbfs);
        });
    }
};
