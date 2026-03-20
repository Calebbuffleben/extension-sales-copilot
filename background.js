// Background Service Worker (MV3)
// - Recebe comando do popup para iniciar captura
// - Obtém o streamId via chrome.tabCapture.getMediaStreamId
// - Envia streamId ao content script para injetar audio-capture.js e iniciar processamento

console.log('[background] Service worker loaded/restarted at', new Date().toISOString());

// WS proxy managed in background (avoids mixed-content from page)
const __wsByTab = new Map(); // tabId -> { ws, url, ready, queue: ArrayBuffer[] } [LEGACY - single stream]
// NEW: Multi-participant support
const __wsByTabAndParticipant = new Map(); // tabId -> Map<participantId, { ws, url, ready, queue }>

// Keep-alive mechanism to prevent service worker suspension during audio streaming
let keepAliveInterval = null;
let keepAlivePort = null;

function startKeepAlive() {
	if (keepAliveInterval) return;
	console.log('[background] Starting keep-alive with port connection');
	
	// Create a long-lived port to self to keep the service worker alive
	try {
		keepAlivePort = chrome.runtime.connect({ name: 'keepalive' });
		keepAlivePort.onDisconnect.addListener(() => {
			console.log('[background] Keep-alive port disconnected');
			keepAlivePort = null;
			// Try to recreate if we still have active connections
			if (__wsByTab.size > 0 && keepAliveInterval) {
				setTimeout(() => {
					if (__wsByTab.size > 0) {
						try {
							keepAlivePort = chrome.runtime.connect({ name: 'keepalive' });
						} catch (_e) {}
					}
				}, 1000);
			}
		});
	} catch (_e) {
		console.error('[background] Failed to create keep-alive port:', _e);
	}
	
	// Also use interval as backup
	keepAliveInterval = setInterval(() => {
		console.log('[background] Keep-alive tick', { 
			activeTabs: __wsByTab.size,
			hasPort: !!keepAlivePort 
		});
		// Send a message to self to prevent suspension
		try {
			chrome.runtime.sendMessage({ type: 'KEEPALIVE_INTERNAL' }, () => {
				void chrome.runtime.lastError;
			});
		} catch (_e) {}
	}, 15000); // Every 15 seconds
}

function stopKeepAlive() {
	if (!keepAliveInterval) return;
	console.log('[background] Stopping keep-alive');
	clearInterval(keepAliveInterval);
	keepAliveInterval = null;
	
	if (keepAlivePort) {
		try {
			keepAlivePort.disconnect();
		} catch (_e) {}
		keepAlivePort = null;
	}
}

// Config loader (config.json packaged with the extension)
let __cfgCache = null;
let __cfgLoadPromise = null;
function loadConfig() {
	if (__cfgCache) return Promise.resolve(__cfgCache);
	if (__cfgLoadPromise) return __cfgLoadPromise;
	__cfgLoadPromise = fetch(chrome.runtime.getURL('config.json'))
		.then((res) => (res.ok ? res.json() : {}))
		.then((json) => {
			__cfgCache = json && typeof json === 'object' ? json : {};
			return __cfgCache;
		})
		.catch(() => {
			__cfgCache = {};
			return __cfgCache;
		});
	return __cfgLoadPromise;
}
function cfgGet(key, fallback) {
	if (__cfgCache && Object.prototype.hasOwnProperty.call(__cfgCache, key)) {
		return __cfgCache[key];
	}
	return fallback;
}

// CRITICAL: Inject WebRTC interceptor as soon as Meet page loads
// This must happen BEFORE Meet creates any RTCPeerConnection objects
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	// Only inject when page starts loading and it's a Meet URL
	if (changeInfo.status === 'loading' && tab.url?.includes('meet.google.com')) {
		console.log('[background] Meet page detected, injecting WebRTC interceptor early', { tabId, url: tab.url });
		
		// Inject interceptor IMMEDIATELY
		chrome.scripting.executeScript({
			target: { tabId },
			world: 'MAIN',
			files: ['webrtc-interceptor.js'],
			injectImmediately: true
		}).then(() => {
			console.log('[background] ✅ WebRTC interceptor pre-injected for', tabId);
		}).catch((err) => {
			console.warn('[background] Failed to pre-inject interceptor:', err);
		});
	}
});

