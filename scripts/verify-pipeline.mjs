/**
 * End-to-end check of the backend media pipeline.
 *
 * Starts a session for a real channel and validates the bytes that come out of
 * the WebSocket: 188-byte TS packets with valid sync bytes, H.264 NAL units and
 * AAC audio present. This is the layer below the webview — if it passes here,
 * mpegts.js is receiving genuine transport stream, not silence.
 *
 * Usage: node scripts/verify-pipeline.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8787'

const log = (...args) => console.log('[verify]', ...args)

async function json(path, options) {
  const response = await fetch(`${BASE}${path}`, options)
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`)
  return response.json()
}

/** Depacketise the PSI sections so the codec can be identified from the PMT. */
function parsePsi(bytes) {
  const pmt = new Map()
  for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
    if (bytes[offset] !== 0x47) continue
    const pid = ((bytes[offset + 1] & 0x1f) << 8) | bytes[offset + 2]
    const payloadStart = (bytes[offset + 1] & 0x40) !== 0
    const adaptationControl = (bytes[offset + 3] & 0x30) >> 4
    let cursor = offset + 4
    if (adaptationControl === 2 || adaptationControl === 3) {
      cursor += 1 + bytes[cursor]
      if (cursor >= offset + 188) continue
    }
    if (adaptationControl !== 1 && adaptationControl !== 3) continue
    if (!payloadStart) continue
    const pointer = bytes[cursor]
    cursor += 1 + pointer
    if (cursor >= offset + 188) continue

    // PAT: table_id 0x00 -> program_map_PID
    if (bytes[cursor] === 0x00) {
      const sectionLength = ((bytes[cursor + 1] & 0x0f) << 8) | bytes[cursor + 2]
      const end = cursor + 3 + sectionLength - 4
      for (let i = cursor + 8; i + 3 <= end; i += 4) {
        const program = (bytes[i] << 8) | bytes[i + 1]
        const pid = ((bytes[i + 2] & 0x1f) << 8) | bytes[i + 3]
        if (program !== 0) pmt.set('__pmt__', pid)
      }
    }
    // PMT: table_id 0x02 -> elementary stream types
    if (bytes[cursor] === 0x02) {
      const programInfoLength = ((bytes[cursor + 10] & 0x0f) << 8) | bytes[cursor + 11]
      const sectionLength = ((bytes[cursor + 1] & 0x0f) << 8) | bytes[cursor + 2]
      const end = cursor + 3 + sectionLength - 4
      let i = cursor + 12 + programInfoLength
      while (i + 4 <= end) {
        const streamType = bytes[i]
        const pid = ((bytes[i + 1] & 0x1f) << 8) | bytes[i + 2]
        const esInfoLength = ((bytes[i + 3] & 0x0f) << 8) | bytes[i + 4]
        pmt.set(pid, streamType)
        i += 5 + esInfoLength
      }
    }
  }
  return pmt
}

const STREAM_TYPES = {
  0x0f: 'AAC',
  0x11: 'AAC-LATM',
  0x03: 'MP3',
  0x04: 'MP3',
  0x1b: 'H.264',
  0x24: 'H.265',
  0x02: 'MPEG-2',
  0x81: 'AC-3',
}

/** Collect PES payloads for one PID (assembled from continuation packets). */
function collectPts(bytes, wantedPid) {
  const out = []
  let current = []
  for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
    if (bytes[offset] !== 0x47) continue
    const pid = ((bytes[offset + 1] & 0x1f) << 8) | bytes[offset + 2]
    const payloadStart = (bytes[offset + 1] & 0x40) !== 0
    const adaptationControl = (bytes[offset + 3] & 0x30) >> 4
    let cursor = offset + 4
    if (adaptationControl === 2 || adaptationControl === 3) {
      cursor += 1 + bytes[cursor]
      if (cursor >= offset + 188) continue
    }
    if (adaptationControl !== 1 && adaptationControl !== 3) continue
    if (payloadStart && current.length) {
      out.push(Buffer.concat(current))
      current = []
    }
    if (pid !== wantedPid) continue
    if (payloadStart) cursor += 1 + bytes[cursor] // PES header length
    current.push(bytes.subarray(cursor, offset + 188))
  }
  if (current.length) out.push(Buffer.concat(current))
  return out
}

/** Count H.264 NAL units by type (7 = SPS, 5 = IDR, 1 = non-IDR slice). */
function h264NalTypes(pesPayloads) {
  const counts = new Map()
  for (const payload of pesPayloads) {
    for (let i = 0; i + 4 < payload.length; i++) {
      let start = -1
      let headerLength = 0
      if (
        payload[i] === 0x00 &&
        payload[i + 1] === 0x00 &&
        payload[i + 2] === 0x00 &&
        payload[i + 3] === 0x01
      ) {
        start = i + 4
        headerLength = 4
      } else if (payload[i] === 0x00 && payload[i + 1] === 0x00 && payload[i + 2] === 0x01) {
        start = i + 3
        headerLength = 3
      }
      if (start < 0 || start >= payload.length) continue
      const type = payload[start] & 0x1f
      if (type > 0 && type < 32) {
        counts.set(type, (counts.get(type) ?? 0) + 1)
        i += headerLength
      }
    }
  }
  return counts
}

function countSyncBytes(bytes) {
  let count = 0
  for (let i = 0; i + 188 <= bytes.length; i += 188) {
    if (bytes[i] !== 0x47) return -1
    count += 1
  }
  return count
}

