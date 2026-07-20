# SonicLink

**Communicate Through Sound.**

SonicLink is a browser-based application that allows two nearby devices to exchange text messages using only their speakers and microphones. No Internet, Bluetooth, or Wi-Fi required.

## Features
- **Acoustic Transmission**: Uses Frequency Shift Keying (FSK) to encode text into sound waves.
- **Error Correction**: Custom packet framing with CRC8 checksums ensures reliable delivery.
- **Multiple Modes**: Support for Standard, Fast, Reliable, Stealth (near-ultrasonic), and Fun frequencies.
- **Glassmorphism UI**: Beautiful, modern dark theme with neon accents and real-time canvas visualizers.

## Usage
1. Open `index.html` in a modern web browser on two devices.
2. On Device A, click **SEND**. Enter your message, select a transmission mode, and click **START TRANSMISSION**.
3. On Device B, click **RECEIVE**. Allow microphone access when prompted. The device will listen for the transmission and decode the message in real time.

## Architecture
- `protocol.js`: Handles packet creation, framing, and decoding from a bitstream.
- `encoder.js`: Generates an AudioBuffer using the Web Audio API to play FSK signals.
- `decoder.js`: Real-time audio analysis using `ScriptProcessorNode` and the Goertzel algorithm to detect frequencies.
- `audio.js`: Manages the AudioContext and microphone permissions.
- `ui.js`: DOM manipulation, canvas visualizations, and UI state.
- `script.js`: Main application logic coordinating the transmission process and AI features.

## Note on Stealth Mode
Stealth mode operates at 18kHz - 18.5kHz. Depending on your hardware, your device's speakers or microphone might filter out these frequencies. If Stealth mode fails, fallback to Standard or Reliable mode.
