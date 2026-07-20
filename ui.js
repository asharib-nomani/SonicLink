/**
 * ui.js
 * Handles DOM manipulation, screen transitions, and canvas visualizers
 */

const ui = {
    currentScreen: 'screen-home',
    visualizerAnimationIds: {},

    navigateTo: function(screenId) {
        document.getElementById(this.currentScreen).classList.remove('active');
        document.getElementById(screenId).classList.add('active');
        this.currentScreen = screenId;

        // Handle specific screen logic
        if (screenId === 'screen-receive') {
            app.startReceiving();
            this.startVisualizer('receive-visualizer', audioManager.receiveAnalyser, '#00ff9d');
        } else {
            app.stopReceiving();
            this.stopVisualizer('receive-visualizer');
        }

        if (screenId === 'screen-send') {
            this.startVisualizer('send-visualizer', audioManager.sendAnalyser, '#00f3ff');
        } else {
            this.stopVisualizer('send-visualizer');
        }
    },

    updateCharCount: function(count) {
        document.getElementById('char-current').innerText = count;
    },

    updateSendStatus: function(speed, progress) {
        document.getElementById('send-speed').innerText = speed;
        document.getElementById('send-progress').innerText = `${progress}%`;
    },

    updateReceiveStatus: function(signal, quality, packets) {
        document.getElementById('receive-signal').innerText = signal;
        document.getElementById('receive-quality').innerText = quality;
        document.getElementById('receive-packets').innerText = packets;
    },

    showReceivedMessage: function(message) {
        document.getElementById('received-message').innerText = message;
        document.getElementById('receive-status').innerText = 'Message Received!';
        document.getElementById('receive-status').classList.remove('status-pulse');
        document.getElementById('receive-status').style.color = 'var(--success)';
    },

    resetReceiveUI: function() {
        document.getElementById('received-message').innerText = 'Waiting for transmission...';
        document.getElementById('receive-status').innerText = 'Listening...';
        document.getElementById('receive-status').classList.add('status-pulse');
        document.getElementById('receive-status').style.color = '';
        this.updateReceiveStatus('--', '--', '0');
    },

    copyReceivedMessage: function() {
        const text = document.getElementById('received-message').innerText;
        navigator.clipboard.writeText(text).then(() => {
            alert('Message copied to clipboard!');
        });
    },

    downloadReceivedMessage: function() {
        const text = document.getElementById('received-message').innerText;
        const blob = new Blob([text], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'soniclink_message.txt';
        a.click();
    },

    startVisualizer: function(canvasId, analyser, color) {
        if (!analyser) return;
        
        const canvas = document.getElementById(canvasId);
        const canvasCtx = canvas.getContext('2d');
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        // Fix canvas scaling for high DPI displays
        const rect = canvas.parentNode.getBoundingClientRect();
        canvas.width = rect.width * window.devicePixelRatio;
        canvas.height = rect.height * window.devicePixelRatio;
        canvasCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
        
        const draw = () => {
            this.visualizerAnimationIds[canvasId] = requestAnimationFrame(draw);

            analyser.getByteTimeDomainData(dataArray);

            canvasCtx.fillStyle = 'rgba(0, 0, 0, 0.2)';
            canvasCtx.fillRect(0, 0, rect.width, rect.height);

            canvasCtx.lineWidth = 2;
            canvasCtx.strokeStyle = color;
            canvasCtx.beginPath();

            const sliceWidth = rect.width * 1.0 / bufferLength;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                const v = dataArray[i] / 128.0;
                const y = v * rect.height / 2;

                if (i === 0) {
                    canvasCtx.moveTo(x, y);
                } else {
                    canvasCtx.lineTo(x, y);
                }
                x += sliceWidth;
            }

            canvasCtx.lineTo(rect.width, rect.height / 2);
            canvasCtx.stroke();
            
            // Add a glow effect
            canvasCtx.shadowBlur = 10;
            canvasCtx.shadowColor = color;
            canvasCtx.stroke();
            canvasCtx.shadowBlur = 0;
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

// Character count listener
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('message-input');
    if(input) {
        input.addEventListener('input', () => {
            ui.updateCharCount(input.value.length);
        });
    }
});