function tsStats(bytes) {
  const pids = new Set()
  let payloadUnitStart = 0
  for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
    if (bytes[offset] !== 0x47) continue
    const pid = ((bytes[offset + 1] & 0x1f) << 8) | bytes[offset + 2]
    pids.add(pid)
    const payloadStart = (bytes[offset + 1] & 0x40) !== 0
    const adaptationControl = (bytes[offset + 3] & 0x30) >> 4
    if ((adaptationControl === 1 || adaptationControl === 3) && payloadStart) {
      payloadUnitStart += 1
    }
  }
  return { packets: Math.floor(bytes.length / 188), pids: pids.size, payloadUnitStart }
}

async function main() {
  const meta = await json('/api/meta')
  log('ffmpeg:', meta.ffmpegVersion ?? 'unknown')
  log('playlist:', meta.playlistStatus, `${meta.channelCount} channels`)
  if (!meta.ffmpegOk) throw new Error('backend reports ffmpeg is unavailable')

  const { channels } = await json('/api/channels')
  if (channels.length === 0) throw new Error('playlist is empty')

  // Prefer the curated starter channels; they were verified to be reachable.
  const candidates = channels.filter((c) => c.featured)
  log(`starter candidates: ${candidates.length}`)

  const statuses = []
  // Watch the SSE feed while playing so restarts/errors are visible too.
  // Node has no global EventSource, so read the stream directly.
  const sseAbort = new AbortController()
  ;(async () => {
    try {
      const response = await fetch(`${BASE}/api/events`, { signal: sseAbort.signal })
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const data = JSON.parse(line.slice(5).trim())
            statuses.push(data.state)
            log(`status: ${data.state}${data.message ? ` — ${data.message}` : ''}`)
          }
        }
      }
    } catch {
      /* aborted at the end of the run */
    }
  })()

  let played = null
  const attempts = candidates.slice(0, 6)
  for (const channel of attempts) {
    log(`starting: ${channel.name} (${channel.country ?? 'INT'})`)
    let session
    try {
      session = await json('/api/play', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId: channel.id }),
      })
    } catch (error) {
      log('play failed:', error.message)
      continue
    }

    const result = await readWebSocket(`${BASE.replace('http', 'ws')}${session.wsPath}`, 12_000)
    const stats = tsStats(result.bytes)
    log(`received ${result.bytes.length} bytes / ${stats.packets} packets from ${channel.name}`)
    if (result.bytes.length > 100 * 188 && stats.packets > 100) {
      played = { channel, session, result }
      break
    }
    log(`insufficient media from ${channel.name}; trying the next one`)
    await json('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId, action: 'stop' }),
    })
  }

  sseAbort.abort()
  if (!played) throw new Error('no starter channel produced media; pipeline is broken')

  const { bytes } = played.result
  const stats = tsStats(bytes)
  const syncOk = countSyncBytes(bytes) > 0
  const pmt = parsePsi(bytes)
  const elementary = [...pmt.entries()].filter(([pid]) => typeof pid === 'number' && pid !== 0)
  const videoEntry = elementary.find(([, type]) => type === 0x1b || type === 0x24)
  const audioEntry = elementary.find(([, type]) => type === 0x0f || type === 0x11)
  const nals = videoEntry ? h264NalTypes(collectPts(bytes, videoEntry[0])) : new Map()

  log('---')
  log(`channel: ${played.channel.name}`)
  log(`received: ${bytes.length} bytes, ${stats.packets} TS packets`)
  log(`sync bytes aligned: ${syncOk}`)
  log(`elementary streams: ${elementary
    .map(([pid, type]) => `pid ${pid} ${STREAM_TYPES[type] ?? `type 0x${type.toString(16)}`}`)
    .join(', ')}`)
  log(`video codec: ${videoEntry ? STREAM_TYPES[videoEntry[1]] : 'none found'}`)
  log(`audio codec: ${audioEntry ? STREAM_TYPES[audioEntry[1]] : 'none found'}`)
  log(`H.264 SPS (NAL 7) units: ${nals.get(7) ?? 0}, IDR frames: ${nals.get(5) ?? 0}`)
  log(`payload unit starts: ${stats.payloadUnitStart}`)
  log(`status transitions: ${statuses.join(' -> ') || 'none'}`)

  const failures = []
  if (!syncOk) failures.push('transport stream packets are not 188-byte aligned')
  if (stats.packets < 100) failures.push('too few packets received')
  if (STREAM_TYPES[videoEntry?.[1]] !== 'H.264') failures.push('video is not H.264, the webview cannot decode it')
  if (!nals.get(7)) failures.push('no H.264 SPS in the stream: decoders cannot start')
  if (!nals.get(5)) failures.push('no IDR keyframes: playback could never start')
  if (!audioEntry) failures.push('no audio elementary stream')
  if (statuses.includes('error')) failures.push('backend reported an error state')

  if (failures.length) {
    for (const failure of failures) log(`FAIL: ${failure}`)
    process.exitCode = 1
    return
  }
  log('PASS: live H.264/AAC transport stream is flowing over the WebSocket relay')
}

function readWebSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    const chunks = []
    let total = 0
    const finish = () => {
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* already closing */
      }
      resolve({ bytes: Buffer.concat(chunks), total })
    }
    const timer = setTimeout(finish, timeoutMs)
    socket.onmessage = (event) => {
      const chunk = Buffer.from(event.data)
      chunks.push(chunk)
      total += chunk.length
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`websocket failed: ${url}`))
    }
  })
}

main().catch((error) => {
  console.error('[verify] FAILED:', error.message)
  process.exitCode = 1
})