console.log('[background] Registering onConnect listener');
chrome.runtime.onConnect.addListener((port) => {
	console.log('[background] Port connection attempt', { name: port.name, sender: port.sender });
	
	// Handle keep-alive port (internal to keep service worker alive)
	if (port.name === 'keepalive') {
		console.log('[background] Keep-alive port connected');
		port.onMessage.addListener((msg) => {
			// Echo back to keep connection alive
			try {
				port.postMessage({ type: 'PONG', timestamp: Date.now() });
			} catch (_e) {}
		});
		return;
	}
	
	if (port.name !== 'audio-ws') {
		console.log('[background] Port name mismatch, ignoring');
		return;
	}
	console.log('[background] audio-ws port connected, setting up listeners');
	port.onMessage.addListener((msg) => {
		try {
			const type = msg?.type;
			if (!type) {
				console.warn('[background] Message without type:', msg);
				return;
			}
			console.log('[background] port message', type, { tabId: msg.tabId, hasBuffer: !!msg.buffer, len: msg.byteLength });
			if (type === 'PING') {
				console.log('[background] Received PING');
				return;
			}
			handlePortMessage(type, msg);
		} catch (err) {
			console.error('[background] Error handling port message:', err, { msg });
		}
	});
	
	function handlePortMessage(type, msg) {
		if (type === 'AUDIO_WS_OPEN') {
			const tabId = msg.tabId;
			const participantId = msg.participantId;
			const url = msg.url;
			
			// Shared connection mode (participantId is null) - ONE connection for all participants
			if (participantId === null || participantId === undefined) {
				console.log('[background] AUDIO_WS_OPEN (shared connection)', { tabId, url });
				if (typeof tabId !== 'number' || !url) {
					console.error('[background] Invalid AUDIO_WS_OPEN params for shared connection', { tabId, url });
					return;
				}
				
				// Close existing shared connection if any
				const existing = __wsByTab.get(tabId);
				if (existing && existing.ws) {
					try { existing.ws.close(1000, 'reconnect'); } catch (_e) {}
				}
				
				// Create shared connection state
				const state = { ws: null, url, ready: false, queue: [], _byteCounter: 0 };
				console.log('[background] Creating SHARED WebSocket connection', { tabId, url });
				
				try {
					const ws = new WebSocket(url);
					ws.binaryType = 'arraybuffer';
					ws.onopen = () => {
						state.ready = true;
						startKeepAlive();
						console.log('[background] ✅ WS CONNECTED (shared)', { tabId, queueLen: state.queue.length });
						for (const buf of state.queue) {
							try { ws.send(buf); } catch (_e) {}
						}
						state.queue = [];
					};
					ws.onerror = (err) => {
						console.error('[background] ❌ WS ERROR (shared)', { tabId, error: err });
					};
					ws.onclose = (event) => {
						console.log('[background] WS closed (shared)', { tabId, code: event.code });
						__wsByTab.delete(tabId);
						// Stop keep-alive if no more connections
						if (__wsByTab.size === 0 && __wsByTabAndParticipant.size === 0) {
							stopKeepAlive();
						}
					};
					state.ws = ws;
					__wsByTab.set(tabId, state);
				} catch (e) {
					console.error('[background] Failed to create shared WebSocket', { tabId, error: e });
				}
				return;
			}
			
			// Legacy multi-participant mode (deprecated - should not be used)
			if (participantId) {
				console.warn('[background] AUDIO_WS_OPEN (multi-participant mode deprecated - use shared connection)', { tabId, participantId, url });
				// Fallback to shared connection instead
				return;
			}
			
			// Legacy single-stream mode (no participantId)
			console.log('[background] AUDIO_WS_OPEN (legacy)', { tabId, url, hasUrl: !!url });
			if (typeof tabId !== 'number' || !url) {
				console.error('[background] Invalid AUDIO_WS_OPEN params', { tabId, url });
				return;
			}
			closeWsForTab(tabId);
			const state = { ws: null, url, ready: false, queue: [], _byteCounter: 0 };
			console.log('[background] Creating WebSocket connection', { tabId, url });
			try {
				const ws = new WebSocket(url);
				ws.binaryType = 'arraybuffer';
				ws.onopen = () => {
					state.ready = true;
					startKeepAlive(); // Keep service worker alive during streaming
					console.log('[background] ✅ WS CONNECTED to backend', { tabId, url, queueLen: state.queue.length });
					for (const buf of state.queue) {
						try { 
							console.log('[background] Sending queued buffer', { len: buf.byteLength });
							ws.send(buf); 
						} catch (_e) {}
					}
					state.queue = [];
				};
				ws.onerror = (err) => {
					console.error('[background] ❌ WS ERROR', { tabId, url, error: err });
				};
				ws.onclose = (event) => {
					console.log('[background] WS closed', { tabId, code: event.code, reason: event.reason });
					__wsByTab.delete(tabId);
					if (__wsByTab.size === 0 && __wsByTabAndParticipant.size === 0) {
						stopKeepAlive(); // No more active connections
					}
				};
				state.ws = ws;
				__wsByTab.set(tabId, state);
			} catch (e) {
				console.error('[background] Failed to create WebSocket', { tabId, url, error: e });
			}
			return;
		}
		if (type === 'AUDIO_WS_SEND') {
			const tabId = msg.tabId;
			const participantId = msg.participantId; // Can be null for shared connection
			let buffer = msg.buffer;
			const byteLength = msg.byteLength || (buffer && buffer.byteLength) || 0;
			
			if (typeof tabId !== 'number') return;
			
			// Handle different buffer types
			if (!(buffer instanceof ArrayBuffer)) {
				if (ArrayBuffer.isView(buffer)) {
					// It's a TypedArray view
					const view = buffer;
					const start = typeof view.byteOffset === 'number' ? view.byteOffset : 0;
					const end = start + (view.byteLength || 0);
					buffer = view.buffer.slice(start, end);
					console.log('[background] Converted from TypedArray view');
				} else if (buffer && typeof buffer === 'object') {
					// TypedArray was serialized to plain object - reconstruct it
					console.log('[background] Attempting to reconstruct buffer from plain object');
					try {
						// Check if it has numeric keys (serialized TypedArray)
						const keys = Object.keys(buffer);
						const isSerializedTypedArray = keys.length > 0 && keys.every(k => !isNaN(parseInt(k, 10)));
						
						if (isSerializedTypedArray || byteLength > 0) {
							const uint8 = new Uint8Array(byteLength || keys.length);
							for (let i = 0; i < uint8.length; i++) {
								uint8[i] = buffer[i] || 0;
							}
							buffer = uint8.buffer;
							console.log('[background] Successfully reconstructed buffer', { length: buffer.byteLength });
						} else {
							console.warn('[background] Cannot reconstruct buffer - not a serialized TypedArray', { 
								tabId, 
								sampleKeys: keys.slice(0, 10) 
							});
							return;
						}
					} catch (err) {
						console.error('[background] Failed to reconstruct buffer:', err);
						return;
					}
				} else {
					console.warn('[background] Invalid buffer type', { tabId, type: buffer?.constructor?.name });
					return;
				}
			}
			
			// Use shared connection (participantId can be null or provided for metadata)
			const state = __wsByTab.get(tabId);
			if (!state || !state.ws) {
				console.warn('[background] No shared WS state found for AUDIO_WS_SEND', { 
					tabId, 
					hasState: !!state, 
					hasWs: state?.ws ? true : false,
					activeTabs: Array.from(__wsByTab.keys()),
					participantId
				});
				return;
			}
			
			state._byteCounter = (state._byteCounter || 0) + byteLength;
			if (state._byteCounter >= 64000) {
				console.log('[background] WS bytes sent', { tabId, sent: state._byteCounter, participantId });
				state._byteCounter = 0;
			}
			
			if (state.ready) {
				try {
					// Send buffer directly - participantId is handled by backend via query params or can be added as metadata if needed
					state.ws.send(buffer);
				} catch (sendErr) {
					console.error('[background] WS send failed', { tabId, participantId, error: sendErr.message });
				}
			} else {
				console.log('[background] WS queue chunk (not ready yet)', { tabId, len: byteLength, queueSize: state.queue.length, participantId });
				state.queue.push(buffer.slice(0));
			}
			return;
		}
		if (type === 'AUDIO_WS_CLOSE') {
			const tabId = msg.tabId;
			const participantId = msg.participantId;
			if (typeof tabId !== 'number') return;
			
			// Close shared connection (participantId is null or undefined)
			if (participantId === null || participantId === undefined) {
				closeWsForTab(tabId);
				return;
			}
			
			// Legacy: Close specific participant connection (deprecated)
			if (participantId) {
				console.warn('[background] AUDIO_WS_CLOSE for specific participant deprecated - use shared connection');
				const participantMap = __wsByTabAndParticipant.get(tabId);
				if (participantMap) {
					const state = participantMap.get(participantId);
					if (state && state.ws) {
						try { state.ws.close(1000, 'stop'); } catch (_e) {}
					}
					participantMap.delete(participantId);
					if (participantMap.size === 0) {
						__wsByTabAndParticipant.delete(tabId);
					}
				}
			}
			return;
		}
	}
	
	console.log('[background] Message listener registered for port');
	port.onDisconnect.addListener(() => {
		const err = chrome.runtime.lastError;
		console.warn('[background] Port disconnected from our side', { 
			error: err?.message,
			sender: port.sender
		});
	});
	console.log('[background] Port setup complete');
});

