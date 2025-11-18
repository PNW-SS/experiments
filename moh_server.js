const dgram = require('dgram');
const { spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegPath);

// --- ⬇️ CONFIGURATION ⬇️ ---
const YOUR_SERVER_IP = '46.62.213.117';
const YOUR_AUDIO_FILE = './audio.mp3';
const SIP_PORT = 5060;
const RTP_PORT_START = 10000;
const RTP_PORT_END = 20000;
const ACK_TIMEOUT = 30000;
// --- ⬆️ CONFIGURATION ⬆️ ---


const server = dgram.createSocket('udp4');
const activeCalls = new Map();
const usedRtpPorts = new Set();
const pendingKillTimeouts = new Map(); 

if (!fs.existsSync(YOUR_AUDIO_FILE)) {
    console.error(`ERROR: Audio file not found: ${YOUR_AUDIO_FILE}`);
    console.error('Please update YOUR_AUDIO_FILE in the configuration.');
    process.exit(1);
}

function allocateRtpPort() {
    for (let port = RTP_PORT_START; port <= RTP_PORT_END; port++) {
        if (!usedRtpPorts.has(port)) {
            usedRtpPorts.add(port);
            return port;
        }
    }
    return null;
}

function releaseRtpPort(port) {
    usedRtpPorts.delete(port);
}

function cleanupCall(callId, reason = 'unknown') {
    const call = activeCalls.get(callId);
    if (!call) return;

    console.log(`[${callId}] Cleaning up call (reason: ${reason})`);

    // Clear any pending kill timeout from a previous cleanup attempt
    const pendingTimeout = pendingKillTimeouts.get(callId);
    if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingKillTimeouts.delete(callId);
    }

    if (call.ackTimeout) {
        clearTimeout(call.ackTimeout);
        call.ackTimeout = null;
    }

    if (call.killTimeout) {
        clearTimeout(call.killTimeout);
        call.killTimeout = null;
    }

    if (call.ffmpegProcess) {
        try {
            const proc = call.ffmpegProcess;
            call.ffmpegProcess = null;
            proc.kill('SIGTERM');
            // Fallback to SIGKILL after 5 seconds if still running
            const killTimeout = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch (err) {
                    // Process may have already exited
                }
                pendingKillTimeouts.delete(callId);
            }, 5000);
            pendingKillTimeouts.set(callId, killTimeout);
        } catch (err) {
            console.error(`[${callId}] Error killing FFmpeg:`, err.message);
        }
    }

    if (call.serverRtpPort) {
        releaseRtpPort(call.serverRtpPort);
    }

    activeCalls.delete(callId);
}

function parseSipMessage(msg) {
    const lines = msg.toString().split('\r\n');
    const headers = {};
    let sdp = '';
    let isSdp = false;

    for (const line of lines) {
        if (line === '') {
            isSdp = true;
            continue;
        }

        if (isSdp) {
            sdp += line + '\r\n';
        } else {
            const parts = line.split(': ');
            if (parts.length >= 2) {
                const key = parts[0].trim();
                const value = parts.slice(1).join(': ').trim();
                headers[key] = value;
            }
        }
    }
    return { headers, sdp };
}

function getSdpAudioPort(sdp) {
    if (!sdp) return null;
    const match = sdp.match(/m=audio (\d+) RTP/);
    if (!match) return null;
    const port = parseInt(match[1], 10);
    return (port > 0 && port < 65536) ? port : null;
}

function getSdpConnectionIp(sdp) {
    if (!sdp) return null;
    const match = sdp.match(/c=IN IP4 ([\d.]+)/);
    return match ? match[1] : null;
}

function getHeaderValue(headers, key) {
    return headers[key] || headers[key.toLowerCase()] || headers[key.toUpperCase()];
}

