// Meet Participant Detector
// Purpose: Identify participants and map WebRTC tracks to participant names
// Strategies: DOM observation, timing correlation, track inspection

(function () {
	console.log('[participant-detector] Initializing');

	// Participant registry: participantId -> participant info
	const participantsRegistry = new Map();
	
	// Track to participant mapping: trackId -> participantId
	const trackToParticipant = new Map();
	
	// Stream to participant mapping: streamId -> participantId (for grouping tracks from same stream)
	const streamToParticipant = new Map();
	
	// Pending tracks waiting for participant assignment
	const pendingTracks = new Map(); // trackId -> { timestamp, trackLabel, streamId }

	// Configuration
	const TRACK_ASSIGNMENT_WINDOW_MS = 3000; // Correlate tracks within 3s of participant join

	// Strategy 1: DOM Observation for participant names
	function observeParticipants() {
		// Google Meet participant selectors (may need updates if Meet changes)
		const PARTICIPANT_SELECTORS = [
			'[data-participant-id]',
			'[data-requested-participant-id]',
			'[jsname][data-self-name]', // Self participant
			'div[jscontroller][jsaction*="participant"]',
			// Fallback: look for name elements in participant tiles
			'[data-participant-name]',
		];

		// Try to find participant container
		const findParticipantContainer = () => {
			// Meet's participant grid/list containers
			const containers = [
				document.querySelector('[jsname="EQ1It"]'), // Participant grid
				document.querySelector('[jsname="cnqP9"]'), // Participant list sidebar
				document.querySelector('[role="list"]'), // Generic list
			];
			return containers.find((c) => c !== null);
		};

		// Extract participant from DOM element
		const extractParticipantInfo = (element) => {
			const info = {
				participantId: null,
				name: null,
				element,
				timestamp: Date.now(),
			};

			// Try to extract ID
			info.participantId =
				element.getAttribute('data-participant-id') ||
				element.getAttribute('data-requested-participant-id') ||
				element.getAttribute('data-self-name') ||
				null;

			// Try to extract name
			// Look for text content in specific elements
			const nameElements = element.querySelectorAll(
				'[data-self-name], [aria-label], span[data-participant-name]',
			);
			for (const el of nameElements) {
				const text = el.getAttribute('data-self-name') || el.getAttribute('aria-label') || el.textContent;
				if (text && text.trim() && text.length < 100) {
					info.name = text.trim();
					break;
				}
			}

			// Fallback: use aria-label from parent
			if (!info.name) {
				const ariaLabel = element.getAttribute('aria-label');
				if (ariaLabel && ariaLabel.length < 100) {
					info.name = ariaLabel;
				}
			}

			// Generate fallback ID if needed
			if (!info.participantId && info.name) {
				info.participantId = `participant-${info.name.replace(/\s+/g, '-').toLowerCase()}`;
			}

			return info;
		};

		// Scan for participants
		const scanParticipants = () => {
			const container = findParticipantContainer();
			if (!container) {
				console.log('[participant-detector] No participant container found yet');
				return;
			}

			let found = 0;
			for (const selector of PARTICIPANT_SELECTORS) {
				const elements = container.querySelectorAll(selector);
				for (const element of elements) {
					const info = extractParticipantInfo(element);
					if (info.participantId || info.name) {
						found++;
						
						// Check if new participant
						if (!participantsRegistry.has(info.participantId)) {
							console.log('[participant-detector] 👤 New participant detected:', info);
							participantsRegistry.set(info.participantId, info);

							// Notify about new participant
							window.postMessage(
								{
									type: 'MEET_PARTICIPANT_JOINED',
									participantId: info.participantId,
									participantName: info.name,
									timestamp: info.timestamp,
								},
								'*',
							);

							// Try to assign pending tracks
							assignPendingTracks(info.participantId, info.timestamp);
						}
					}
				}
			}

			if (found > 0) {
				console.log(`[participant-detector] Found ${found} participant elements, registry has ${participantsRegistry.size}`);
			}
		};

		// Initial scan
		scanParticipants();

		// Periodic scan (Meet updates DOM dynamically)
		setInterval(scanParticipants, 2000);

		// MutationObserver for real-time updates
		const observer = new MutationObserver(() => {
			scanParticipants();
		});

		// Observe the entire document (Meet's structure is complex)
		observer.observe(document.body, {
			childList: true,
			subtree: true,
		});

		console.log('[participant-detector] DOM observation started');
	}

	// Strategy 2: Timing Correlation
	// Assign pending tracks to participants based on timing
	function assignPendingTracks(participantId, participantJoinedAt) {
		const assigned = [];
		
		for (const [trackId, trackInfo] of pendingTracks.entries()) {
			const timeDiff = Math.abs(trackInfo.timestamp - participantJoinedAt);
			
			// If track arrived within window of participant join
			if (timeDiff < TRACK_ASSIGNMENT_WINDOW_MS) {
				console.log(`[participant-detector] 🔗 Assigning track ${trackId} to participant ${participantId} (timeDiff: ${timeDiff}ms)`);
				
				trackToParticipant.set(trackId, participantId);
				assigned.push(trackId);

				// Notify audio-capture
				window.postMessage(
					{
						type: 'TRACK_PARTICIPANT_MAPPED',
						trackId,
						participantId,
						participantName: participantsRegistry.get(participantId)?.name,
						timestamp: Date.now(),
					},
					'*',
				);
			}
		}

		// Remove assigned tracks from pending
		for (const trackId of assigned) {
			pendingTracks.delete(trackId);
		}
	}

	// Strategy 3: Track Label Inspection
	function inspectTrackLabel(trackLabel, streamId) {
		// Some WebRTC implementations include participant info in labels
		// Example: "remote-audio-participant-123"
		
		if (!trackLabel) return null;

		// Try to extract participant ID from label
		const patterns = [
			/participant[_-](\w+)/i,
			/user[_-](\w+)/i,
			/peer[_-](\w+)/i,
		];

		for (const pattern of patterns) {
			const match = trackLabel.match(pattern);
			if (match) {
				const possibleId = match[1];
				console.log(`[participant-detector] Extracted potential participant ID from track label: ${possibleId}`);
				return possibleId;
			}
		}

		return null;
	}

	// Listen for track additions from webrtc-interceptor
	window.addEventListener('message', (event) => {
		if (event.source !== window) return;
		const data = event.data || {};

		if (data.type === 'WEBRTC_TRACK_ADDED') {
			const { trackId, trackLabel, streamId, timestamp } = data;
			console.log(`[participant-detector] Track added: ${trackId}`, { trackLabel, streamId });

			// Try to identify participant from track label
			const possibleId = inspectTrackLabel(trackLabel, streamId);
			if (possibleId && participantsRegistry.has(possibleId)) {
				// Direct match!
				console.log(`[participant-detector] 🎯 Direct match: track ${trackId} → participant ${possibleId}`);
				trackToParticipant.set(trackId, possibleId);
				
				window.postMessage(
					{
						type: 'TRACK_PARTICIPANT_MAPPED',
						trackId,
						participantId: possibleId,
						participantName: participantsRegistry.get(possibleId)?.name,
						timestamp: Date.now(),
					},
					'*',
				);
				return;
			}

			// No direct match, try timing correlation
			const now = Date.now();
			for (const [participantId, info] of participantsRegistry.entries()) {
				const timeDiff = Math.abs(timestamp - info.timestamp);
				if (timeDiff < TRACK_ASSIGNMENT_WINDOW_MS) {
					console.log(`[participant-detector] 🔗 Timing match: track ${trackId} → participant ${participantId} (timeDiff: ${timeDiff}ms)`);
					trackToParticipant.set(trackId, participantId);
					
					window.postMessage(
						{
							type: 'TRACK_PARTICIPANT_MAPPED',
							trackId,
							participantId,
							participantName: info.name,
							timestamp: Date.now(),
						},
						'*',
					);
					return;
				}
			}

		// No match yet, add to pending
		console.log(`[participant-detector] Track ${trackId} pending assignment`);
		
		// Strategy: Group tracks by streamId or timing to avoid creating multiple participants for same person
		const TIMING_GROUP_WINDOW_MS = 500; // Group tracks within 500ms as same participant
		let groupedParticipantId = null;
		
		// Try to group with other pending tracks by streamId or timing
		for (const [pendingTrackId, pendingInfo] of pendingTracks.entries()) {
			// Group by same streamId
			if (streamId && pendingInfo.streamId === streamId) {
				groupedParticipantId = pendingInfo.fallbackId;
				console.log(`[participant-detector] 🔗 Grouping track ${trackId} with ${pendingTrackId} by streamId: ${streamId} → ${groupedParticipantId}`);
				break;
			}
			// Group by timing (tracks arriving close together likely belong to same participant)
			const timeDiff = Math.abs(timestamp - pendingInfo.timestamp);
			if (timeDiff < TIMING_GROUP_WINDOW_MS && pendingInfo.fallbackId) {
				groupedParticipantId = pendingInfo.fallbackId;
				console.log(`[participant-detector] 🔗 Grouping track ${trackId} with ${pendingTrackId} by timing (timeDiff: ${timeDiff}ms) → ${groupedParticipantId}`);
				break;
			}
		}
		
		// If only one participant is known, assign all pending tracks to them
		if (!groupedParticipantId && participantsRegistry.size === 1) {
			const singleParticipantId = participantsRegistry.keys().next().value;
			console.log(`[participant-detector] 💡 Only one participant known, assigning track ${trackId} to ${singleParticipantId}`);
			trackToParticipant.set(trackId, singleParticipantId);
			window.postMessage(
				{
					type: 'TRACK_PARTICIPANT_MAPPED',
					trackId,
					participantId: singleParticipantId,
					participantName: participantsRegistry.get(singleParticipantId)?.name,
					timestamp: Date.now(),
				},
				'*',
			);
			return;
		}
		
		// Create fallback ID (grouped if available, otherwise create new unique)
		const fallbackId = groupedParticipantId || `participant-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
		
		pendingTracks.set(trackId, { timestamp, trackLabel, streamId, fallbackId });
		
		// Wait a bit, then assign fallback if still pending
		setTimeout(() => {
			if (pendingTracks.has(trackId)) {
				console.log(`[participant-detector] ⏰ Assigning fallback ID to track ${trackId}: ${fallbackId}`);
				trackToParticipant.set(trackId, fallbackId);
				pendingTracks.delete(trackId);

				// Create synthetic participant entry
				if (!participantsRegistry.has(fallbackId)) {
					const participantNumber = participantsRegistry.size + 1;
					participantsRegistry.set(fallbackId, {
						participantId: fallbackId,
						name: `Participant ${participantNumber}`,
						element: null,
						timestamp: Date.now(),
						isFallback: true,
					});
				}

					window.postMessage(
						{
							type: 'TRACK_PARTICIPANT_MAPPED',
							trackId,
							participantId: fallbackId,
							participantName: participantsRegistry.get(fallbackId)?.name,
							timestamp: Date.now(),
							isFallback: true,
						},
						'*',
					);
				}
			}, TRACK_ASSIGNMENT_WINDOW_MS);
		}

		if (data.type === 'WEBRTC_TRACK_REMOVED') {
			const { trackId } = data;
			const participantId = trackToParticipant.get(trackId);
			if (participantId) {
				console.log(`[participant-detector] Track ${trackId} removed (was assigned to ${participantId})`);
				trackToParticipant.delete(trackId);
			}
			pendingTracks.delete(trackId);
		}
	});

	// Start observation after DOM is ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', observeParticipants);
	} else {
		// DOM already ready
		setTimeout(observeParticipants, 1000); // Delay to let Meet initialize
	}

	// Expose for debugging
	window.__participantDetector = {
		participantsRegistry,
		trackToParticipant,
		pendingTracks,
		getParticipantForTrack: (trackId) => trackToParticipant.get(trackId),
		getAllParticipants: () => Array.from(participantsRegistry.values()),
	};

	console.log('[participant-detector] ✅ Initialized');
})();