// Global error handler for service worker
self.addEventListener('error', (event) => {
	console.error('[background] Global error:', event.error, event.message);
});

self.addEventListener('unhandledrejection', (event) => {
	console.error('[background] Unhandled rejection:', event.reason);
});

function closeWsForTab(tabId) {
	try {
		const state = __wsByTab.get(tabId);
		if (state && state.ws) {
			try { state.ws.close(1000, 'stop'); } catch (_e) {}
		}
	} catch (_e) {}
	__wsByTab.delete(tabId);
}

function stopCaptureForTab(tabId, captureMode) {
	return new Promise((resolve) => {
		closeWsForTab(tabId);
		const delayResolve = () => setTimeout(resolve, 150);
		if (captureMode === 'offscreen') {
			try {
				chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP', tabId }, () => { void chrome.runtime.lastError; delayResolve(); });
			} catch (_e) {
				delayResolve();
			}
			// Optional: close offscreen doc
			try {
				// @ts-ignore
				chrome.offscreen?.closeDocument?.().catch?.(() => {});
			} catch (_e) {}
		} else {
			try {
				chrome.tabs.sendMessage(tabId, { type: 'STOP_CAPTURE' }, () => { void chrome.runtime.lastError; delayResolve(); });
			} catch (_e2) {
				delayResolve();
			}
		}
	});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	// Handle keepalive/ping to wake up service worker
	if (message?.type === 'KEEPALIVE' || message?.type === 'PING' || message?.type === 'KEEPALIVE_INTERNAL') {
		if (message?.type !== 'KEEPALIVE_INTERNAL') {
			console.log('[background] Received keepalive/ping from content');
		}
		sendResponse({ ok: true, timestamp: Date.now() });
		return true;
	}
	
	if (message?.type === 'START_CAPTURE') {
		const tabId = message.tabId;
		const msgSampleRate = Number(message.sampleRate);

		async function ensureOffscreen() {
			try {
				// @ts-ignore
				const has = await chrome.offscreen.hasDocument?.();
				if (has) return;
				// @ts-ignore
				await chrome.offscreen.createDocument?.({
					url: 'offscreen.html',
					reasons: ['WEB_RTC', 'AUDIO_PLAYBACK'],
					justification: 'Processar áudio da aba com WebAudio em MV3'
				});
			} catch (_e) {}
		}

		function sanitize(val) {
			return String(val || '')
				.replace(/[^a-zA-Z0-9_\-\.]/g, '_')
				.slice(0, 128) || 'unknown';
		}
		function extractMeetRoomCode(tabUrl) {
			try {
				const u = new URL(tabUrl);
				const parts = (u.pathname || '').split('/').filter(Boolean);
				if (parts.length === 0) return 'room';
				if (parts[0] === 'lookup' && parts[1]) return sanitize(parts[1]);
				return sanitize(parts[0]);
			} catch (_e) {
				return 'room';
			}
		}
		function buildEgressAudioWsUrl(baseWs, egressPath, tabUrl, sampleRate) {
			let urlString = baseWs.trim();
			// Ensure protocol
			if (!/^wss?:\/\//i.test(urlString)) {
				urlString = 'ws://' + urlString;
			}
			let u;
			try {
				u = new URL(urlString);
			} catch (_e) {
				u = new URL('ws://localhost:3001');
			}
			// Force path to configured audio egress path
			u.pathname = egressPath || '/egress-audio';
			// Build query params
			const room = extractMeetRoomCode(tabUrl);
			const participant = 'browser';
			const track = 'tab-audio';
			u.searchParams.set('room', room);
			u.searchParams.set('meetingId', room); // garante meetingId para pipeline/feedback
			u.searchParams.set('participant', participant);
			u.searchParams.set('track', track);
			u.searchParams.set('sampleRate', String(sampleRate));
			u.searchParams.set('channels', '1');
			// meetingId optional → let backend deduce from session if available
			return u.toString();
		}
		function normalizeWsBase(baseWs, tabUrl) {
			let s = String(baseWs || '').trim();
			const isSecurePage = /^https:\/\//i.test(String(tabUrl || ''));
			if (!s) return s;
			
			// Check if it's localhost (development) - always use ws:// for localhost
			const isLocalhost = /^localhost|^127\.0\.0\.1|^\[::1\]|^0\.0\.0\.0/i.test(s.replace(/^wss?:\/\//i, ''));
			
			// If missing protocol, choose ws/wss based on page security (unless localhost)
			if (!/^[a-z]+:\/\//i.test(s)) {
				s = (isLocalhost ? 'ws://' : (isSecurePage ? 'wss://' : 'ws://')) + s;
			}
			// If page is https, upgrade ws->wss to avoid mixed-content blocking (unless localhost)
			if (isSecurePage && /^ws:\/\//i.test(s) && !isLocalhost) {
				s = s.replace(/^ws:\/\//i, 'wss://');
			}
			// Force ws:// for localhost even if it was converted to wss://
			if (isLocalhost && /^wss:\/\//i.test(s)) {
				s = s.replace(/^wss:\/\//i, 'ws://');
			}
			return s;
		}
		function wsToHttpBase(wsBase) {
			try {
				const u = new URL(/^[a-z]+:\/\//i.test(wsBase) ? wsBase : 'ws://' + wsBase);
				u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
				u.pathname = '/';
				u.search = '';
				u.hash = '';
				return u.toString().replace(/\/+$/, '');
			} catch (_e) {
				return 'http://localhost:3001';
			}
		}

		loadConfig().then(() => {
			const baseWsFromCfg = cfgGet('BACKEND_WS_BASE', 'wss://backend-analysis-production-a688.up.railway.app');
			const egressPath = cfgGet('EGRESS_AUDIO_PATH', '/egress-audio');
			const defaultSr = Number(cfgGet('DEFAULT_SAMPLE_RATE', '16000')) || 16000;
			const allowFallback =
				String(cfgGet('ALLOW_SCRIPT_PROCESSOR_FALLBACK', 'true')).toLowerCase() !== 'false';
			const captureMode = String(cfgGet('CAPTURE_MODE', 'content')).toLowerCase();
			const targetSampleRate = Number.isFinite(msgSampleRate) && msgSampleRate > 0 ? msgSampleRate : defaultSr;
			stopCaptureForTab(tabId, captureMode).then(() => {
				// Ensure offscreen doc closed when using offscreen mode
				if (captureMode === 'offscreen') {
					try {
						// @ts-ignore
						chrome.offscreen?.closeDocument?.().catch?.(() => {});
					} catch (_e) {}
				}
				chrome.tabs.get(tabId, (tab) => {
					const tabUrl = tab?.url || 'https://meet.google.com/';
					const baseWs = normalizeWsBase(baseWsFromCfg, tabUrl);
					const roomCode = extractMeetRoomCode(tabUrl);
					const finalWsUrl = buildEgressAudioWsUrl(baseWs, egressPath, tabUrl, targetSampleRate);
					const httpBase = wsToHttpBase(baseWs);

					// getMediaStreamId permite que a página (via getUserMedia) acesse o áudio da própria aba
					chrome.tabCapture.getMediaStreamId(
						{ consumerTabId: tabId, targetTabId: tabId },
						(streamId) => {
						if (chrome.runtime.lastError) {
							const errorMsg = chrome.runtime.lastError.message || 'Erro desconhecido em getMediaStreamId';
							console.warn('[background] getMediaStreamId failed:', errorMsg, { tabId, captureMode });
								// Fallback simples: avisa o content script/usuário
								chrome.tabs.sendMessage(tabId, {
									type: 'CAPTURE_FAILED',
									error: errorMsg
								}, () => {});
								sendResponse({ ok: false, error: errorMsg });
								return;
							}

							if (captureMode === 'offscreen') {
								// Inicia captura no documento offscreen
								ensureOffscreen().then(() => {
									chrome.runtime.sendMessage({
										type: 'OFFSCREEN_START',
										payload: {
											tabId,
											streamId,
											sampleRate: targetSampleRate,
											wsUrl: finalWsUrl,
											allowProcessorFallback: allowFallback
										}
									}, () => { void chrome.runtime.lastError; });
									// read lastError to silence Unchecked runtime.lastError if no receiver
								});
							} else {
								// Modo content (injeção na página)
								// NEW: Inject WebRTC interceptor FIRST, then participant detector, then multi-track audio capture
								// Order is critical: interceptor must be loaded before Meet initializes
								chrome.scripting.executeScript({
									target: { tabId },
									world: 'MAIN',
									files: ['webrtc-interceptor.js'],
									injectImmediately: true // Critical: inject before page loads
								}, () => {
									if (chrome.runtime.lastError) {
										console.warn('[background] WebRTC interceptor injection failed:', chrome.runtime.lastError);
									}
									console.log('[background] ✅ WebRTC interceptor injected');
									
									// Then inject participant detector and audio processors
									chrome.scripting.executeScript({
										target: { tabId },
										world: 'MAIN',
										files: ['meet-participant-detector.js', 'audio-capture-multitrack.js', 'vendor/socket.io.min.js', 'feedback-overlay.js']
									}, () => {
										if (chrome.runtime.lastError) {
											console.warn('[background] Script injection failed:', chrome.runtime.lastError);
										}
										console.log('[background] ✅ All scripts injected');
										
										// Initialize multi-track capture
										chrome.tabs.sendMessage(tabId, {
											type: 'INJECT_AND_START_MULTITRACK',
											payload: {
												tabId,
												sampleRate: targetSampleRate,
												wsUrl: finalWsUrl,
												feedbackHttpBase: httpBase,
												meetingId: roomCode,
											}
										}, () => { void chrome.runtime.lastError; });
									});
								});
							}

							// Inicia overlay no content script
							if (captureMode === 'offscreen') {
								chrome.tabs.sendMessage(tabId, {
									type: 'INJECT_AND_START',
									payload: {
										feedbackHttpBase: httpBase,
										meetingId: roomCode
									}
								}, () => { void chrome.runtime.lastError; });
							}

						console.log('[background] captura iniciada', {
							tabId,
							captureMode,
							targetSampleRate,
							wsUrl: finalWsUrl
						});
						sendResponse({ ok: true });
						}
					);
				});
			});
		});
		// Responder de forma assíncrona
		return true;
	}
	// WS proxy open
	if (message?.type === 'STOP_CAPTURE') {
		const tabId = message.tabId;
		if (typeof tabId !== 'number') {
			sendResponse({ ok: false, error: 'tabId inválido' });
			return;
		}
		const captureMode = String((__cfgCache && __cfgCache['CAPTURE_MODE']) || 'content').toLowerCase();
		if (captureMode === 'offscreen') {
			// Parar overlay
			chrome.tabs.sendMessage(tabId, { type: 'STOP_CAPTURE' }, () => { void chrome.runtime.lastError; });
			// Parar offscreen
			chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP', tabId }, () => { void chrome.runtime.lastError; });
			// Tentar fechar o documento offscreen (opcional)
			// @ts-ignore
			chrome.offscreen?.closeDocument?.().catch?.(() => {});
		} else {
			// Parar captura no content
			chrome.tabs.sendMessage(tabId, { type: 'STOP_CAPTURE' }, () => { void chrome.runtime.lastError; });
		}
		closeWsForTab(tabId);
		sendResponse({ ok: true });
		return true;
	}
});


