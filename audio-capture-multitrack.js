// Multi-Track Audio Capture for Google Meet
// Captures and mixes ALL participant audio tracks into a SINGLE stream
// ONE processor, ONE WebSocket connection

(function () {
	console.log('[audio-capture-mt] Initializing unified audio capture');

	const DEFAULT_SAMPLE_RATE = 16000;
	const FRAME_MS = 20;

	// Global state
	let _tabId = null;
	let _meetingId = null;
	let _wsBaseUrl = null;
	let _sharedWebSocketReady = false;

	// Track registry: trackId -> { track, sourceNode } (to prevent duplicate processing)
	const activeTracks = new Map();
	
	// Shared WebSocket connection (ONE connection for all tracks)
	let _sharedWebSocketUrl = null;

	// Unified audio processor (ONE processor for ALL tracks)
	let unifiedProcessor = null;

	// Inline worklet code
	const WORKLET_INLINE_CODE = [
		'class MonoCaptureProcessor extends AudioWorkletProcessor {',
		'  constructor(){ super(); this._processCount = 0; this._lastLog = 0; this._nonZeroCount = 0; }',
		'  process(inputs){',
		'    this._processCount++;',
		'    const input = inputs && inputs[0];',
		'    if (!input || input.length === 0) {',
		'      if (this._processCount % 100 === 0) {',
		'        this.port.postMessage({ type: "debug", msg: "No input", count: this._processCount });',
		'      }',
		'      return true;',
		'    }',
		'    const channels = input.length;',
		'    const len = input[0]?.length || 0;',
		'    if (len === 0) {',
		'      if (this._processCount % 100 === 0) {',
		'        this.port.postMessage({ type: "debug", msg: "Zero length", count: this._processCount });',
		'      }',
		'      return true;',
		'    }',
		'    const mono = new Float32Array(len);',
		'    let hasNonZero = false;',
		'    let maxAbs = 0;',
		'    for (let ch = 0; ch < channels; ch++){',
		'      const chData = input[ch];',
		'      for (let i = 0; i < len; i++){',
		'        mono[i] += chData[i];',
		'        const abs = Math.abs(chData[i]);',
		'        if (abs > 0.00001) hasNonZero = true;',
		'        if (abs > maxAbs) maxAbs = abs;',
		'      }',
		'    }',
		'    if (channels > 1){ for (let i = 0; i < len; i++) mono[i] /= channels; }',
		'    if (hasNonZero) this._nonZeroCount++;',
		'    const now = Date.now();',
		'    if (now - this._lastLog > 2000) {',
		'      this.port.postMessage({ type: "stats", hasAudio: hasNonZero, maxAbs, processCount: this._processCount, nonZeroCount: this._nonZeroCount, channels, len });',
		'      this._lastLog = now;',
		'    }',
		'    this.port.postMessage({ type: "audio", buffer: mono.buffer }, [mono.buffer]);',
		'    return true;',
		'  }',
		'}',
		'registerProcessor("mono-capture", MonoCaptureProcessor);',
	].join('\n');

	// Unified audio processor - mixes ALL tracks into ONE stream
	class UnifiedAudioProcessor {
		constructor(targetSampleRate) {
			this.targetSampleRate = targetSampleRate;
			this.audioContext = null;
			this.mixerNode = null; // GainNode used as mixer
			this.workletNode = null;
			this.outputGainNode = null;
			this.bufferQueue = new Float32Array(0);
			this.bytesSent = 0;
			this.isRunning = false;
			this.workletLoaded = false;
			this.frameSamples = Math.round((targetSampleRate * FRAME_MS) / 1000);
			this.sourceNodes = new Map(); // trackId -> sourceNode

			console.log('[audio-capture-mt] Created unified audio processor');
		}

		async start() {
			if (this.isRunning) {
				console.warn('[audio-capture-mt] Unified processor already running');
				return;
			}

			try {
				// Create AudioContext
				try {
					this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
						sampleRate: this.targetSampleRate,
					});
				} catch (_e) {
					this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
				}

				const actualRate = this.audioContext.sampleRate;
				this.frameSamples = Math.round((this.targetSampleRate * FRAME_MS) / 1000);

				console.log('[audio-capture-mt] Unified AudioContext created', {
					targetRate: this.targetSampleRate,
					actualRate,
					state: this.audioContext.state,
				});

				// Resume context if suspended
				if (this.audioContext.state === 'suspended') {
					await this.audioContext.resume();
				}

				// Create mixer node (GainNode acts as mixer when multiple sources connect to it)
				this.mixerNode = this.audioContext.createGain();
				this.mixerNode.gain.value = 1.0; // Full gain for mixing

				// Create output gain (silent, prevents echo)
				this.outputGainNode = this.audioContext.createGain();
				this.outputGainNode.gain.value = 0; // Silent output

				// Setup AudioWorklet
				await this.setupWorklet(actualRate);

				// Connect mixer -> worklet -> output gain -> destination
				this.mixerNode.connect(this.workletNode);
				this.workletNode.connect(this.outputGainNode);
				this.outputGainNode.connect(this.audioContext.destination);

				// Ensure shared WebSocket is open
				ensureSharedWebSocketConnection();

				this.isRunning = true;
				console.log('[audio-capture-mt] ✅ Unified processor started');
			} catch (e) {
				console.error('[audio-capture-mt] Failed to start unified processor:', e);
				this.stop();
			}
		}

		async setupWorklet(actualRate) {
			try {
				// Load worklet module
				if (!this.workletLoaded) {
					const blob = new Blob([WORKLET_INLINE_CODE], { type: 'application/javascript' });
					const blobUrl = URL.createObjectURL(blob);
					try {
						await this.audioContext.audioWorklet.addModule(blobUrl);
						this.workletLoaded = true;
					} finally {
						URL.revokeObjectURL(blobUrl);
					}
				}

				// Create worklet node
				this.workletNode = new AudioWorkletNode(this.audioContext, 'mono-capture');

				// Handle messages from worklet
				this.workletNode.port.onmessage = (ev) => {
					try {
						const data = ev.data;
						
						// Handle debug messages
						if (data && typeof data === 'object' && data.type === 'debug') {
							console.log('[audio-capture-mt] WORKLET DEBUG:', data.msg, `count=${data.count}`);
							return;
						}
						
						// Handle stats messages
						if (data && typeof data === 'object' && data.type === 'stats') {
							console.log('[audio-capture-mt] AUDIO STATS:', {
								hasAudio: data.hasAudio,
								maxAbs: data.maxAbs?.toFixed(6),
								processCount: data.processCount,
								nonZeroCount: data.nonZeroCount,
								channels: data.channels,
								samplesPerBlock: data.len,
								activeTracks: this.sourceNodes.size
							});
							return;
						}
						
						// Handle audio data
						const ab = (data && data.type === 'audio') ? data.buffer : data;
						const block = ab instanceof ArrayBuffer ? new Float32Array(ab) : new Float32Array(0);
						if (block.length === 0) return;

						// Resample if needed
						const resampled = this.resampleFloat32(block, actualRate, this.targetSampleRate);

						// Queue
						if (this.bufferQueue.length === 0) {
							this.bufferQueue = resampled;
						} else {
							const merged = new Float32Array(this.bufferQueue.length + resampled.length);
							merged.set(this.bufferQueue, 0);
							merged.set(resampled, this.bufferQueue.length);
							this.bufferQueue = merged;
						}

						// Send frames
						let offset = 0;
						while (this.bufferQueue.length - offset >= this.frameSamples) {
							const frame = this.bufferQueue.subarray(offset, offset + this.frameSamples);
							const pcm = this.floatTo16BitPCM(frame);
							this.sendPCM(pcm);
							offset += this.frameSamples;
							this.bytesSent += pcm.byteLength || 0;
						}

						// Keep remainder
						if (offset > 0) {
							this.bufferQueue = this.bufferQueue.slice(offset);
						}
					} catch (e) {
						console.error('[audio-capture-mt] Worklet message handler error:', e);
					}
				};

				console.log('[audio-capture-mt] Worklet setup complete');
			} catch (e) {
				console.error('[audio-capture-mt] Worklet setup failed:', e);
				throw e;
			}
		}

		addTrack(trackId, track) {
			if (!this.isRunning) {
				console.warn('[audio-capture-mt] Cannot add track: processor not running');
				return false;
			}

			if (this.sourceNodes.has(trackId)) {
				console.warn(`[audio-capture-mt] Track ${trackId} already added`);
				return false;
			}

			try {
				// Create stream from track
				const stream = new MediaStream([track]);

				// Create source node
				const sourceNode = this.audioContext.createMediaStreamSource(stream);

				// Connect source -> mixer (all tracks mix together)
				sourceNode.connect(this.mixerNode);

				this.sourceNodes.set(trackId, sourceNode);
				console.log(`[audio-capture-mt] ✅ Added track ${trackId} to unified processor (total tracks: ${this.sourceNodes.size})`);
				return true;
			} catch (e) {
				console.error(`[audio-capture-mt] Failed to add track ${trackId}:`, e);
				return false;
			}
		}

		removeTrack(trackId) {
			const sourceNode = this.sourceNodes.get(trackId);
			if (sourceNode) {
				try {
					sourceNode.disconnect();
					this.sourceNodes.delete(trackId);
					console.log(`[audio-capture-mt] ✅ Removed track ${trackId} from unified processor (remaining tracks: ${this.sourceNodes.size})`);
				} catch (e) {
					console.error(`[audio-capture-mt] Error removing track ${trackId}:`, e);
				}
			}
		}

		floatTo16BitPCM(float32) {
			const len = float32.length;
			const out = new Int16Array(len);
			
			// Find peak amplitude for normalization
			let peak = 0;
			for (let i = 0; i < len; i++) {
				const abs = Math.abs(float32[i]);
				if (abs > peak) peak = abs;
			}
			
			// Apply auto-gain for quiet signals
			let gain = 1.0;
			if (peak > 0.00001 && peak < 0.3) {
				gain = Math.min(50.0, 0.7 / peak);
			}
			
			// Convert to 16-bit PCM with gain applied
			for (let i = 0; i < len; i++) {
				let s = float32[i] * gain;
				if (s > 1) s = 1;
				else if (s < -1) s = -1;
				out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
			}
			return out.buffer;
		}

		resampleFloat32(buffer, sourceRate, targetRate) {
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

		sendPCM(buffer) {
			const ab = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
			
			if (this.bytesSent % 64000 < 1280) {
				console.log('[audio-capture-mt] sendPCM', {
					byteLength: ab.byteLength,
					bytesSent: this.bytesSent,
					activeTracks: this.sourceNodes.size
				});
			}

			// Send through shared WebSocket connection
			window.postMessage(
				{
					type: 'AUDIO_WS_SEND',
					buffer: ab,
					tabId: _tabId,
					participantId: null, // Unified stream, no participant ID
				},
				'*',
			);
		}

		stop() {
			console.log('[audio-capture-mt] Stopping unified processor');

			try {
				// Disconnect all source nodes
				for (const [trackId, sourceNode] of this.sourceNodes.entries()) {
					try {
						sourceNode.disconnect();
					} catch (_e) {}
				}
				this.sourceNodes.clear();

				if (this.workletNode) {
					this.workletNode.port.onmessage = null;
					this.workletNode.disconnect();
				}
				if (this.mixerNode) this.mixerNode.disconnect();
				if (this.outputGainNode) this.outputGainNode.disconnect();
				if (this.audioContext) this.audioContext.close();

				// Close shared WebSocket
				window.postMessage(
					{
						type: 'AUDIO_WS_CLOSE',
						tabId: _tabId,
						participantId: null,
					},
					'*',
				);
			} catch (e) {
				console.error('[audio-capture-mt] Error stopping unified processor:', e);
			} finally {
				this.isRunning = false;
				this.audioContext = null;
				this.mixerNode = null;
				this.workletNode = null;
				this.outputGainNode = null;
			}
		}
	}

	// Handle track participant mapping
	window.addEventListener('message', (event) => {
		if (event.source !== window) return;
		const data = event.data || {};

		// When a track is mapped, add it to unified processor
		if (data.type === 'TRACK_PARTICIPANT_MAPPED') {
			const { trackId, participantId, participantName } = data;
			console.log(`[audio-capture-mt] Track mapped:`, { trackId, participantId, participantName });

			// Check if this track is already being processed
			if (activeTracks.has(trackId)) {
				console.warn(`[audio-capture-mt] Track ${trackId} already being processed, skipping duplicate`);
				return;
			}

			// Get the track from webrtc-interceptor registry
			if (window.__webrtcInterceptor) {
				const trackInfo = window.__webrtcInterceptor.tracksRegistry.get(trackId);
				if (trackInfo && trackInfo.track) {
					handleRemoteTrack(trackId, trackInfo.track);
				} else {
					console.error(`[audio-capture-mt] Track ${trackId} not found in registry`);
				}
			}
		}

		// Handle track removal
		if (data.type === 'WEBRTC_TRACK_REMOVED') {
			const { trackId } = data;
			
			if (activeTracks.has(trackId)) {
				console.log(`[audio-capture-mt] Removing track ${trackId} from unified processor`);
				if (unifiedProcessor) {
					unifiedProcessor.removeTrack(trackId);
				}
				activeTracks.delete(trackId);
			}
		}

		// Initial setup command
		if (data.type === 'AUDIO_CAPTURE_START_MULTITRACK') {
			const payload = data.payload || {};
			const { tabId, meetingId, wsUrl, sampleRate } = payload;
			console.log('[audio-capture-mt] Starting unified audio capture', { tabId, meetingId, wsUrl });

			_tabId = tabId;
			_meetingId = meetingId;
			_wsBaseUrl = wsUrl;

			// Create unified processor
			unifiedProcessor = new UnifiedAudioProcessor(DEFAULT_SAMPLE_RATE);
			unifiedProcessor.start().catch(e => {
				console.error('[audio-capture-mt] Failed to start unified processor:', e);
			});

			console.log('[audio-capture-mt] ✅ Ready to capture tracks');
			
			// Check for tracks that were already captured before we initialized
			if (window.__webrtcInterceptor && window.__webrtcInterceptor.tracksRegistry) {
				const existingTracks = window.__webrtcInterceptor.tracksRegistry;
				console.log(`[audio-capture-mt] Found ${existingTracks.size} existing tracks, processing retroactively`);
				
				for (const [trackId, trackInfo] of existingTracks.entries()) {
					if (trackInfo.track.kind === 'audio') {
						console.log(`[audio-capture-mt] Processing existing audio track: ${trackId}`);
						// Trigger track assignment
						window.postMessage({
							type: 'WEBRTC_TRACK_ADDED',
							trackId: trackInfo.trackId,
							trackLabel: trackInfo.track.label,
							streamId: trackInfo.stream?.id,
							pcId: trackInfo.pcId,
							timestamp: trackInfo.capturedAt || Date.now(),
						}, '*');
					}
				}
			}
		}

		// Stop all
		if (data.type === 'AUDIO_CAPTURE_STOP_MULTITRACK') {
			console.log('[audio-capture-mt] Stopping unified processor');
			if (unifiedProcessor) {
				unifiedProcessor.stop();
				unifiedProcessor = null;
			}
			activeTracks.clear();
			_sharedWebSocketUrl = null;
			_sharedWebSocketReady = false;
		}
	});

	// Shared WebSocket connection manager
	function ensureSharedWebSocketConnection() {
		if (_sharedWebSocketUrl || _sharedWebSocketReady) {
			// Already created or in progress
			return;
		}

		if (!_wsBaseUrl || !_meetingId) {
			console.error(`[audio-capture-mt] Missing wsBaseUrl or meetingId for shared WebSocket`);
			return;
		}

		// Build URL WITHOUT participant-specific info (shared connection)
		const baseUrl = new URL(_wsBaseUrl);
		baseUrl.searchParams.set('room', _meetingId);
		baseUrl.searchParams.set('meetingId', _meetingId);
		baseUrl.searchParams.set('source', 'browser');
		baseUrl.searchParams.set('sampleRate', String(DEFAULT_SAMPLE_RATE));
		baseUrl.searchParams.set('channels', '1');
		
		_sharedWebSocketUrl = baseUrl.toString();
		console.log(`[audio-capture-mt] Opening SHARED WebSocket for all tracks:`, _sharedWebSocketUrl);

		window.postMessage(
			{
				type: 'AUDIO_WS_OPEN',
				url: _sharedWebSocketUrl,
				tabId: _tabId,
				participantId: null, // null = shared connection
			},
			'*',
		);
		
		_sharedWebSocketReady = true;
	}

	async function handleRemoteTrack(trackId, track) {
		console.log(`[audio-capture-mt] Handling remote track ${trackId}`);

		// Check if this specific track is already being processed
		if (activeTracks.has(trackId)) {
			console.warn(`[audio-capture-mt] Track ${trackId} already being processed, skipping`);
			return;
		}

		// Ensure unified processor is running
		if (!unifiedProcessor || !unifiedProcessor.isRunning) {
			console.warn('[audio-capture-mt] Unified processor not running, cannot add track');
			return;
		}

		// Add track to unified processor
		if (unifiedProcessor.addTrack(trackId, track)) {
			activeTracks.set(trackId, { track });
		}
	}

	// Expose for debugging
	window.__audioCaptureMultiTrack = {
		unifiedProcessor,
		getActiveTracks: () => Array.from(activeTracks.keys()),
		getStats: () => unifiedProcessor ? {
			isRunning: unifiedProcessor.isRunning,
			activeTracks: unifiedProcessor.sourceNodes.size,
			bytesSent: unifiedProcessor.bytesSent,
		} : null,
	};

	console.log('[audio-capture-mt] ✅ Unified audio capture ready');
})();
