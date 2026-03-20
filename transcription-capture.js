// Script para capturar transcrições do Google Meet
(function () {
	// TODO: (Flow) Caption-based transcription ingestion is currently not used in the main pipeline (audio → Whisper). Keep only if you want to ingest Meet captions via `/egress-transcription`.
	const DEFAULT_WS_URL = 'wss://backend-analysis-production-a688.up.railway.app/egress-transcription';
	const POLL_INTERVAL_MS = 1000; // Verificar a cada 1 segundo

	let ws = null;
	let meetingId = null;
	let participantId = null;
	let lastTranscription = '';
	let wsUrl = null;

	function getMeetingId() {
		// Tentar extrair meeting ID da URL
		const url = window.location.href;
		const match = url.match(/\/meet\/([a-z-]+)/i);
		return match ? match[1] : `meet_${Date.now()}`;
	}

	function getParticipantId() {
		// Tentar extrair participant ID do DOM ou gerar
		// Por enquanto, gerar ID único
		if (!window.__meetParticipantId) {
			window.__meetParticipantId = `user_${Math.random().toString(36).substr(2, 9)}`;
		}
		return window.__meetParticipantId;
	}

	function findTranscriptionElement() {
		// Procurar elemento de transcrição no Google Meet
		// O Google Meet pode ter diferentes seletores
		const selectors = [
			'[data-transcription-text]',
			'[jsname="YbUplb"]', // Possível seletor do Meet
			'.transcription-text',
			'[aria-live="polite"]',
		];

		for (const selector of selectors) {
			const element = document.querySelector(selector);
			if (element && element.textContent.trim()) {
				return element;
			}
		}

		// Fallback: procurar por elementos com texto que muda frequentemente
		const allElements = document.querySelectorAll('[aria-live], [role="log"]');
		for (const el of allElements) {
			if (el.textContent.trim().length > 10) {
				return el;
			}
		}

		return null;
	}

	function openWebSocket() {
		if (ws && ws.readyState === WebSocket.OPEN) {
			return;
		}

		meetingId = getMeetingId();
		participantId = getParticipantId();
		wsUrl = `${DEFAULT_WS_URL}?meetingId=${encodeURIComponent(meetingId)}&participantId=${encodeURIComponent(participantId)}&language=pt-BR`;

		console.log('[transcription-capture] Opening WebSocket:', wsUrl);

		ws = new WebSocket(wsUrl);

		ws.onopen = () => {
			console.log('[transcription-capture] WebSocket connected');
		};

		ws.onerror = (error) => {
			console.error('[transcription-capture] WebSocket error:', error);
		};

		ws.onclose = () => {
			console.log('[transcription-capture] WebSocket closed, reconnecting...');
			setTimeout(openWebSocket, 2000);
		};
	}

	function sendTranscription(text) {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			return;
		}

		if (text === lastTranscription) {
			return; // Evitar duplicatas
		}

		lastTranscription = text;

		const payload = {
			text: text.trim(),
			timestamp: Date.now(),
			confidence: 0.9, // Placeholder
		};

		try {
			ws.send(JSON.stringify(payload));
			console.log('[transcription-capture] Sent:', text.substring(0, 50));
		} catch (error) {
			console.error('[transcription-capture] Send error:', error);
		}
	}

	function startPolling() {
		openWebSocket();

		setInterval(() => {
			const element = findTranscriptionElement();
			if (element) {
				const text = element.textContent.trim();
				if (text && text.length > 5) {
					sendTranscription(text);
				}
			}
		}, POLL_INTERVAL_MS);
	}

	// Iniciar quando DOM estiver pronto
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', startPolling);
	} else {
		startPolling();
	}

	console.log('[transcription-capture] Script loaded');
})();

