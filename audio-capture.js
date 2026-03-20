// Script injetado no contexto da página do Google Meet
// Responsável por:
//  - Obter MediaStream da aba usando streamId (tab capture)
//  - Processar áudio com AudioContext (downmix mono, resample p/ 16k ou 44.1k)
//  - Enviar frames (20ms) como Int16 via WebSocket para o backend

(function () {
	const DEFAULT_WS_URL = 'wss://backend-analysis-production-a688.up.railway.app/egress-audio';
	const DEFAULT_SAMPLE_RATE = 16000; // recomendado
	const FRAME_MS = 20; // 20ms

	// WS is proxied via content → background to avoid mixed-content
	let audioContext = null;
	let sourceNode = null;
	let workletNode = null;
	let gainNode = null;
	let inputStream = null;
	let allowProcessorFallback = true;
	let fallbackArmed = false;
	let lastFrameAt = 0;
	let bytesSent = 0;
	let _tabId = null;
	// Inline worklet module code (avoids cross-origin/CSP fetch issues)
	const WORKLET_INLINE_CODE = [
		'class MonoCaptureProcessor extends AudioWorkletProcessor {',
		'  constructor(){ super(); this._processCount = 0; }',
		'  process(inputs){',
		'    this._processCount++;',
		'    if (this._processCount <= 3) {',
		'      console.log("[worklet-processor] process called", { count: this._processCount, inputsLen: inputs?.length });',
		'    }',
		'    const input = inputs && inputs[0];',
		'    if (!input || input.length === 0) {',
		'      if (this._processCount <= 3) console.log("[worklet-processor] no input");',
		'      return true;',
		'    }',
		'    const channels = input.length;',
		'    const len = input[0]?.length || 0;',
		'    if (len === 0) {',
		'      if (this._processCount <= 3) console.log("[worklet-processor] empty input");',
		'      return true;',
		'    }',
		'    if (this._processCount <= 3) {',
		'      console.log("[worklet-processor] processing", { channels, len });',
		'    }',
		'    const mono = new Float32Array(len);',
		'    for (let ch = 0; ch < channels; ch++){',
		'      const chData = input[ch];',
		'      for (let i = 0; i < len; i++){ mono[i] += chData[i]; }',
		'    }',
		'    if (channels > 1){ for (let i = 0; i < len; i++) mono[i] /= channels; }',
		'    this.port.postMessage(mono.buffer, [mono.buffer]);',
		'    return true;',
		'  }',
		'}',
		'registerProcessor("mono-capture", MonoCaptureProcessor);'
	].join('\n');

	function openWebSocket(url) {
		console.log('[audio-capture] Opening WebSocket to:', url, { tabId: _tabId });
		window.postMessage({ type: 'AUDIO_WS_OPEN', url, tabId: _tabId }, '*');
	}

	function sendPCM(buffer) {
		try {
			// Send as ArrayBuffer for proper structured cloning
			const ab = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
			if (bytesSent % 64000 < 1280) { // Log first few frames
				console.log('[audio-capture] sendPCM', { 
					isArrayBuffer: ab instanceof ArrayBuffer, 
					byteLength: ab.byteLength, 
					tabId: _tabId,
					bytesSent 
				});
			}
			window.postMessage({ type: 'AUDIO_WS_SEND', buffer: ab, tabId: _tabId }, '*');
		} catch (e) {
			console.error('[audio-capture] sendPCM error:', e);
		}
	}

	function floatTo16BitPCM(float32) {
		const len = float32.length;
		const out = new Int16Array(len);
		let nonZeroCount = 0;
		let maxAbs = 0;
		for (let i = 0; i < len; i++) {
			let s = float32[i];
			if (s > 1) s = 1;
			else if (s < -1) s = -1;
			out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
			if (s !== 0) nonZeroCount++;
			const abs = Math.abs(s);
			if (abs > maxAbs) maxAbs = abs;
		}
		// DEBUG: Log audio stats periodically
		if (bytesSent < 64000 && bytesSent % 6400 === 0) {
			console.log('[audio-capture] Audio stats:', { 
				len, 
				nonZeroCount, 
				maxAbs: maxAbs.toFixed(6), 
				allZeros: nonZeroCount === 0,
				bytesSent 
			});
			// Log first 20 samples
			const samples = [];
			for (let i = 0; i < Math.min(20, len); i++) {
				samples.push(out[i]);
			}
			console.log('[audio-capture] First 20 samples:', samples.join(','));
		}
		return out.buffer;
	}

	function downmixToMono(inputBuffer) {
		const numChannels = inputBuffer.numberOfChannels || 1;
		if (numChannels === 1) {
			return inputBuffer.getChannelData(0).slice(0);
		}
		const length = inputBuffer.length;
		const tmp = new Float32Array(length);
		for (let ch = 0; ch < numChannels; ch++) {
			const chData = inputBuffer.getChannelData(ch);
			for (let i = 0; i < length; i++) {
				tmp[i] += chData[i];
			}
		}
		for (let i = 0; i < length; i++) {
			tmp[i] /= numChannels;
		}
		return tmp;
	}

	function resampleFloat32(buffer, sourceRate, targetRate) {
		if (sourceRate === targetRate) return buffer;
		const ratio = sourceRate / targetRate;
		const newLength = Math.round(buffer.length / ratio);
		const result = new Float32Array(newLength);
		let offsetResult = 0;
		let offsetBuffer = 0;
		while (offsetResult < newLength) {
			const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
			let accum = 0;
			let count = 0;
			for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
				accum += buffer[i];
				count++;
			}
			result[offsetResult] = count > 0 ? accum / count : 0;
			offsetResult++;
			offsetBuffer = nextOffsetBuffer;
		}
		return result;
	}

	function startScriptProcessorFallback(actualRate, targetSampleRate, frameSamples, bufferQueueRef) {
		try {
			const processorNode = audioContext.createScriptProcessor(4096, 2, 1);
			processorNode.onaudioprocess = (event) => {
				const mono = downmixToMono(event.inputBuffer);
				const resampled = resampleFloat32(mono, actualRate, targetSampleRate);
				// concat queue
				if (bufferQueueRef.length === 0) {
					bufferQueueRef = resampled;
				} else {
					const merged = new Float32Array(bufferQueueRef.length + resampled.length);
					merged.set(bufferQueueRef, 0);
					merged.set(resampled, bufferQueueRef.length);
					bufferQueueRef = merged;
				}
				// send in frames
				let offset = 0;
				while (bufferQueueRef.length - offset >= frameSamples) {
					const frame = bufferQueueRef.subarray(offset, offset + frameSamples);
					const out = floatTo16BitPCM(frame);
					sendPCM(out);
					offset += frameSamples;
					lastFrameAt = Date.now();
					bytesSent += out.byteLength || 0;
					if (bytesSent % 64000 === 0) {
						console.log('[audio-capture] fallback bytesSent=', bytesSent);
					}
				}
				if (offset > 0) {
					bufferQueueRef = bufferQueueRef.slice(offset);
				}
			};
			sourceNode.connect(processorNode);
			processorNode.connect(gainNode);
			gainNode.connect(audioContext.destination);
		} catch (_e) {}
	}

	async function startProcessing(stream, targetSampleRate, wsUrl) {
		// Se já estiver rodando, para antes de reiniciar
		try { stopProcessing(); } catch (_e) {}

		// Tenta criar AudioContext já no sample rate alvo (pode ser ignorado pelo browser)
		try {
			audioContext = new (window.AudioContext || window.webkitAudioContext)({
				sampleRate: targetSampleRate
			});
		} catch (_e) {
			audioContext = new (window.AudioContext || window.webkitAudioContext)();
		}

		const actualRate = audioContext.sampleRate;
		const frameSamples = Math.round((targetSampleRate * FRAME_MS) / 1000);

		console.log('[audio-capture] AudioContext initial state:', audioContext.state);

		// Tenta garantir estado 'running' (alguns ambientes exigem gesto do usuário)
		try {
			if (typeof audioContext.resume === 'function') {
				if (audioContext.state === 'suspended') {
					console.log('[audio-capture] Attempting to resume AudioContext...');
					await audioContext.resume();
					console.log('[audio-capture] AudioContext resumed, new state:', audioContext.state);
				}
			}
		} catch (e) {
			console.error('[audio-capture] Failed to resume AudioContext:', e);
		}

		// Force resume again after a delay if still suspended
		if (audioContext.state !== 'running') {
			console.warn('[audio-capture] AudioContext not running, will retry in 100ms');
			setTimeout(() => {
				if (audioContext && audioContext.state === 'suspended') {
					console.log('[audio-capture] Retrying AudioContext.resume()');
					audioContext.resume().then(() => {
						console.log('[audio-capture] AudioContext resumed (delayed), state:', audioContext.state);
					}).catch(e => {
						console.error('[audio-capture] Delayed resume failed:', e);
					});
				}
			}, 100);
		}

		inputStream = stream;
		
		// DEBUG: Check if the stream has active audio tracks
		const audioTracks = stream.getAudioTracks();
		console.log('[audio-capture] Stream audio tracks:', audioTracks.map(t => ({
			id: t.id,
			label: t.label,
			enabled: t.enabled,
			readyState: t.readyState,
			muted: t.muted,
			settings: t.getSettings()
		})));
		
		// Check if the track is actually receiving audio
		if (audioTracks.length > 0) {
			const track = audioTracks[0];
			const checkTrackActivity = setInterval(() => {
				console.log('[audio-capture] Track status check:', {
					enabled: track.enabled,
					readyState: track.readyState,
					muted: track.muted
				});
			}, 1000);
			setTimeout(() => clearInterval(checkTrackActivity), 5000);
		}
		
		sourceNode = audioContext.createMediaStreamSource(stream);
		gainNode = audioContext.createGain();
		gainNode.gain.value = 0; // silencia saída

		// Monitor AudioContext state changes
		audioContext.onstatechange = () => {
			console.log('[audio-capture] AudioContext state changed to:', audioContext.state);
		};

		let bufferQueue = new Float32Array(0);

		const setupWithWorklet = async () => {
			try {
				if (!audioContext.audioWorklet) throw new Error('AudioWorklet not supported');
				let loaded = false;
				// 1) Inline blob-first to avoid scheme/CORS issues
				try {
					const blob = new Blob([WORKLET_INLINE_CODE], { type: 'application/javascript' });
					const blobUrl = URL.createObjectURL(blob);
					try {
						await audioContext.audioWorklet.addModule(blobUrl);
						loaded = true;
					} finally {
						URL.revokeObjectURL(blobUrl);
					}
				} catch (e0) {
					loaded = false;
				}
				// 2) Try packaged URL if not loaded yet (only if chrome.runtime is available)
				if (!loaded && typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
					const moduleUrl = chrome.runtime.getURL('audio-worklet-processor.js');
					try {
						await audioContext.audioWorklet.addModule(moduleUrl);
						loaded = true;
					} catch (e1) {
						// 3) Try fetch+blob of packaged file (some CSPs require it)
						try {
							const res = await fetch(moduleUrl, { cache: 'no-store' });
							if (!res.ok) throw new Error(`HTTP ${res.status}`);
							const code = await res.text();
							const blob = new Blob([code], { type: 'application/javascript' });
							const blobUrl = URL.createObjectURL(blob);
							try {
								await audioContext.audioWorklet.addModule(blobUrl);
								loaded = true;
							} finally {
								URL.revokeObjectURL(blobUrl);
							}
						} catch (e2) {
							console.error('[audio-capture] Failed to load AudioWorklet module', e1, e2);
							loaded = false;
						}
					}
				}
				if (!loaded) {
					throw new Error('AudioWorklet module load failed');
				}
				workletNode = new AudioWorkletNode(audioContext, 'mono-capture');
				let workletMessageCount = 0;
				workletNode.port.onmessage = (ev) => {
					try {
						const ab = ev.data;
						const block = ab instanceof ArrayBuffer ? new Float32Array(ab) : new Float32Array(0);
						if (block.length === 0) return;
						workletMessageCount++;
						if (workletMessageCount <= 3 || workletMessageCount % 100 === 0) {
							console.log('[audio-capture] worklet message', { count: workletMessageCount, blockLen: block.length });
						}
						const resampled = resampleFloat32(block, actualRate, targetSampleRate);
						// concat na fila
						if (bufferQueue.length === 0) {
							bufferQueue = resampled;
						} else {
							const merged = new Float32Array(bufferQueue.length + resampled.length);
							merged.set(bufferQueue, 0);
							merged.set(resampled, bufferQueue.length);
							bufferQueue = merged;
						}
						// envia em frames de 20ms
						let offset = 0;
						let framesSentThisBatch = 0;
						while (bufferQueue.length - offset >= frameSamples) {
							const frame = bufferQueue.subarray(offset, offset + frameSamples);
							const out = floatTo16BitPCM(frame);
							sendPCM(out);
							offset += frameSamples;
							framesSentThisBatch++;
							lastFrameAt = Date.now();
							bytesSent += out.byteLength || 0;
							if (bytesSent % 64000 === 0) {
								console.log('[audio-capture] worklet bytesSent=', bytesSent);
							}
						}
						if (framesSentThisBatch > 0 && workletMessageCount <= 3) {
							console.log('[audio-capture] frames sent this batch:', framesSentThisBatch);
						}
						// mantém o restante
						if (offset > 0) {
							bufferQueue = bufferQueue.slice(offset);
						}
					} catch (_e) {}
				};
				// Conecta cadeia (necessário conectar ao destino para garantir o processamento)
				sourceNode.connect(workletNode);
				workletNode.connect(gainNode);
				gainNode.connect(audioContext.destination);
				console.log('[audio-capture] Audio graph connected: source -> worklet -> gain -> destination');

				// watchdog: se nenhum frame chegar em 1000ms, cai para fallback (se permitido)
				if (allowProcessorFallback && !fallbackArmed) {
					fallbackArmed = true;
					const startTs = Date.now();
					setTimeout(() => {
						const noFrames = lastFrameAt === 0 || lastFrameAt < startTs;
						if (noFrames) {
							try {
								if (workletNode) {
									try { workletNode.port.onmessage = null; } catch (_e1) {}
									try { workletNode.disconnect(); } catch (_e2) {}
								}
							} catch (_e3) {}
							startScriptProcessorFallback(actualRate, targetSampleRate, frameSamples, bufferQueue);
						}
					}, 1000);
				}
				return true;
			} catch (_e) {
				return false;
			}
		};

		const okWorklet = await setupWithWorklet();
		if (!okWorklet) {
			if (!allowProcessorFallback) {
				console.error('[audio-capture] AudioWorklet não suportado; e fallback desativado. Cancelando captura.');
				try { audioContext.close(); } catch (_e) {}
				return;
			}
			// Fallback controlado: ScriptProcessor (deprecated)
			startScriptProcessorFallback(actualRate, targetSampleRate, frameSamples, bufferQueue);
		}

		openWebSocket(wsUrl || DEFAULT_WS_URL);

		console.log('[audio-capture] Iniciado. targetRate=%s actualRate=%s frame=%sms worklet=%s',
			targetSampleRate, actualRate, FRAME_MS, okWorklet);
		console.log('[audio-capture] AudioContext state:', audioContext.state);
		console.log('[audio-capture] Stream tracks:', inputStream.getTracks().map(t => ({ 
			id: t.id, 
			kind: t.kind, 
			enabled: t.enabled, 
			readyState: t.readyState,
			muted: t.muted 
		})));
		
		// DEBUG: Log audio levels from the stream for 10 seconds
		const debugAnalyser = audioContext.createAnalyser();
		debugAnalyser.fftSize = 2048;
		sourceNode.connect(debugAnalyser);
		const dataArray = new Uint8Array(debugAnalyser.frequencyBinCount);
		let debugFrameCount = 0;
		let allSilentFrames = 0;
		const debugInterval = setInterval(() => {
			debugFrameCount++;
			debugAnalyser.getByteTimeDomainData(dataArray);
			let sum = 0;
			let nonZeroCount = 0;
			for (let i = 0; i < dataArray.length; i++) {
				const normalized = (dataArray[i] - 128) / 128;
				if (dataArray[i] !== 128) nonZeroCount++;
				sum += normalized * normalized;
			}
			const rms = Math.sqrt(sum / dataArray.length);
			const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
			if (dbfs === -Infinity || rms < 0.001) {
				allSilentFrames++;
			}
			console.log('[audio-capture] Live RMS:', dbfs.toFixed(1), 'dBFS', { 
				rms: rms.toFixed(6), 
				frameCount: debugFrameCount, 
				nonZeroSamples: nonZeroCount,
				allSilentSoFar: allSilentFrames === debugFrameCount
			});
			if (debugFrameCount >= 50) {
				if (allSilentFrames === debugFrameCount) {
					console.error('[audio-capture] ⚠️ CRITICAL: All frames are SILENT! Tab Audio Capture is NOT working. Possible causes:');
					console.error('  1. Google Meet audio is not being captured by chrome.tabCapture API');
					console.error('  2. The tab might not have permission to capture its own audio');
					console.error('  3. Meet might be using a separate audio context that Tab Capture cannot access');
					console.error('  Recommendation: Check if Meet has audio playing, verify tab permissions, try refreshing the page');
				}
				clearInterval(debugInterval);
				try { debugAnalyser.disconnect(); } catch (_e) {}
			}
		}, 200);
	}

	function stopProcessing() {
		try {
			if (workletNode) {
				try { workletNode.port.onmessage = null; } catch (_e01) {}
				try { workletNode.disconnect(); } catch (_e02) {}
			}
			if (sourceNode) {
				try { sourceNode.disconnect(); } catch (_e2) {}
			}
			if (gainNode) {
				try { gainNode.disconnect(); } catch (_e3) {}
			}
			if (inputStream) {
				try { inputStream.getTracks().forEach(t => t.stop()); } catch (_e4) {}
			}
			if (audioContext) {
				try { audioContext.close(); } catch (_e5) {}
			}
			try { window.postMessage({ type: 'AUDIO_WS_CLOSE', tabId: _tabId }, '*'); } catch (_e6) {}
		} finally {
			audioContext = null;
			sourceNode = null;
			workletNode = null;
			gainNode = null;
			inputStream = null;
			bytesSent = 0;
			_tabId = null;
			console.log('[audio-capture] Captura parada.');
		}
	}

	async function getTabAudioStream(streamId) {
		// CRITICAL FIX: Tab capture doesn't work for Google Meet's WebRTC audio
		// Google Meet uses isolated peer connections that aren't accessible via tabCapture
		// SOLUTION: Capture user's microphone directly for emotional analysis
		// NOTE: This will only analyze the LOCAL USER's voice, not all meeting participants
		// For full meeting analysis, use LiveKit server-side egress instead
		
		console.warn('[audio-capture] ⚠️  Tab capture cannot access Google Meet audio.');
		console.warn('[audio-capture] Switching to USER MICROPHONE capture for testing.');
		console.warn('[audio-capture] This will analyze YOUR voice, not all participants.');
		
		try {
			console.log('[audio-capture] Requesting microphone access...');
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
					sampleRate: { ideal: 16000 }
				},
				video: false
			});
			console.log('[audio-capture] ✅ Microphone access granted');
			return stream;
		} catch (e) {
			console.error('[audio-capture] ❌ Failed to get microphone access:', e);
			console.error('[audio-capture] Please allow microphone permissions for this extension.');
			throw e;
		}
	}

	async function handleStart(payload) {
		try {
			const streamId = payload?.streamId;
			const wsUrl = payload?.wsUrl || DEFAULT_WS_URL;
			const sampleRate = Number(payload?.sampleRate) || DEFAULT_SAMPLE_RATE;
			_tabId = payload?.tabId;
			allowProcessorFallback =
				typeof payload?.allowProcessorFallback === 'boolean'
					? payload.allowProcessorFallback
					: true;
			console.log('[audio-capture] handleStart', { streamId: !!streamId, tabId: _tabId, wsUrl });
			if (!streamId) {
				throw new Error('streamId ausente');
			}
			const stream = await getTabAudioStream(streamId);
			// Garante mono (downmix será feito no processamento, mas força channelCount=1 quando possível)
			const audioTracks = stream.getAudioTracks();
			if (audioTracks[0] && typeof audioTracks[0].applyConstraints === 'function') {
				try {
					await audioTracks[0].applyConstraints({ channelCount: 1 });
				} catch (_ignored) {
					// Se não suportado, seguimos com downmix no pipeline
				}
			}
			await startProcessing(stream, sampleRate, wsUrl);
		} catch (e) {
			console.error('[audio-capture] Falha ao iniciar captura:', e);
			// Fallback básico: reporta erro para o console e segue sem travar a página
		}
	}

	// Recebe o comando do content script para iniciar
	window.addEventListener('message', (event) => {
		if (event.source !== window) return;
		const data = event.data || {};
		if (data.type === 'AUDIO_CAPTURE_START') {
			handleStart(data.payload);
		} else if (data.type === 'AUDIO_CAPTURE_STOP') {
			stopProcessing();
		} else if (data.type === 'EXTENSION_CONTEXT_INVALIDATED') {
			console.error('[audio-capture] ⚠️ Extension context invalidated:', data.message);
			console.error('[audio-capture] You need to RELOAD THIS PAGE for the extension to work again.');
			// Stop processing if running
			try {
				stopProcessing();
			} catch (_e) {}
		}
	});
})();


