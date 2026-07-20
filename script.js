/**
 * script.js
 * Main application logic, AI integration, and mode configurations
 */

const MODES = {
    standard: { baudRate: 100, markFreq: 2400, spaceFreq: 1200 }, // 1200Hz sep
    fast:     { baudRate: 200, markFreq: 4000, spaceFreq: 2000 }, // 2000Hz sep, lowered to 200 baud for safety
    reliable: { baudRate: 50,  markFreq: 1500, spaceFreq: 1000 }, // 500Hz sep
    stealth:  { baudRate: 100, markFreq: 19000, spaceFreq: 17500 } // 1500Hz sep
};

const app = {
    decoderInstance: null,
    streamDecoder: new protocol.StreamDecoder(),
    isTransmitting: false,

    startTransmission: async function() {
        if (this.isTransmitting) return;

        const message = document.getElementById('message-input').value;
        if (!message) {
            alert('Please enter a message to send.');
            return;
        }

        const modeKey = document.getElementById('send-mode').value;
        const config = MODES[modeKey];

        this.isTransmitting = true;
        document.getElementById('btn-transmit').innerText = 'TRANSMITTING...';
        document.getElementById('btn-transmit').disabled = true;

        ui.updateSendStatus(config.baudRate, '0');

        // Frame data
        const packetsBits = protocol.encodeMessage(message);
        
        // Flatten packets with a small pause (silence bits) between packets for reliability
        const PAUSE_BITS = 10;
        let transmissionBits = [];
        
        // WAKE UP SYNC sequence to help receiver lock onto the clock before preamble
        transmissionBits.push(1, 0, 1, 0, 1, 0, 1, 0);

        packetsBits.forEach(p => {
            transmissionBits.push(...p);
            transmissionBits.push(...Array(PAUSE_BITS).fill(0)); 
        });

        // Ensure audio context is ready
        audioManager.initContext();

        // Generate FSK Buffer
        const audioBuffer = encoder.generateFSKBuffer(audioManager.audioCtx, transmissionBits, config);

        // Calculate time
        const durationSec = audioBuffer.duration;
        let elapsed = 0;
        
        const progressInterval = setInterval(() => {
            elapsed += 0.1;
            const pct = Math.min(100, Math.round((elapsed / durationSec) * 100));
            ui.updateSendStatus(config.baudRate, pct);
        }, 100);

        // Play
        audioManager.playBuffer(audioBuffer, () => {
            clearInterval(progressInterval);
            this.isTransmitting = false;
            document.getElementById('btn-transmit').innerText = 'START TRANSMISSION';
            document.getElementById('btn-transmit').disabled = false;
            ui.updateSendStatus(config.baudRate, '100');
        });
    },

    startReceiving: async function() {
        const modeKey = document.getElementById('receive-mode') ? document.getElementById('receive-mode').value : 'standard';
        const config = MODES[modeKey] || MODES['standard'];

        ui.resetReceiveUI();
        
        const success = await audioManager.requestMicrophone(config);
        if (!success) {
            alert("Microphone access is required to receive messages.");
            return;
        }

        if (this.decoderInstance) {
            this.decoderInstance.disconnect();
        }

        this.streamDecoder.reset();
        
        this.streamDecoder.onProgress = (received, total) => {
            ui.updateReceiveStatus('Strong', 'Good', `${received}/${total}`);
        };
        
        this.streamDecoder.onComplete = (message) => {
            ui.showReceivedMessage(message);
        };

        this.decoderInstance = new FSKDecoder(audioManager.audioCtx, config, (bit, magnitude) => {
            // Only push bits if signal is strong enough, otherwise push 0 (silence)
            // Magnitude threshold handling is inside FSKDecoder, so it only calls us on valid bits
            this.streamDecoder.pushBit(bit);
        });

        this.decoderInstance.connect(audioManager.getReceiveSource());
    },

    stopReceiving: function() {
        if (this.decoderInstance) {
            this.decoderInstance.disconnect();
            this.decoderInstance = null;
        }
        audioManager.stopMicrophone();
    }
};
