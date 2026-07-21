/**
 * script.js — SonicLink v2 Application Controller
 *
 * MODE CONFIGURATION
 * ──────────────────
 * Each mode defines:
 *   baudRate  — symbols per second. Lower = more robust to echoes (echoes last ~20ms indoors).
 *   markFreq  — frequency for bit '1' (Hz)
 *   spaceFreq — frequency for bit '0' (Hz)
 *   freqSep   — separation between mark and space (Hz). Must be >> baudRate for clean Goertzel.
 *
 * FREQUENCY SELECTION RATIONALE:
 *   • All tones are in 800–5000Hz — the range where virtually all phone speakers
 *     and microphones have flat, reliable response.
 *   • We avoid < 800Hz (mic low-frequency noise) and > 5000Hz (speaker roll-off).
 *   • Frequency separation ≥ 10× baudRate ensures the FFT bins for mark and space
 *     do not overlap, giving clean discrimination.
 *
 * STEALTH MODE:
 *   Uses 17000–18500Hz. Works on most laptops and some phones.
 *   Not ultra-reliable on all hardware — users are warned.
 */

const MODES = {
    reliable: {
        baudRate: 30,
        markFreq: 1600,
        spaceFreq: 900,
        label: 'Reliable',
        description: 'Most robust — works over 3m, noisy environments'
    },
    standard: {
        baudRate: 60,
        markFreq: 2400,
        spaceFreq: 1200,
        label: 'Standard',
        description: 'Balanced speed and reliability'
    },
    fast: {
        baudRate: 100,
        markFreq: 3800,
        spaceFreq: 2200,
        label: 'Fast',
        description: 'Quick transfer, quieter environments'
    },
    stealth: {
        baudRate: 40,
        markFreq: 18500,
        spaceFreq: 17000,
        label: 'Stealth',
        description: 'Near-ultrasonic — device dependent'
    }
};

const app = {
    decoderInstance: null,
    streamDecoder: null,
    isTransmitting: false,
    isReceiving: false,

    init: function () {
        this.streamDecoder = new protocol.StreamDecoder();
    },

    // ─── TRANSMISSION ──────────────────────────────────────────────────────────

    startTransmission: async function () {
        if (this.isTransmitting) return;

        const message = document.getElementById('message-input').value.trim();
        if (!message) {
            alert('Please enter a message to send.');
            return;
        }

        const modeKey = document.getElementById('send-mode').value;
        const config = MODES[modeKey];

        this.isTransmitting = true;
        const btn = document.getElementById('btn-transmit');
        btn.innerText = 'TRANSMITTING...';
        btn.disabled = true;

        ui.updateSendStatus(config.baudRate, 0);

        // Initialize AudioContext on user gesture (required by browsers)
        audioManager.initContext();

        // Encode message into packet bit arrays
        const packetBitArrays = protocol.encodeMessage(message);
        const totalPackets = packetBitArrays.length;

        // Generate the complete FSK audio buffer
        const audioBuffer = encoder.generateTransmissionBuffer(
            audioManager.audioCtx, packetBitArrays, config
        );

        const durationSec = audioBuffer.duration;
        const startTime = Date.now();

        const progressInterval = setInterval(() => {
            const elapsed = (Date.now() - startTime) / 1000;
            const pct = Math.min(100, Math.round((elapsed / durationSec) * 100));
            ui.updateSendStatus(config.baudRate, pct);
        }, 100);

        audioManager.playBuffer(audioBuffer, () => {
            clearInterval(progressInterval);
            this.isTransmitting = false;
            btn.innerText = 'START TRANSMISSION';
            btn.disabled = false;
            ui.updateSendStatus(config.baudRate, 100);
        });
    },

    // ─── RECEIVING ─────────────────────────────────────────────────────────────

    startReceiving: async function () {
        // Stop any existing decode session
        this._stopDecoderInstance();

        const modeKey = document.getElementById('receive-mode')?.value || 'standard';
        const config = MODES[modeKey] || MODES.standard;

        ui.resetReceiveUI();
        ui.updateChannelInfo(config);

        const success = await audioManager.requestMicrophone(config);
        if (!success) {
            alert('Microphone access is required to receive messages. Please allow access and try again.');
            return;
        }

        this.isReceiving = true;

        // Reset stream decoder
        this.streamDecoder.reset();

        // Wire up progress callbacks
        this.streamDecoder.onProgress = (received, total, snr, correctedBits) => {
            const quality = this._snrToQuality(snr);
            ui.updateReceiveStatus(snr, quality, `${received}/${total}`, correctedBits);
        };

        this.streamDecoder.onComplete = (message) => {
            ui.showReceivedMessage(message);
        };

        this.streamDecoder.onSignalUpdate = (snrStr, noiseFloor) => {
            ui.updateNoiseDisplay(noiseFloor);
        };

        // Create FFT-based decoder
        this.decoderInstance = new FSKDecoder(
            audioManager.audioCtx,
            audioManager.receiveAnalyser,
            config,
            (bit, snr) => {
                this.streamDecoder.pushBit(bit, snr);
            }
        );

        this.decoderInstance.start();
    },

    stopReceiving: function () {
        this.isReceiving = false;
        this._stopDecoderInstance();
        audioManager.stopMicrophone();
    },

    _stopDecoderInstance: function () {
        if (this.decoderInstance) {
            this.decoderInstance.stop();
            this.decoderInstance = null;
        }
    },

    // ─── HELPERS ────────────────────────────────────

    _snrToQuality: function (snr) {
        if (typeof snr === 'string' && snr.includes('dB')) {
            const val = parseFloat(snr);
            if (val >= 20) return '🟢 Excellent';
            if (val >= 12) return '🟡 Good';
            if (val >= 8) return '🟠 Fair';
            return '🔴 Poor';
        }
        return '--';
    }
};

// ─── Boot ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    app.init();

    // Character counter
    const input = document.getElementById('message-input');
    if (input) {
        input.addEventListener('input', () => ui.updateCharCount(input.value.length));
    }
});