function sendSipResponse(response, port, address, callId) {
    console.log(`<<< Sending to ${address}:${port}`);
    server.send(response, port, address, (err) => {
        if (err) {
            console.error(`[${callId}] Error sending SIP response:`, err.message);
        } else {
            console.log(`[${callId}] Response sent successfully`);
        }
    });
}

server.on('message', (msg, rinfo) => {
    const msgStr = msg.toString();

    // Log all incoming messages
    const firstLine = msgStr.split('\r\n')[0];
    console.log(`\n>>> Received from ${rinfo.address}:${rinfo.port}: ${firstLine}`);

    // Basic validation
    if (msgStr.length > 65535) {
        console.warn(`Dropping oversized message from ${rinfo.address}:${rinfo.port}`);
        return;
    }

    const { headers, sdp } = parseSipMessage(msgStr);
    const callId = getHeaderValue(headers, 'Call-ID');

    if (!callId) {
        console.warn(`Received SIP message without Call-ID from ${rinfo.address}:${rinfo.port}`);
        return;
    }

    if (msgStr.startsWith('INVITE')) {
        console.log(`[${callId}] Received INVITE from ${rinfo.address}:${rinfo.port}`);
        console.log('===== FULL INVITE MESSAGE =====');
        console.log(msgStr);
        console.log('===== END INVITE =====');

        // Check if this is a retransmission of an existing call
        const existingCall = activeCalls.get(callId);
        const currentCSeq = getHeaderValue(headers, 'CSeq');
        const currentVia = getHeaderValue(headers, 'Via');
        if (existingCall && existingCall.cseq === currentCSeq && existingCall.via === currentVia) {
            console.log(`[${callId}] INVITE retransmission detected - resending 200 OK`);

            // Reset ACK timeout since we're retransmitting the 200 OK
            if (existingCall.ackTimeout) {
                clearTimeout(existingCall.ackTimeout);
                console.log(`[${callId}] Cleared previous ACK timeout, setting new one for ${ACK_TIMEOUT}ms`);
            }
            existingCall.ackTimeout = setTimeout(() => {
                console.warn(`[${callId}] ACK timeout - cleaning up call`);
                cleanupCall(callId, 'ACK timeout');
            }, ACK_TIMEOUT);

            const sdpResponse = [
                'v=0',
                `o=- ${Date.now()} ${Date.now()} IN IP4 ${YOUR_SERVER_IP}`,
                's=Music On Hold',
                `c=IN IP4 ${YOUR_SERVER_IP}`,
                't=0 0',
                `m=audio ${existingCall.serverRtpPort} RTP/AVP 0`,
                'a=rtpmap:0 PCMU/8000',
                'a=sendonly',
                'a=ptime:20'
            ].join('\r\n');

            const response = [
                `SIP/2.0 200 OK`,
                `Via: ${existingCall.via}`,
                `From: ${existingCall.from}`,
                `To: ${existingCall.to};tag=${existingCall.toTag}`,
                `Call-ID: ${existingCall.callId}`,
                `CSeq: ${existingCall.cseq}`,
                'Contact: <sip:moh@' + YOUR_SERVER_IP + ':' + SIP_PORT + '>',
                'Allow: INVITE, ACK, BYE, CANCEL',
                'Supported: replaces',
                'Content-Type: application/sdp',
                `Content-Length: ${sdpResponse.length}`,
                '',
                sdpResponse
            ].join('\r\n');

            console.log('===== RESENDING 200 OK (retransmission) =====');
            console.log(response);
            console.log('===== END 200 OK =====');
            sendSipResponse(response, rinfo.port, rinfo.address, callId);
            return;
        }

        // If not a retransmission but call exists, cleanup the old call first
        if (existingCall) {
            console.log(`[${callId}] New INVITE with same Call-ID but different CSeq/Via - cleaning up old call`);
            cleanupCall(callId, 'new INVITE with same Call-ID');
        }

        const clientRtpPort = getSdpAudioPort(sdp);
        if (!clientRtpPort) {
            console.error(`[${callId}] Could not find valid m=audio port in SDP. Sending 400 Bad Request.`);
            const badRequestResponse = [
                `SIP/2.0 400 Bad Request`,
                `Via: ${getHeaderValue(headers, 'Via')}`,
                `From: ${getHeaderValue(headers, 'From')}`,
                `To: ${getHeaderValue(headers, 'To')}`,
                `Call-ID: ${callId}`,
                `CSeq: ${getHeaderValue(headers, 'CSeq')}`,
                'Content-Length: 0',
                ''
            ].join('\r\n');
            sendSipResponse(badRequestResponse, rinfo.port, rinfo.address, callId);
            return;
        }

        const clientRtpIp = getSdpConnectionIp(sdp) || rinfo.address;

        // Allocate unique RTP port for this call
        const serverRtpPort = allocateRtpPort();
        if (!serverRtpPort) {
            console.error(`[${callId}] No available RTP ports. Rejecting call.`);
            const busyResponse = [
                `SIP/2.0 486 Busy Here`,
                `Via: ${getHeaderValue(headers, 'Via')}`,
                `From: ${getHeaderValue(headers, 'From')}`,
                `To: ${getHeaderValue(headers, 'To')}`,
                `Call-ID: ${callId}`,
                `CSeq: ${getHeaderValue(headers, 'CSeq')}`,
                'Content-Length: 0',
                ''
            ].join('\r\n');
            sendSipResponse(busyResponse, rinfo.port, rinfo.address, callId);
            return;
        }

        const toTag = `moh${Math.random().toString(36).substring(7)}`;
        const callInfo = {
            callId: callId,
            from: getHeaderValue(headers, 'From'),
            to: getHeaderValue(headers, 'To'),
            cseq: getHeaderValue(headers, 'CSeq'),
            via: getHeaderValue(headers, 'Via'),
            clientSipIp: rinfo.address,
            clientSipPort: rinfo.port,
            clientRtpIp: clientRtpIp,
            clientRtpPort: clientRtpPort,
            serverRtpPort: serverRtpPort,
            toTag: toTag,
            ffmpegProcess: null,
            ackTimeout: null,
            killTimeout: null
        };

        // Set timeout to cleanup if ACK is never received
        console.log(`[${callId}] Setting ACK timeout for ${ACK_TIMEOUT}ms`);
        callInfo.ackTimeout = setTimeout(() => {
            console.warn(`[${callId}] ACK timeout - cleaning up call`);
            cleanupCall(callId, 'ACK timeout');
        }, ACK_TIMEOUT);

        activeCalls.set(callId, callInfo);

        const sdpResponse = [
            'v=0',
            `o=- ${Date.now()} ${Date.now()} IN IP4 ${YOUR_SERVER_IP}`,
            's=Music On Hold',
            `c=IN IP4 ${YOUR_SERVER_IP}`,
            't=0 0',
            `m=audio ${serverRtpPort} RTP/AVP 0`,
            'a=rtpmap:0 PCMU/8000',
            'a=sendonly',
            'a=ptime:20'
        ].join('\r\n');

        const response = [
            `SIP/2.0 200 OK`,
            `Via: ${callInfo.via}`,
            `From: ${callInfo.from}`,
            `To: ${callInfo.to};tag=${toTag}`,
            `Call-ID: ${callInfo.callId}`,
            `CSeq: ${callInfo.cseq}`,
            'Contact: <sip:moh@' + YOUR_SERVER_IP + ':' + SIP_PORT + '>',
            'Allow: INVITE, ACK, BYE, CANCEL',
            'Supported: replaces',
            'Content-Type: application/sdp',
            `Content-Length: ${sdpResponse.length}`,
            '',
            sdpResponse
        ].join('\r\n');

        console.log('===== SENDING 200 OK =====');
        console.log(response);
        console.log('===== END 200 OK =====');
        sendSipResponse(response, rinfo.port, rinfo.address, callId);
        console.log(`[${callId}] Sent 200 OK with RTP port ${serverRtpPort}. Waiting for ACK.`);
    }

    else if (msgStr.startsWith('ACK')) {
        console.log('===== FULL ACK MESSAGE =====');
        console.log(msgStr);
        console.log('===== END ACK =====');

        const call = activeCalls.get(callId);
        if (call && !call.ffmpegProcess) {
            console.log(`[${callId}] Received ACK. Starting FFmpeg stream...`);

            // Clear the ACK timeout
            if (call.ackTimeout) {
                clearTimeout(call.ackTimeout);
                call.ackTimeout = null;
            }

            const rtpUrl = `rtp://${call.clientRtpIp}:${call.clientRtpPort}`;

            try {
                const ffmpegProc = ffmpeg(YOUR_AUDIO_FILE)
                    .inputOptions(['-re', '-stream_loop', '-1'])
                    .noVideo()
                    .audioFrequency(8000)
                    .audioChannels(1)
                    .audioCodec('pcm_mulaw')
                    .format('rtp')
                    .outputOptions([
                        '-localaddr', `${YOUR_SERVER_IP}`,
                        '-localport', `${call.serverRtpPort}`
                    ])
                    .on('start', (cmd) => {
                        console.log(`[${callId}] FFmpeg started: ${cmd}`);
                        // Verify process is still alive after startup
                        setTimeout(() => {
                            if (call.ffmpegProcess && call.ffmpegProcess.killed) {
                                console.error(`[${callId}] FFmpeg process died immediately after startup`);
                                cleanupCall(callId, 'FFmpeg immediate crash');
                            }
                        }, 500);
                    })
                    .on('error', (err) => {
                        console.error(`[${callId}] FFmpeg error:`, err.message);
                        // Only cleanup if call still exists
                        if (activeCalls.has(callId)) {
                            cleanupCall(callId, 'FFmpeg error');
                        }
                    })
                    .on('end', () => {
                        console.log(`[${callId}] FFmpeg stream finished.`);
                        // Only cleanup if call still exists
                        if (activeCalls.has(callId)) {
                            cleanupCall(callId, 'stream ended');
                        }
                    })
                    .save(rtpUrl);

                // Store the underlying FFmpeg process for proper cleanup
                call.ffmpegProcess = ffmpegProc.ffmpegProc;

                // Handle process exit events
                if (call.ffmpegProcess) {
                    call.ffmpegProcess.on('exit', (code, signal) => {
                        console.log(`[${callId}] FFmpeg process exited with code ${code}, signal ${signal}`);
                        if (activeCalls.has(callId) && code !== 0 && code !== null) {
                            cleanupCall(callId, `FFmpeg exit code ${code}`);
                        }
                    });
                }

                activeCalls.set(callId, call);
            } catch (err) {
                console.error(`[${callId}] Failed to start FFmpeg:`, err.message);
                cleanupCall(callId, 'FFmpeg startup failed');
            }
        } else if (call && call.ffmpegProcess) {
            console.log(`[${callId}] Received duplicate ACK (FFmpeg already running) - ignoring`);
        } else {
            console.warn(`[${callId}] Received ACK for unknown call - ignoring`);
        }
    }

    else if (msgStr.startsWith('BYE')) {
        console.log(`[${callId}] Received BYE from ${rinfo.address}:${rinfo.port}. Stopping stream.`);
        console.log('===== FULL BYE MESSAGE =====');
        console.log(msgStr);
        console.log('===== END BYE =====');

        const call = activeCalls.get(callId);

        if (call) {
            const response = [
                `SIP/2.0 200 OK`,
                `Via: ${getHeaderValue(headers, 'Via')}`,
                `From: ${getHeaderValue(headers, 'From')}`,
                `To: ${getHeaderValue(headers, 'To')};tag=${call.toTag}`,
                `Call-ID: ${call.callId}`,
                `CSeq: ${getHeaderValue(headers, 'CSeq')}`,
                'Allow: INVITE, ACK, BYE, CANCEL',
                'Content-Length: 0',
                ''
            ].join('\r\n');

            sendSipResponse(response, rinfo.port, rinfo.address, callId);
            cleanupCall(callId, 'BYE received');
            console.log(`[${callId}] Call terminated.`);
        }
    }

    else if (msgStr.startsWith('CANCEL')) {
        console.log(`[${callId}] Received CANCEL.`);
        const call = activeCalls.get(callId);

        if (call) {
            const response = [
                `SIP/2.0 200 OK`,
                `Via: ${getHeaderValue(headers, 'Via')}`,
                `From: ${getHeaderValue(headers, 'From')}`,
                `To: ${getHeaderValue(headers, 'To')}`,
                `Call-ID: ${call.callId}`,
                `CSeq: ${getHeaderValue(headers, 'CSeq')}`,
                'Allow: INVITE, ACK, BYE, CANCEL',
                'Content-Length: 0',
                ''
            ].join('\r\n');

            sendSipResponse(response, rinfo.port, rinfo.address, callId);
            cleanupCall(callId, 'CANCEL received');
        }
    }

    else {
        // Handle unsupported or malformed SIP methods
        const firstLine = msgStr.split('\r\n')[0];
        const methodMatch = firstLine.match(/^([A-Z]+)\s/);

        if (!methodMatch) {
            // Malformed request - no valid SIP method found
            console.warn(`[${callId}] Malformed SIP message from ${rinfo.address}:${rinfo.port}`);
            const via = getHeaderValue(headers, 'Via');
            const from = getHeaderValue(headers, 'From');
            const to = getHeaderValue(headers, 'To');
            const cseq = getHeaderValue(headers, 'CSeq');

            if (via && from && to && cseq) {
                const response = [
                    `SIP/2.0 400 Bad Request`,
                    `Via: ${via}`,
                    `From: ${from}`,
                    `To: ${to}`,
                    `Call-ID: ${callId}`,
                    `CSeq: ${cseq}`,
                    'Content-Length: 0',
                    ''
                ].join('\r\n');
                sendSipResponse(response, rinfo.port, rinfo.address, callId);
            }
        } else {
            // Valid SIP method but not supported by this server
            const method = methodMatch[1];
            console.warn(`[${callId}] Unsupported SIP method: ${method} from ${rinfo.address}:${rinfo.port}`);
            const via = getHeaderValue(headers, 'Via');
            const from = getHeaderValue(headers, 'From');
            const to = getHeaderValue(headers, 'To');
            const cseq = getHeaderValue(headers, 'CSeq');

            if (via && from && to && cseq) {
                const response = [
                    `SIP/2.0 501 Not Implemented`,
                    `Via: ${via}`,
                    `From: ${from}`,
                    `To: ${to}`,
                    `Call-ID: ${callId}`,
                    `CSeq: ${cseq}`,
                    'Allow: INVITE, ACK, BYE, CANCEL',
                    'Content-Length: 0',
                    ''
                ].join('\r\n');
                sendSipResponse(response, rinfo.port, rinfo.address, callId);
            }
        }
    }
});

server.on('error', (err) => {
    console.error('Server error:', err);
});

server.on('listening', () => {
    console.log(`Music on Hold server listening on ${YOUR_SERVER_IP}:${SIP_PORT}`);
    console.log(`Audio file: ${YOUR_AUDIO_FILE}`);
    console.log(`RTP port range: ${RTP_PORT_START}-${RTP_PORT_END}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down gracefully...');
    for (const [callId] of activeCalls) {
        cleanupCall(callId, 'server shutdown');
    }
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
});

server.bind(SIP_PORT, YOUR_SERVER_IP);
