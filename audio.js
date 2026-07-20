/**
 * audio.js
 * Manages Web Audio API, microphone permissions, and connections
 */

const audioManager = {
    audioCtx: null,
    micStream: null,
    micSource: null,
    highpassFilter: null,
    gainNode: null,
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
        if (this.highpassFilter) this.highpassFilter.disconnect();
        if (this.gainNode) this.gainNode.disconnect();
        if (this.compressor) this.compressor.disconnect();

        // 1. Highpass filter to eliminate low-frequency room rumble (< 600Hz)
        this.highpassFilter = this.audioCtx.createBiquadFilter();
        this.highpassFilter.type = 'highpass';
        this.highpassFilter.frequency.value = 600;

        // 2. Gain Node to heavily amplify the signal for long range
        this.gainNode = this.audioCtx.createGain();
        this.gainNode.gain.value = 30.0; // 30x boost

        // 3. Dynamics Compressor acting as a limiter (prevents clipping/distortion for close range)
        this.compressor = this.audioCtx.createDynamicsCompressor();
        this.compressor.threshold.value = -24; // start compressing early
        this.compressor.knee.value = 30;
        this.compressor.ratio.value = 12;
        this.compressor.attack.value = 0.003;
        this.compressor.release.value = 0.08;

        // Connect: Mic -> Highpass -> Gain -> Compressor -> ReceiveAnalyser
        this.micSource.connect(this.highpassFilter);
        this.highpassFilter.connect(this.gainNode);
        this.gainNode.connect(this.compressor);
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
        if (this.highpassFilter) {
            this.highpassFilter.disconnect();
            this.highpassFilter = null;
        }
        if (this.gainNode) {
            this.gainNode.disconnect();
            this.gainNode = null;
        }
        if (this.compressor) {
            this.compressor.disconnect();
            this.compressor = null;
        }
    }
};
