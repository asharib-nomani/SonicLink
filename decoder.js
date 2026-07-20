/**
 * decoder.js
 * Decodes FSK audio from the microphone with oversampling and edge detection
 */

class FSKDecoder {
    constructor(audioCtx, config, onBitReceived) {
        this.audioCtx = audioCtx;
        this.config = config;
        this.onBitReceived = onBitReceived;
        
        // Oversample by 4x to allow for clock recovery / edge alignment
        this.oversampleFactor = 4;
        this.samplesPerTick = Math.floor(this.audioCtx.sampleRate / (this.config.baudRate * this.oversampleFactor));
        
        // Using ScriptProcessor for real-time audio analysis
        const bufferSize = 2048; 
        this.processor = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);
        
        this.sampleBuffer = [];
        this.processor.onaudioprocess = this.onAudioProcess.bind(this);

        // Precompute Goertzel constants
        this.markOmega = (2 * Math.PI * this.config.markFreq) / this.audioCtx.sampleRate;
        this.spaceOmega = (2 * Math.PI * this.config.spaceFreq) / this.audioCtx.sampleRate;
        this.markCoeff = 2 * Math.cos(this.markOmega);
        this.spaceCoeff = 2 * Math.cos(this.spaceOmega);

        // UART / Clock recovery state
        this.lastTickBit = -1;
        this.tickCounter = 0;
        this.ticksSinceLastEdge = 99;
    }

    connect(source) {
        source.connect(this.processor);
        this.processor.connect(this.audioCtx.destination);
    }

    disconnect() {
        this.processor.disconnect();
    }

    onAudioProcess(event) {
        const inputData = event.inputBuffer.getChannelData(0);

        for (let i = 0; i < inputData.length; i++) {
            this.sampleBuffer.push(inputData[i]);

            if (this.sampleBuffer.length >= this.samplesPerTick) {
                this.analyzeTick(this.sampleBuffer);
                this.sampleBuffer = [];
            }
        }
    }

    analyzeTick(samples) {
        let q1Mark = 0, q2Mark = 0;
        let q1Space = 0, q2Space = 0;

        for (let i = 0; i < samples.length; i++) {
            const x = samples[i];
            
            const q0Mark = this.markCoeff * q1Mark - q2Mark + x;
            q2Mark = q1Mark;
            q1Mark = q0Mark;

            const q0Space = this.spaceCoeff * q1Space - q2Space + x;
            q2Space = q1Space;
            q1Space = q0Space;
        }

        let markMag = Math.sqrt(q1Mark*q1Mark + q2Mark*q2Mark - q1Mark*q2Mark*this.markCoeff);
        let spaceMag = Math.sqrt(q1Space*q1Space + q2Space*q2Space - q1Space*q2Space*this.spaceCoeff);

        // Normalize by sample length so threshold is independent of baud rate
        markMag = markMag / samples.length;
        spaceMag = spaceMag / samples.length;

        // Dynamic thresholding
        // A full scale sine wave has normalized magnitude 0.5. 
        // 0.005 allows detection of signals at ~1% volume.
        const noiseFloor = 0.005; 
        let currentTickBit = -1; // -1 means no signal

        if (markMag > noiseFloor || spaceMag > noiseFloor) {
            // Require a distinct difference to avoid noise toggling
            if (markMag > spaceMag * 1.2) {
                currentTickBit = 1;
            } else if (spaceMag > markMag * 1.2) {
                currentTickBit = 0;
            }
        }

        // Clock recovery / edge detection
        if (currentTickBit !== -1) {
            this.ticksSinceLastEdge++;
            if (this.lastTickBit !== currentTickBit && this.ticksSinceLastEdge > 2) {
                // Edge detected! Align the clock.
                // We want to sample exactly half a bit-period from now.
                this.tickCounter = Math.floor(this.oversampleFactor / 2);
                this.lastTickBit = currentTickBit;
                this.ticksSinceLastEdge = 0;
            }

            this.tickCounter++;

            if (this.tickCounter >= this.oversampleFactor) {
                // We reached the center of the bit
                this.onBitReceived(currentTickBit, Math.max(markMag, spaceMag));
                this.tickCounter = 0; // Reset for next bit
            }
        } else {
            // Signal lost
            this.lastTickBit = -1;
            this.tickCounter = 0;
            this.ticksSinceLastEdge = 99;
        }
    }
}
