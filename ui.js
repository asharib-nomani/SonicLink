/**
 * ui.js — SonicLink v2 UI Controller
 *
 * ADDITIONS:
 * • updateChannelInfo — shows current frequency band and baud rate in receive screen
 * • updateNoiseDisplay — shows adaptive noise floor estimate
 * • updateCharCount and all existing callbacks preserved
 * • Spectrum visualizer now uses frequency domain data (getByteFrequencyData)
 *   instead of time domain, giving a much clearer picture of the signal.
 */

const ui = {
    currentScreen: 'screen-home',
    visualizerAnimationIds: {},

    navigateTo: function(screenId) {
        document.getElementById(this.currentScreen).classList.remove('active');
        document.getElementById(screenId).classList.add('active');
        this.currentScreen = screenId;

        if (screenId === 'screen-receive') {
            // Initialize audio context on user gesture before requesting mic
            audioManager.initContext();
            app.startReceiving();
            // Delay visualizer start until analyser is built
            setTimeout(() => {
                if (audioManager.receiveAnalyser) {
                    this.startSpectrumVisualizer('receive-visualizer', audioManager.receiveAnalyser, '#00ff9d');
                }
            }, 500);
        } else {
            app.stopReceiving();
            this.stopVisualizer('receive-visualizer');
        }

        if (screenId === 'screen-send') {
            audioManager.initContext();
            this.startWaveformVisualizer('send-visualizer', audioManager.sendAnalyser, '#00f3ff');
        } else {
            this.stopVisualizer('send-visualizer');
        }
    },

    updateCharCount: function(count) {
        const el = document.getElementById('char-current');
        if (el) el.innerText = count;
    },

    updateSendStatus: function(baudRate, progress) {
        const s = document.getElementById('send-speed');
        const p = document.getElementById('send-progress');
        if (s) s.innerText = baudRate;
        if (p) p.innerText = `${progress}%`;
    },

    updateReceiveStatus: function(snr, quality, packets, correctedBits) {
        const sigEl  = document.getElementById('receive-signal');
        const qualEl = document.getElementById('receive-quality');
        const pktEl  = document.getElementById('receive-packets');
        const corEl  = document.getElementById('receive-corrected');
        if (sigEl)  sigEl.innerText  = snr || '--';
        if (qualEl) qualEl.innerText = quality || '--';
        if (pktEl)  pktEl.innerText  = packets || '0';
        if (corEl)  corEl.innerText  = correctedBits > 0 ? `${correctedBits} bits fixed` : '✓ Clean';
    },

    updateNoiseDisplay: function(noiseFloor) {
        const el = document.getElementById('receive-noise');
        if (!el) return;
        const db = typeof noiseFloor === 'number' ? noiseFloor.toFixed(1) : '--';
        el.innerText = `${db} dBFS`;
    },

    updateChannelInfo: function(config) {
        const el = document.getElementById('receive-freqband');
        if (el) el.innerText = `${config.markFreq}/${config.spaceFreq} Hz @ ${config.baudRate} baud`;
    },

    showReceivedMessage: function(message) {
        const el = document.getElementById('received-message');
        const st = document.getElementById('receive-status');
        if (el) el.innerText = message;
        if (st) {
            st.innerText = '✅ Message Received!';
            st.classList.remove('status-pulse');
            st.style.color = 'var(--success)';
        }
    },

    resetReceiveUI: function() {
        const el = document.getElementById('received-message');
        const st = document.getElementById('receive-status');
        if (el) el.innerText = 'Waiting for transmission...';
        if (st) {
            st.innerText = 'Listening...';
            st.classList.add('status-pulse');
            st.style.color = '';
        }
        this.updateReceiveStatus('--', '--', '0', 0);
        this.updateNoiseDisplay(null);
    },

    copyReceivedMessage: function() {
        const text = document.getElementById('received-message')?.innerText || '';
        navigator.clipboard.writeText(text).then(() => alert('Copied to clipboard!'));
    },

    downloadReceivedMessage: function() {
        const text = document.getElementById('received-message')?.innerText || '';
        const blob = new Blob([text], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'soniclink_message.txt';
        a.click();
    },

    // ─── Spectrum Visualizer (Frequency Domain) ────────────────────────────────
    // Shows the live frequency spectrum, so you can visually confirm the FSK
    // tones are being received. Much more informative than the waveform view.

    startSpectrumVisualizer: function(canvasId, analyser, color) {
        if (!analyser) return;
        this.stopVisualizer(canvasId);

        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        const resize = () => {
            const rect = canvas.parentNode.getBoundingClientRect();
            canvas.width  = rect.width  * (window.devicePixelRatio || 1);
            canvas.height = rect.height * (window.devicePixelRatio || 1);
            ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
        };
        resize();

        const bufLen = analyser.frequencyBinCount;
        const freqData = new Uint8Array(bufLen);

        const draw = () => {
            this.visualizerAnimationIds[canvasId] = requestAnimationFrame(draw);
            analyser.getByteFrequencyData(freqData);

            const W = canvas.width  / (window.devicePixelRatio || 1);
            const H = canvas.height / (window.devicePixelRatio || 1);

            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.fillRect(0, 0, W, H);

            const barWidth = (W / bufLen) * 2.5;
            let x = 0;
            for (let i = 0; i < bufLen; i++) {
                const barH = (freqData[i] / 255) * H;
                // Color bars by intensity
                const hue = 180 + (freqData[i] / 255) * 60;
                ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;
                ctx.fillRect(x, H - barH, barWidth - 1, barH);
                x += barWidth;
                if (x > W) break;
            }
        };
        draw();
    },

    // ─── Waveform Visualizer (Time Domain) ─────────────────────────────────────

    startWaveformVisualizer: function(canvasId, analyser, color) {
        if (!analyser) return;
        this.stopVisualizer(canvasId);

        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        const rect = canvas.parentNode.getBoundingClientRect();
        canvas.width  = rect.width  * (window.devicePixelRatio || 1);
        canvas.height = rect.height * (window.devicePixelRatio || 1);
        ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

        const W = rect.width;
        const H = rect.height;
        const bufLen = analyser.frequencyBinCount;
        const timeData = new Uint8Array(bufLen);

        const draw = () => {
            this.visualizerAnimationIds[canvasId] = requestAnimationFrame(draw);
            analyser.getByteTimeDomainData(timeData);

            ctx.fillStyle = 'rgba(0,0,0,0.2)';
            ctx.fillRect(0, 0, W, H);

            ctx.lineWidth = 2;
            ctx.strokeStyle = color;
            ctx.shadowBlur = 8;
            ctx.shadowColor = color;
            ctx.beginPath();

            const sliceW = W / bufLen;
            let x = 0;
            for (let i = 0; i < bufLen; i++) {
                const v = timeData[i] / 128.0;
                const y = (v * H) / 2;
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                x += sliceW;
            }
            ctx.lineTo(W, H / 2);
            ctx.stroke();
            ctx.shadowBlur = 0;
        };
        draw();
    },

    stopVisualizer: function(canvasId) {
        if (this.visualizerAnimationIds[canvasId]) {
            cancelAnimationFrame(this.visualizerAnimationIds[canvasId]);
            delete this.visualizerAnimationIds[canvasId];
        }
    }
};
