/**
 * audio.js
 * Manages Web Audio API, microphone permissions, and connections
 */

const audioManager = {
    audioCtx: null,
    micStream: null,
    micSource: null,
    
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

    requestMicrophone: async function() {
        this.initContext();
        if (this.micStream) return true;

        try {
            this.micStream = await navigator.mediaDevices.getUserMedia({ 
                audio: { 
                    echoCancellation: false, 
                    noiseSuppression: false, 
                    autoGainControl: false 
                } 
            });
            this.micSource = this.audioCtx.createMediaStreamSource(this.micStream);
            this.micSource.connect(this.receiveAnalyser);
            return true;
        } catch (err) {
            console.error("Microphone access denied:", err);
            return false;
        }
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
    }
};
