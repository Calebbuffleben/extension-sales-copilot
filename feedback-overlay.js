(function () {
	const MAX_ITEMS = 6;
	const ITEM_TTL_MS = 15000;
	const POLL_INTERVAL_MS = 2000; // fallback polling

	let overlayRoot = null;
	let listEl = null;
	let socket = null;
	let lastMetrics = null;
	let pollTimer = null;

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
			startPolling(httpBase, meetingId);
			return;
		}
		try {
			socket = window.io(httpBase, {
				transports: ['websocket'],
				withCredentials: true
			});
		} catch (_e) {
			startPolling(httpBase, meetingId);
			return;
		}
		socket.on('connect', () => {
			try {
				socket.emit('join-room', `feedback:${meetingId}`);
			} catch (_e) {}
		});
		socket.on('feedback', (payload) => {
			if (payload && typeof payload === 'object') {
				addItem(payload);
			}
		});
		socket.on('disconnect', () => {
			// fallback to polling after a short delay
			setTimeout(() => {
				startPolling(httpBase, meetingId);
			}, 1000);
		});
		socket.on('connect_error', () => {
			startPolling(httpBase, meetingId);
		});
	}

	function startPolling(httpBase, meetingId) {
		if (pollTimer) return;
		const url = `${httpBase}/feedback/metrics/${encodeURIComponent(meetingId)}`;
		const poll = async () => {
			try {
				const res = await fetch(url, { credentials: 'include' });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = await res.json();
				// Compare counts and synthesize informational items when counters change
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


