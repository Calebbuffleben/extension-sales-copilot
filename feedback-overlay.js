(function () {
	const MAX_ITEMS = 6;
	const ITEM_TTL_MS = 15000;
	const POLL_INTERVAL_MS = 2000; // fallback polling
	const POLL_BASELINE_GRACE_MS = 5000;

	let overlayRoot = null;
	let listEl = null;
	let socket = null;
	let lastMetrics = null;
	let pollTimer = null;
	let disconnectFallbackTimer = null;
	let connectErrorFallbackTimer = null;
	/** Dedup by id (Socket.IO + HTTP); avoids duplicate when both paths fire. */
	const seenEventIds = new Set();
	let metricsBaselineDone = false;
	let overlayMeetingId = null;
	let pollingModeLogged = false;
	let overlayStartedAtMs = 0;

	function stopPolling() {
		if (pollTimer) {
			console.log('[feedback-overlay] stopPolling');
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	function ensureStyles() {
		const styleId = '__meet_feedback_overlay_style__';
		if (document.getElementById(styleId)) return;
		const style = document.createElement('style');
		style.id = styleId;
		style.textContent =
			'#__meet_feedback_overlay__{position:fixed;top:12px;right:12px;z-index:2147483647;background:rgba(0,0,0,0.6);backdrop-filter:saturate(180%) blur(8px);color:#fff;border-radius:8px;padding:10px 10px 8px;max-width:320px;font:12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Helvetica,Arial}' +
			'#__meet_feedback_overlay__ .hdr{display:flex;align-items:center;justify-content:space-between;margin:0 0 6px;font-weight:600;opacity:.9}' +
			'#__meet_feedback_overlay__ .item{display:flex;flex-direction:column;gap:2px;margin:6px 0;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);box-shadow:0 1px 2px rgba(0,0,0,.15)}' +
			'#__meet_feedback_overlay__ .sev-info{border-color:#5bc0de;color:#cfefff}' +
			'#__meet_feedback_overlay__ .sev-warning{border-color:#f0ad4e;color:#ffeac7}' +
			'#__meet_feedback_overlay__ .sev-critical{border-color:#d9534f;color:#ffd6d5}' +
			'#__meet_feedback_overlay__ .msg{font-size:12px}' +
			'#__meet_feedback_overlay__ .tips{opacity:.9;font-size:11px;margin-top:2px}' +
			'#__meet_feedback_overlay__ .muted{opacity:.7}' +
			'#__meet_feedback_overlay__ .meta{opacity:.6;font-size:10px;margin-top:2px}' +
			'#__meet_feedback_overlay__ .close{cursor:pointer;opacity:.7;border:none;background:transparent;color:#fff;font-size:14px;line-height:1;padding:0 4px}' +
			'@media (max-width: 720px){#__meet_feedback_overlay__{left:8px;right:8px;top:auto;bottom:8px;max-width:none}}';
		document.head.appendChild(style);
	}

	function ensureOverlay() {
		if (overlayRoot) return;
		overlayRoot = document.createElement('div');
		overlayRoot.id = '__meet_feedback_overlay__';
		const hdr = document.createElement('div');
		hdr.className = 'hdr';
		const title = document.createElement('div');
		title.textContent = 'Feedback em tempo real';
		const btn = document.createElement('button');
		btn.className = 'close';
		btn.title = 'Ocultar';
		btn.textContent = '✕';
		btn.addEventListener('click', () => {
			overlayRoot.style.display = 'none';
		});
		hdr.appendChild(title);
		hdr.appendChild(btn);
		listEl = document.createElement('div');
		overlayRoot.appendChild(hdr);
		overlayRoot.appendChild(listEl);
		document.documentElement.appendChild(overlayRoot);
	}

	function escapeHtml(text) {
		return String(text)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	function severityClass(sev) {
		if (sev === 'critical') return 'sev-critical';
		if (sev === 'warning') return 'sev-warning';
		return 'sev-info';
	}

	function addPayloadIfNew(payload) {
		if (!payload || typeof payload !== 'object') return;
		const eventId = payload.id ? String(payload.id) : '';
		if (eventId) {
			if (seenEventIds.has(eventId)) return;
			seenEventIds.add(eventId);
		}
		addItem(payload);
	}

	function normalizeRecentPayload(event) {
		if (!event || typeof event !== 'object') return null;
		const meta = event.metadata && typeof event.metadata === 'object' ? event.metadata : null;
		const tips = meta && Array.isArray(meta.tips) ? meta.tips : [];
		return {
			id: event.id,
			meetingId: event.meetingId,
			participantId: event.participantId,
			type: event.type,
			severity: event.severity || 'info',
			ts: event.ts || Date.now(),
			createdAt: event.createdAt || null,
			windowStart: event.windowStart,
			windowEnd: event.windowEnd,
			message: event.message || '',
			tips,
			metadata: meta || undefined
		};
	}

	function getEventTimeMs(eventLike) {
		if (!eventLike || typeof eventLike !== 'object') return 0;
		const rawValue = eventLike.createdAt || eventLike.ts;
		if (!rawValue) return 0;
		const ms = new Date(rawValue).getTime();
		return Number.isFinite(ms) ? ms : 0;
	}

	function shouldRenderRecentOnBaseline(eventLike) {
		if (!overlayStartedAtMs) return false;
		const eventTimeMs = getEventTimeMs(eventLike);
		if (!eventTimeMs) return false;
		return eventTimeMs >= overlayStartedAtMs - POLL_BASELINE_GRACE_MS;
	}

	function replayRecent(recent) {
		if (!Array.isArray(recent) || recent.length === 0) return;
		const sorted = [...recent].sort(
			(a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
		);
		for (const event of sorted) {
			const payload = normalizeRecentPayload(event);
			if (!payload) continue;
			addPayloadIfNew(payload);
		}
	}

	function emitJoinRoom(meetingId) {
		if (!socket) return;
		console.log('[feedback-overlay] emit join-room', { meetingId });
		try {
			socket.emit('join-room', `feedback:${meetingId}`);
		} catch (_e) {}
	}

	function addItem(payload) {
		ensureStyles();
		ensureOverlay();
		const item = document.createElement('div');
		item.className = `item ${severityClass(payload.severity)}`;
		const msg = document.createElement('div');
		msg.className = 'msg';
		msg.textContent = payload.message;
		item.appendChild(msg);
		const tipsArr = payload.tips ?? payload.metadata?.tips;
		if (Array.isArray(tipsArr) && tipsArr.length) {
			const tips = document.createElement('div');
			tips.className = 'tips';
			tips.textContent = `Dicas: ${tipsArr.join(' · ')}`;
			item.appendChild(tips);
		}
		const meta = document.createElement('div');
		meta.className = 'meta';
		const ts = new Date(payload.ts || Date.now());
		meta.textContent = `${payload.type} • ${ts.toLocaleTimeString()}`;
		item.appendChild(meta);
		listEl.insertBefore(item, listEl.firstChild);
		// cap list
		while (listEl.children.length > MAX_ITEMS) {
			listEl.removeChild(listEl.lastChild);
		}
		// auto-remove
		setTimeout(() => {
			if (item.parentNode === listEl) {
				try { listEl.removeChild(item); } catch (_e) {}
			}
		}, ITEM_TTL_MS);
	}

	function connectSocket(httpBase, meetingId) {
		if (!window.io || typeof window.io !== 'function') {
			console.log('[feedback-overlay] window.io not available -> startPolling', {
				meetingId,
			});
			startPolling(httpBase, meetingId);
			return;
		}
		try {
			if (socket) {
				try {
					socket.removeAllListeners();
					socket.disconnect();
				} catch (_e) {}
				socket = null;
			}
			if (connectErrorFallbackTimer) {
				clearTimeout(connectErrorFallbackTimer);
				connectErrorFallbackTimer = null;
			}
			socket = window.io(httpBase, {
				transports: ['websocket'],
				// Avoid credentialed CORS unless the API uses cookies; '*' + credentials breaks some handshakes.
				withCredentials: false,
				reconnection: true,
				reconnectionAttempts: 10,
				reconnectionDelay: 1000
			});
		} catch (_e) {
			console.log('[feedback-overlay] socket.io init failed -> startPolling', {
				meetingId,
			});
			startPolling(httpBase, meetingId);
			return;
		}

		socket.on('connect', () => {
			console.log('[feedback-overlay] socket connect', { meetingId });
			if (disconnectFallbackTimer) {
				clearTimeout(disconnectFallbackTimer);
				disconnectFallbackTimer = null;
			}
			if (connectErrorFallbackTimer) {
				clearTimeout(connectErrorFallbackTimer);
				connectErrorFallbackTimer = null;
			}
			emitJoinRoom(meetingId);
		});
		socket.on('room-joined', (payload) => {
			const joinedRoom = payload && payload.room ? String(payload.room) : '';
			console.log('[feedback-overlay] room-joined', {
				meetingId,
				room: joinedRoom,
				recentCount: Array.isArray(payload?.recent) ? payload.recent.length : 0,
			});
			metricsBaselineDone = true;
			replayRecent(payload?.recent);
			stopPolling();
		});
		socket.on('feedback', (payload) => {
			addPayloadIfNew(payload);
		});
		socket.on('disconnect', () => {
			console.log('[feedback-overlay] socket disconnect', { meetingId });
			if (disconnectFallbackTimer) {
				clearTimeout(disconnectFallbackTimer);
			}
			// Fallback only if still disconnected after delay (avoids polling after a quick reconnect).
			disconnectFallbackTimer = setTimeout(() => {
				disconnectFallbackTimer = null;
				try {
					if (socket && socket.connected) return;
				} catch (_e) {}
				startPolling(httpBase, meetingId);
			}, 1000);
		});
		socket.on('connect_error', (err) => {
			console.log('[feedback-overlay] socket connect_error', {
				meetingId,
				message: err && err.message ? err.message : String(err),
			});
			// Immediate polling races with Socket.IO retries; wait before fallback so a successful connect can clear this path.
			if (!connectErrorFallbackTimer) {
				connectErrorFallbackTimer = setTimeout(() => {
					connectErrorFallbackTimer = null;
					try {
						if (socket && socket.connected) return;
					} catch (_e) {}
					startPolling(httpBase, meetingId);
				}, 2500);
			}
		});

		// Register listeners before this fast-path join, otherwise the immediate server
		// response can be missed on already-connected transports.
		try {
			if (socket && socket.connected) {
				console.log('[feedback-overlay] socket already connected (fast path) -> join-room', {
					meetingId,
				});
				emitJoinRoom(meetingId);
			}
		} catch (_e) {}
	}

	function startPolling(httpBase, meetingId) {
		if (pollTimer) return;
		console.log('[feedback-overlay] startPolling', { meetingId });
		const url = `${httpBase}/feedback/metrics/${encodeURIComponent(meetingId)}`;
		const poll = async () => {
			try {
				const res = await fetch(url, { credentials: 'include' });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = await res.json();
				if (!pollingModeLogged) {
					if (Array.isArray(data.recent) && data.recent.length > 0) {
						console.log('[feedback-overlay] polling mode=recent', {
							seedCount: data.recent.length,
						});
					} else {
						console.log('[feedback-overlay] polling mode=legacy-counts', {
							hasCounts: data && typeof data.counts === 'object',
							countKeys: data && data.counts ? Object.keys(data.counts).slice(0, 6) : [],
						});
					}
					pollingModeLogged = true;
				}
				// Prefer server-backed `recent` rows (full message + tips) — works across Railway replicas.
				if (Array.isArray(data.recent) && data.recent.length > 0) {
					const sorted = [...data.recent].sort(
						(a, b) => getEventTimeMs(a) - getEventTimeMs(b)
					);
					if (!metricsBaselineDone) {
						let renderedOnBaseline = 0;
						for (const e of sorted) {
							if (!shouldRenderRecentOnBaseline(e)) continue;
							const payload = normalizeRecentPayload(e);
							if (!payload) continue;
							addPayloadIfNew(payload);
							renderedOnBaseline += 1;
						}
						for (const e of data.recent) {
							if (e && e.id && !seenEventIds.has(String(e.id))) {
								seenEventIds.add(String(e.id));
							}
						}
						if (renderedOnBaseline > 0) {
							console.log('[feedback-overlay] polling baseline rendered recent', {
								renderedCount: renderedOnBaseline,
							});
						}
						metricsBaselineDone = true;
					} else {
						for (const e of sorted) {
							const payload = normalizeRecentPayload(e);
							if (!payload) continue;
							addPayloadIfNew(payload);
						}
					}
					lastMetrics = data;
					return;
				}
				// Legacy: count deltas only (no full message)
				if (data && data.counts && typeof data.counts === 'object') {
					if (!lastMetrics) {
						lastMetrics = data;
						return;
					}
					const prev = lastMetrics.counts || {};
					for (const k of Object.keys(data.counts)) {
						const delta = (data.counts[k] || 0) - (prev[k] || 0);
						if (delta > 0) {
							addItem({
								type: k,
								severity: 'info',
								ts: Date.now(),
								message: `Novo evento: ${k.replace(/_/g,' ')}`,
								tips: []
							});
						}
					}
					lastMetrics = data;
				}
			} catch (_e) {
				// ignore errors, keep polling
			}
		};
		pollTimer = setInterval(poll, POLL_INTERVAL_MS);
		poll().catch(() => {});
	}

	function startOverlay(payload) {
		const meetingId = String(payload?.meetingId || '').trim();
		const httpBase = String(payload?.feedbackHttpBase || '').trim();
		if (!meetingId || !httpBase) return;
		if (overlayMeetingId !== meetingId) {
			overlayMeetingId = meetingId;
			seenEventIds.clear();
			metricsBaselineDone = false;
			pollingModeLogged = false;
			lastMetrics = null;
			overlayStartedAtMs = Date.now();
		} else if (!overlayStartedAtMs) {
			overlayStartedAtMs = Date.now();
		}
		connectSocket(httpBase, meetingId);
	}

	window.addEventListener('message', (event) => {
		if (event.source !== window) return;
		const data = event.data || {};
		if (data.type === 'FEEDBACK_OVERLAY_START') {
			startOverlay(data.payload || {});
		}
	});
})();


