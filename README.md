# SonicLink v2

**Communicate Through Sound.**

SonicLink is a fully offline, browser-based application that transmits text messages between nearby devices using only their speakers and microphones. No Internet, Bluetooth, or Wi-Fi required.

---

## v2 Protocol Engineering

### Modulation: Differential Binary FSK (DBFSK)

Instead of absolute FSK where a '1' = markFreq and '0' = spaceFreq, v2 uses **differential encoding**: a frequency *change* represents a '1', and *no change* represents a '0'. This eliminates sensitivity to phase reference errors and makes the system robust to partial clock slips.

### Synchronization: 64-bit Two-Stage Header

| Part | Bytes | Purpose |
|---|---|---|
| Clock Sync | `0xAAAAAAAA` (32 bits) | Alternating pattern for clock recovery |
| Frame Start Word | `0x16F3A5C8` (32 bits) | Unique marker — statistically impossible from noise |

The probability of environmental noise producing this exact 64-bit pattern by chance is 1 in 2⁶⁴ ≈ 1.8 × 10¹⁹. This eliminates false positives entirely.

### Error Correction: CRC-32 + Hamming(7,4) FEC

| Layer | Coverage | Effect |
|---|---|---|
| CRC-32 (IEEE 802.3) | Entire packet | Detects all 1, 2, 3-bit errors; detects 99.99% of burst errors |
| Hamming(7,4) FEC | Every byte | **Corrects** any 1-bit error per byte automatically — no retransmit needed |

### Packet Structure (pre-FEC)

```
[INDEX 1B][TOTAL 1B][FLAGS 1B][LENGTH 1B][PAYLOAD 1-28B][CRC32 4B]
```

After Hamming encoding, every byte doubles to 2 bytes → on-wire packet is ~2× the size but automatically self-correcting.

### Receiver: FFT-Based Sliding Window Detector

Instead of the previous block-by-block Goertzel approach (which failed when bit boundaries fell mid-block), v2 uses:

1. **AnalyserNode FFT** with size tuned to frequency resolution of `freqSep / 4`
2. **Adaptive noise floor** estimated continuously from nearby bins
3. **8 dB SNR threshold** — only emits bits when signal is clearly above noise
4. **4× oversampling + majority voting** — 4 sub-bit samples voted before bit decision
5. **Edge-aligned clock recovery** — transitions reset clock phase; mid-bit sampling is automatic

### Audio Processing Chain

```
Mic → Highpass(400Hz) → Lowpass(2.5×maxFreq) → Gain(30×) → Compressor(AGC) → AnalyserNode
```

---

## Usage

1. Open `index.html` on two devices (Chrome/Edge recommended).
2. On **Device A**: click **SEND**, select a mode, type a message, press **START TRANSMISSION**.
3. On **Device B**: click **RECEIVE**, select the **same mode**, allow microphone access.
4. Device B will display SNR, Quality, Packets received, FEC corrections, Noise floor, and Frequency band in real time.

### Mode Reference

| Mode | Baud | Mark Hz | Space Hz | Best For |
|---|---|---|---|---|
| Reliable | 30 | 1600 | 900 | Noisy rooms, >2m distance |
| Standard | 60 | 2400 | 1200 | Normal indoor use |
| Fast | 100 | 3800 | 2200 | Quiet environments, <1m |
| Stealth | 40 | 18500 | 17000 | Near-ultrasonic, device-dependent |

---

## Requirements

- Chrome 74+ or Edge 79+ (Web Audio API, AnalyserNode)
- Microphone permission
- No internet connection required
