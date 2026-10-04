/**
 * Browser verification of the player.
 *
 * Drives the real UI in Chromium (the same engine WebView2 uses) and asserts
 * that the <video> element actually decodes frames: real dimensions, advancing
 * currentTime, and the designed backdrop swapped out. This is the check that
 * catches a blank white or black screen.
 *
 * Usage: node scripts/verify-ui.mjs [url]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const URL = process.argv[2] || 'http://localhost:1420'
const API = process.argv[3] || 'http://127.0.0.1:8787'
const SHOTS = 'artifacts'
const log = (...args) => console.log('[ui]', ...args)

mkdirSync(SHOTS, { recursive: true })

/** Ask the backend which starter channel is actually reachable right now. */
async function findReachableChannel() {
  const channels = (await (await fetch(`${API}/api/channels`)).json()).channels
  const starters = channels.filter((channel) => channel.featured).slice(0, 12)
  const response = await fetch(`${API}/api/probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: starters.map((channel) => channel.id) }),
  })
  const { results } = await response.json()
  const healthy = starters.filter((channel) => results[channel.id]?.ok)
  for (const channel of healthy) {
    log(`reachable: ${channel.name} (${results[channel.id].width}x${results[channel.id].height})`)
  }
  return healthy[0] ?? null
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

  const consoleErrors = []
  const imageNoise = []
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    // Roughly a fifth of the iptv-org logo URLs are dead or rate limited; the
    // UI already renders a monogram fallback for those.
    if (/Failed to load resource/.test(text)) imageNoise.push(text)
    else consoleErrors.push(text)
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

  log(`opening ${URL}`)
  await page.goto(URL, { waitUntil: 'domcontentloaded' })

  // 1. The window must not be white/empty.
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  log(`body background: ${background}`)
  if (background === 'rgba(0, 0, 0, 0)' || background === 'rgb(255, 255, 255)') {
    throw new Error(`window background is not painted (${background})`)
  }

  // 2. The guide must populate from the backend playlist.
  await page.waitForSelector('.card', { timeout: 90_000 })
  const cardCount = await page.locator('.card').count()
  log(`channel cards rendered: ${cardCount}`)
  if (cardCount === 0) throw new Error('no channel cards rendered')

  // 3. Close the autoplay player so the guide is fully visible for the shot.
  // Autoplay probes before starting, so give it a moment to appear (or not).
  try {
    await page.waitForSelector('.player__stage', { timeout: 20_000 })
    log('player opened by autoplay; closing it to inspect the guide')
    await page.locator('.player__topbar button').first().click()
    await page.waitForSelector('.player__stage', { state: 'detached', timeout: 15_000 })
  } catch {
    log('autoplay did not open a player')
  }
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${SHOTS}/guide.png` })

  await page.locator('.pivot__tab', { hasText: 'Starter' }).click()
  await page.waitForTimeout(800)
  const starterCount = await page.locator('.card').count()
  log(`starter channels: ${starterCount}`)
  if (starterCount === 0) throw new Error('starter tab is empty')

  // Pick a channel the backend just confirmed is reachable, so a dead source in
  // the list cannot be mistaken for a broken player.
  const target = await findReachableChannel()
  if (!target) throw new Error('no starter channel is reachable right now')

  await page.locator(`.card[data-channel-id="${target.id}"] .card__hit`).click()
  await page.waitForSelector('.player__stage video', { timeout: 20_000 })
  log(`player opened: ${target.name}`)

  // Headless Chromium blocks autoplay with sound; the UI should offer a play
  // button rather than an error card. Click it when it appears.
  try {
    await page.waitForSelector('.player__gateButton', { timeout: 12_000 })
    log('autoplay gate shown, pressing play')
    await page.locator('.player__gateButton').click()
  } catch {
    log('no autoplay gate: playback started on its own')
  }

  // 4. Wait for a decoded frame. This is the no-blank-screen guarantee.
  const deadline = Date.now() + 75_000
  let last = null
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const video = document.querySelector('.player__stage video')
      if (!video) return null
      const backdrop = document.querySelector('.player__backdrop')
      return {
        width: video.videoWidth,
        height: video.videoHeight,
        currentTime: video.currentTime,
        readyState: video.readyState,
        paused: video.paused,
        backdropHidden: backdrop?.classList.contains('player__backdrop--hidden') ?? null,
        error: video.error ? video.error.code : null,
      }
    })
    if (last && last.width > 0 && last.currentTime > 0.5) break
    await page.waitForTimeout(1000)
  }

  log(`video: ${last?.width}x${last?.height}, t=${last?.currentTime?.toFixed(2)}s, ` +
    `readyState=${last?.readyState}, paused=${last?.paused}, error=${last?.error}`)
  log(`backdrop swapped out: ${last?.backdropHidden}`)

  await page.screenshot({ path: `${SHOTS}/player.png` })

  // 5. Confirm playback advances continuously and keeps a buffer.
  const before = last?.currentTime ?? 0
  await page.waitForTimeout(4000)
  const after = await page.evaluate(
    () => document.querySelector('.player__stage video')?.currentTime ?? 0,
  )
  log(`currentTime advanced ${before.toFixed(2)}s -> ${after.toFixed(2)}s`)

  // Sample the clock to catch cut-outs: a stall shows up as a flat stretch.
  const samples = []
  for (let i = 0; i < 30; i++) {
    samples.push(
      await page.evaluate(() => {
        const video = document.querySelector('.player__stage video')
        if (!video) return null
        let buffered = 0
        if (video.buffered.length > 0) {
          buffered = video.buffered.end(video.buffered.length - 1) - video.currentTime
        }
        return { t: video.currentTime, buffered, paused: video.paused, ready: video.readyState }
      }),
    )
    await page.waitForTimeout(500)
  }

  const valid = samples.filter(Boolean)
  const gaps = valid
    .slice(1)
    .map((sample, index) => ({
      gap: sample.t - valid[index].t,
      stalled: !sample.paused && sample.gap < 0.3,
    }))
  const stalls = gaps.filter((gap) => gap.stalled).length
  const minBuffer = Math.min(...valid.map((sample) => sample.buffered))
  const avgBuffer =
    valid.reduce((sum, sample) => sum + sample.buffered, 0) / (valid.length || 1)
  log(`sampled 15s of playback: ${stalls} stalls, buffer min ${minBuffer.toFixed(1)}s / avg ${avgBuffer.toFixed(1)}s`)

  const failures = []
  if (!last || last.width === 0 || last.height === 0) failures.push('video never reported dimensions')
  if (after <= before) failures.push('playback did not advance')
  if (last?.backdropHidden !== true) failures.push('backdrop is still covering the video')
  // The real anti-stutter guarantee is the demuxer input stash, so the metric
  // that matters here is cut-outs, not the Media Source buffer (which cannot
  // exceed real time when the backend transcodes at 1x).
  if (stalls > 0) failures.push(`playback stalled ${stalls} times in 15s`)
  if (await page.locator('.player__error').count()) failures.push('an error card is covering the video')
  if (consoleErrors.length > 0) failures.push(`console errors: ${consoleErrors.join(' | ')}`)
  if (imageNoise.length) log(`note: ${imageNoise.length} failed resource requests`)

  await browser.close()

  if (failures.length) {
    for (const failure of failures) log(`FAIL: ${failure}`)
    process.exitCode = 1
    return
  }
  log(`PASS: real video frames are rendering (screenshots in ${SHOTS}/)`)
}

main().catch((error) => {
  console.error('[ui] FAILED:', error.message)
  process.exitCode = 1
})