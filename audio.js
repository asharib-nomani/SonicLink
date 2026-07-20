/**
 * audio.js
 * Manages Web Audio API, microphone permissions, and connections
 */

const audioManager = {
    audioCtx: null,
    micStream: null,
    micSource: null,
    bandpassFilter: null,
    compressor: null,
    
    // For visualizer
    sendAnalyser: null,
    receiveAnalyser: null,

    initContext: function() {
        if (!this.audioCtx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.audioCtx = new AudioContext();
            
            // Setup analysers for visualizers
            this.sendAnalyser = this.audioCtx.createAnalyser();
            this.sendAnalyser.fftSize = 2048;
            this.sendAnalyser.connect(this.audioCtx.destination);
            
            this.receiveAnalyser = this.audioCtx.createAnalyser();
            this.receiveAnalyser.fftSize = 2048;
        }
        
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
    },

    playBuffer: function(buffer, onEnded) {
        this.initContext();
        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.sendAnalyser);
        
        source.onended = () => {
            if (onEnded) onEnded();
        };
        
        source.start(0);
        return source;
    },

    requestMicrophone: async function(config) {
        this.initContext();
        if (this.micStream) {
            // Already have stream, just reconfigure filters
            this.setupFilters(config);
            return true;
        }

        try {
            this.micStream = await navigator.mediaDevices.getUserMedia({ 
                audio: { 
                    echoCancellation: false, 
                    noiseSuppression: false, // Keep native NS off as it mangles continuous tones
                    autoGainControl: false 
                } 
            });
            this.micSource = this.audioCtx.createMediaStreamSource(this.micStream);
            this.setupFilters(config);
            return true;
        } catch (err) {
            console.error("Microphone access denied:", err);
            return false;
        }
    },

    setupFilters: function(config) {
        // Disconnect previous if any
        if (this.bandpassFilter) this.bandpassFilter.disconnect();
        if (this.compressor) this.compressor.disconnect();

        // 1. Bandpass filter to isolate the signal frequencies and drop background noise
        this.bandpassFilter = this.audioCtx.createBiquadFilter();
        this.bandpassFilter.type = 'bandpass';
        // Center frequency
        this.bandpassFilter.frequency.value = (config.markFreq + config.spaceFreq) / 2;
        // Q factor (sharpness). Q = CenterFreq / Bandwidth.
        const bandwidth = Math.abs(config.markFreq - config.spaceFreq) * 1.5; 
        this.bandpassFilter.Q.value = this.bandpassFilter.frequency.value / bandwidth;

        // 2. Dynamics Compressor to act as Automatic Gain Control (AGC) for distant signals
        this.compressor = this.audioCtx.createDynamicsCompressor();
        this.compressor.threshold.value = -50; // Catch very faint signals
        this.compressor.knee.value = 40;
        this.compressor.ratio.value = 12; // Heavy compression to boost quiet parts
        this.compressor.attack.value = 0;
        this.compressor.release.value = 0.25;

        // Connect: Mic -> Bandpass -> Compressor -> ReceiveAnalyser
        this.micSource.connect(this.bandpassFilter);
        this.bandpassFilter.connect(this.compressor);
        this.compressor.connect(this.receiveAnalyser);
    },

    getReceiveSource: function() {
        // Return the final stage of the input pipeline before the analyser
        return this.compressor || this.micSource;
    },

    stopMicrophone: function() {
        if (this.micStream) {
            this.micStream.getTracks().forEach(track => track.stop());
            this.micStream = null;
        }
        if (this.micSource) {
            this.micSource.disconnect();
            this.micSource = null;
        }
        if (this.bandpassFilter) {
            this.bandpassFilter.disconnect();
            this.bandpassFilter = null;
        }
        if (this.compressor) {
            this.compressor.disconnect();
            this.compressor = null;
        }
    }
};
