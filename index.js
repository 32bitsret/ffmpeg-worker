require('dotenv').config()
const express = require('express')
const ffmpeg = require('fluent-ffmpeg')
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')
const http = require('http')

ffmpeg.setFfmpegPath(ffmpegPath)

// Returns the duration (seconds, float) of a local video file, or null on error.
function probeFileDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err || !meta?.format?.duration) return resolve(null)
      resolve(parseFloat(meta.format.duration))
    })
  })
}

// Query fontconfig for a font file by family + style.
// Works in Nix environments where fonts live in hashed /nix/store/... paths.
function fcFind(family, style) {
  try {
    const query = style ? `:family="${family}":style="${style}"` : `:family="${family}"`
    const out = execSync(`fc-list --format="%{file}\\n" ${query} 2>/dev/null`, { encoding: 'utf8' })
    const file = out.trim().split('\n').find(f => f && fs.existsSync(f))
    return file || null
  } catch {
    return null
  }
}

// Detect usable font files for drawtext filter.
// Priority: 1) bundled fonts (./fonts/) → 2) fontconfig (Nix/Railway) → 3) hardcoded apt paths
function detectFonts() {
  const fontsDir = path.join(__dirname, 'fonts')

  // Bundled fonts — shipped with the worker, always consistent across environments
  const bundled = {
    bold:    path.join(fontsDir, 'BebasNeue-Regular.ttf'),   // Bebas Neue — the go-to reels headline font
    elegant: path.join(fontsDir, 'PlayfairDisplay-Regular.ttf'), // Playfair Display — premium serif
    modern:  path.join(fontsDir, 'Montserrat-Bold.ttf'),     // Montserrat Bold — clean, app/tech content
    minimal: path.join(fontsDir, 'WorkSans-Light.ttf'),      // Work Sans Light — airy, minimal
    kinetic: path.join(fontsDir, 'Anton-Regular.ttf'),        // Anton — strong contrast, high energy
  }

  // Fontconfig lookup (Nix/Railway system fonts) — used only if bundled font missing
  const fcTargets = {
    bold:    () => fcFind('FreeSans', 'Bold'),
    elegant: () => fcFind('Liberation Serif', 'Regular'),
    modern:  () => fcFind('DejaVu Sans', 'Book') || fcFind('DejaVu Sans', 'Regular'),
    minimal: () => fcFind('FreeSans', 'Regular'),
    kinetic: () => fcFind('Liberation Sans', 'Bold'),
  }
  // Hardcoded apt paths as a last resort for non-Nix environments
  const aptPaths = {
    bold:    '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
    elegant: '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf',
    modern:  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    minimal: '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    kinetic: '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  }

  const found = {}
  let fallback = null

  for (const key of Object.keys(bundled)) {
    const bundledPath = bundled[key]
    const f = fs.existsSync(bundledPath)
      ? bundledPath
      : (fcTargets[key]() || (fs.existsSync(aptPaths[key]) ? aptPaths[key] : null))
    if (f) {
      found[key] = f
      if (!fallback) fallback = f
    }
  }

  return { ...found, fallback }
}

const FONTS = detectFonts()
const FONT_PATH = FONTS.fallback
console.log(JSON.stringify({ ts: new Date().toISOString(), msg: 'Fonts detected', fonts: FONTS }))

// Detect tesseract availability once at startup.
// If not present, /ocr-frames returns 501 so the platform degrades gracefully
// instead of triggering false spellcheck failures.
let TESSERACT_AVAILABLE = false
try {
  execSync('tesseract --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  TESSERACT_AVAILABLE = true
} catch {
  TESSERACT_AVAILABLE = false
}
console.log(JSON.stringify({ ts: new Date().toISOString(), msg: 'Tesseract status', available: TESSERACT_AVAILABLE }))

const app = express()
app.use(express.json({ limit: '50mb' }))

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
  },
})

function slog(step, msg, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, msg, ...data }))
}

function tmpFile(ext) {
  return path.join(os.tmpdir(), `worker-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const get = url.startsWith('https') ? https.get : http.get
    get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: ${res.statusCode} ${url}`))
        return
      }
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
    }).on('error', reject)
  })
}

async function uploadToR2(key, filePath, contentType) {
  const buffer = fs.readFileSync(filePath)
  await r2.send(new PutObjectCommand({
    Bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }))
  return `${process.env.CLOUDFLARE_R2_PUBLIC_URL}/${key}`
}

function cleanup(...files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f) } catch {}
  }
}

// Cache the chromium executablePath — resolving it is async and slow on cold start.
let _chromiumExecPath = null
async function getChromiumPath() {
  if (!_chromiumExecPath) {
    const chromium = require('@sparticuz/chromium')
    _chromiumExecPath = await chromium.executablePath()
  }
  return _chromiumExecPath
}

/**
 * Renders a Remotion composition to a local temp MP4.
 * Returns the temp file path, or null if REMOTION_BUNDLE_URL is not set.
 */
async function renderRemotionClip(template, props, durationSecs) {
  if (!process.env.REMOTION_BUNDLE_URL) return null
  const fps = 30
  const durationInFrames = Math.round(durationSecs * fps)
  const outPath = tmpFile('.mp4')
  try {
    const { renderMedia, selectComposition } = require('@remotion/renderer')
    const executablePath = await getChromiumPath()
    const chromiumOptions = { executablePath, disableWebSecurity: true, gl: 'swiftshader' }

    const composition = await selectComposition({
      serveUrl: process.env.REMOTION_BUNDLE_URL,
      id: template,
      inputProps: props,
      chromiumOptions,
    })

    await renderMedia({
      composition: { ...composition, durationInFrames, fps, width: 1080, height: 1920 },
      serveUrl: process.env.REMOTION_BUNDLE_URL,
      codec: 'h264',
      outputLocation: outPath,
      inputProps: props,
      chromiumOptions,
      timeoutInMilliseconds: 150_000,
    })

    return outPath
  } catch (err) {
    slog('renderRemotionClip', 'Error', { template, error: err.message })
    cleanup(outPath)
    return null
  }
}

// Mixes an array of sound effects into an already-composited video file.
// Each sfx has { path (local temp file), startTime (seconds), duration }.
// The voiceover is already baked into `inputVideo`; this adds additional
// audio tracks via adelay + amix without re-encoding the video stream.
function mixSoundEffects(inputVideo, sfxTracks, outputVideo) {
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(inputVideo) // Input 0: existing composited video + voiceover
    sfxTracks.forEach(sfx => cmd = cmd.input(sfx.path))

    // Build filter_complex: normalize voice, delay+attenuate each sfx, then amix all
    const filterParts = []
    filterParts.push('[0:a]aresample=44100,aformat=channel_layouts=stereo[voice]')
    sfxTracks.forEach((sfx, i) => {
      const delayMs = Math.round(Math.max(0, sfx.startTime) * 1000)
      filterParts.push(
        `[${i + 1}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${delayMs}|${delayMs},volume=0.45[sfx${i}]`
      )
    })
    const mixLabels = ['[voice]', ...sfxTracks.map((_, i) => `[sfx${i}]`)].join('')
    filterParts.push(`${mixLabels}amix=inputs=${sfxTracks.length + 1}:duration=first:normalize=0[aout]`)

    cmd.outputOptions([
      '-filter_complex', filterParts.join(';'),
      '-map', '0:v:0',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart',
    ])
    .output(outputVideo)
    .on('start', cmdLine => slog('sfx-mix', 'cmd', { cmdLine }))
    .on('end', resolve)
    .on('error', (err, _stdout, stderr) => {
      slog('sfx-mix', 'failed', { error: err.message, stderr: stderr?.slice(-500) })
      reject(err)
    })
    .run()
  })
}

function wrapText(text, maxChars) {
  const words = text.trim().split(/\s+/)
  const lines = []
  let line = ''
  for (const word of words) {
    const candidate = line ? line + ' ' + word : word
    if (candidate.length > maxChars && line) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

function escapeDrawtext(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\n/g, '\\n')
}

function isLightColor(hex) {
  if (!hex) return false
  const clean = hex.replace(/^#|^0x/i, '')
  if (clean.length !== 6) return false
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 > 128
}

function buildRichTextFilter(text, vibe = 'bold', isTemplate = true, bgIsLight = false, fadeIn = false) {
  if (!text?.trim()) return null
  const fontPath = FONTS[vibe] || FONTS.fallback
  if (!fontPath) return null

  const len = text.trim().length
  let fontSize, maxChars

  if (isTemplate) {
    if      (len <= 12) { fontSize = 100; maxChars = 10 }
    else if (len <= 20) { fontSize = 80;  maxChars = 14 }
    else if (len <= 35) { fontSize = 64;  maxChars = 18 }
    else                { fontSize = 52;  maxChars = 22 }
  } else {
    fontSize = 48
    maxChars = 24
  }

  const wrapped = wrapText(text.trim(), maxChars)
  const escaped = escapeDrawtext(wrapped)

  let fontColor = bgIsLight ? 'black' : 'white'
  let borderColor = bgIsLight ? 'white@0.4' : 'black@0.6'
  let borderW = 3
  let shadowX = 2, shadowY = 2

  if (vibe === 'kinetic') {
    fontColor = 'white'
    borderColor = '0x7c3aed@0.8'
    borderW = 5
  } else if (vibe === 'bold') {
    borderW = 4
    shadowX = 4; shadowY = 4
  } else if (vibe === 'elegant') {
    fontSize = Math.round(fontSize * 0.9)
  }

  const x = '(w-text_w)/2'
  // kinetic: text slides up into center over 0.25s; all others: vertically centered
  const y = !isTemplate
    ? 'h-160'
    : (fadeIn && vibe === 'kinetic')
      ? '(h-text_h)/2+max(0\\,(0.25-t)/0.25*60)'
      : '(h-text_h)/2'

  // Fade-in alpha: ramp from 0→1 over 0.25s
  const alpha = fadeIn ? 'min(t/0.25\\,1)' : null

  return `drawtext=fontfile='${fontPath}':text='${escaped}':fontsize=${fontSize}` +
         `:fontcolor=${fontColor}:x=${x}:y=${y}` +
         `:borderw=${borderW}:bordercolor=${borderColor}:shadowx=${shadowX}:shadowy=${shadowY}:line_spacing=15` +
         (alpha ? `:alpha='${alpha}'` : '')
}

const CANVAS_COLORS = { white: '0xf5f5f5', dark: '0x9687FF', muted: '0xE66FFF' }

/**
 * Creates a video clip for a single slide.
 */
// Ken Burns effect variants — rotate through zoom-in, zoom-out, and pan-right
function kenBurnsFilter(idx, frames) {
  const effect = idx % 3
  if (effect === 0) {
    // Zoom in toward center
    return `scale=2000:-1,zoompan=z='min(zoom+0.0015,1.5)':d=${frames}:s=1080x1920:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`
  } else if (effect === 1) {
    // Zoom out from center — initialise zoom to 1.5 on frame 1 then decrement
    return `scale=2000:-1,zoompan=z='if(eq(on\\,1)\\,1.5\\,max(zoom-0.0015\\,1.0))':d=${frames}:s=1080x1920:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`
  } else {
    // Slow pan right with gentle zoom
    return `scale=2000:-1,zoompan=z='min(zoom+0.0008,1.2)':d=${frames}:s=1080x1920:x='iw/2-(iw/zoom/2)+iw*0.04*on/${frames}':y='ih/2-(ih/zoom/2)'`
  }
}

async function createSlideClip(slide, canvasColor, idx, watermark = false, accentColor = null) {
  const duration = slide.duration || 2.5

  // Use Remotion for text slides — far superior typography and animations vs FFmpeg drawtext.
  // Falls back to FFmpeg if REMOTION_BUNDLE_URL is not set or Remotion render fails.
  if (slide.type === 'text' && process.env.REMOTION_BUNDLE_URL) {
    const bgColor = slide.backgroundColor || canvasColor || '#1a1a2e'
    const accent = accentColor || canvasColor || '#7c3aed'
    slog('slide-clip', 'Rendering text slide via Remotion', { fontVibe: slide.fontVibe, duration })
    const remotionPath = await renderRemotionClip('text-slide', {
      text: slide.content || '',
      fontVibe: slide.fontVibe || 'bold',
      backgroundColor: bgColor,
      accentColor: accent,
    }, duration)
    if (remotionPath) {
      return { path: remotionPath, duration }
    }
    slog('slide-clip', 'Remotion render failed — falling back to FFmpeg drawtext', { content: slide.content })
  }

  const outFile = tmpFile('.mp4')
  const frames = Math.round(duration * 25)

  return new Promise(async (resolve, reject) => {
    let cmd = ffmpeg()
    const filters = []

    // 1. Setup background
    if (slide.type === 'image') {
      const imgPath = tmpFile('.png')
      await download(slide.content, imgPath)
      // Explicit -r 25 so zoompan's frame-count (d=frames) is accurate
      cmd = cmd.input(imgPath).inputOptions(['-loop 1', '-r 25'])
      filters.push(kenBurnsFilter(idx, frames))
    } else {
      // Text/color slide: solid color background
      // Add 1s buffer so the clip is always longer than (duration), ensuring xfade
      // transitions never overshoot the clip boundary at 25fps frame boundaries.
      const color = slide.backgroundColor || canvasColor || '#9687FF'
      const hex = color.replace('#', '0x')
      cmd = cmd.input(`color=c=${hex}:r=25:s=1080x1920:d=${duration + 1}`).inputOptions(['-f lavfi'])
    }

    // 2. Text with fade-in (text slides only)
    const bgIsLight = isLightColor(slide.backgroundColor || canvasColor)
    const textFilter = buildRichTextFilter(
      slide.type === 'text' ? slide.content : '',
      slide.fontVibe || 'bold',
      true,
      bgIsLight,
      true  // fadeIn — always animate text in for slideshow slides
    )
    if (textFilter) filters.push(textFilter)

    // 3. Watermark
    if (watermark && FONT_PATH) {
      filters.push(`drawtext=fontfile='${FONT_PATH}':text='demostudio':fontsize=44:fontcolor=white@0.5:x=20:y=20`)
    }

    // 4. Apply filters only if non-empty (empty videoFilters([]) emits -vf "" which FFmpeg rejects)
    if (filters.length > 0) cmd = cmd.videoFilters(filters)

    cmd.outputOptions(['-t', duration.toString(), '-pix_fmt yuv420p', '-r 25'])
      .videoCodec('libx264')
      .output(outFile)
      .on('end', () => resolve({ path: outFile, duration }))
      .on('error', (err) => reject(err))
      .run()
  })
}

app.post('/composite', async (req, res) => {
  const {
    visualClipUrl, voiceoverUrl, onScreenText, duration, outputKey, watermark,
    backgroundType = 'cinematic', canvasStyle = 'dark', canvasColor = null, imageUrl,
    fontVibe = 'bold', slides = [], accentColor = null,
    soundEffects = [],  // Array of { url, startTime, duration }
  } = req.body

  slog('composite', 'Start', { outputKey, backgroundType, hasVoiceover: !!voiceoverUrl, sfxCount: soundEffects.length })

  const tempFiles = []
  const videoOut = tmpFile('.mp4')
  const audioIn = voiceoverUrl ? tmpFile('.mp3') : null

  try {
    if (audioIn) await download(voiceoverUrl, audioIn)

    if (backgroundType === 'slideshow') {
      // ── Slideshow Logic ────────────────────────────────────────────────────
      const slideClips = []
      const clipDurations = []
      for (let i = 0; i < slides.length; i++) {
        const clip = await createSlideClip(slides[i], canvasColor, i, watermark === true, accentColor)
        slideClips.push(clip.path)
        clipDurations.push(clip.duration)
        tempFiles.push(clip.path)
      }

      if (slideClips.length === 0) throw new Error('No slide clips produced')

      const XFADE_DUR = 0.4
      // Varied transitions — rotate through the list per slide boundary
      const XFADE_TRANSITIONS = ['fade', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'dissolve', 'fadeblack']
      // Total video duration accounting for overlapping transitions
      const totalVideoDur = clipDurations.reduce((a, b) => a + b, 0) - (slideClips.length - 1) * XFADE_DUR

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg()
        // Input each slide clip individually (xfade requires separate inputs, not concat demuxer)
        for (const clipPath of slideClips) cmd = cmd.input(clipPath)

        const audioIdx = slideClips.length
        if (audioIn) {
          cmd = cmd.input(audioIn)
        } else {
          cmd = cmd.input('anullsrc=r=44100:cl=stereo').inputOptions(['-f lavfi', `-t ${totalVideoDur.toFixed(3)}`])
        }

        if (slideClips.length === 1) {
          // Single slide — no xfade needed, stream-copy video
          cmd.outputOptions([
            '-map 0:v:0', `-map ${audioIdx}:a:0`,
            '-c:v copy', '-c:a aac', '-ar 44100', '-ac 2',
            audioIn ? '-shortest' : `-t ${clipDurations[0].toFixed(3)}`,
            '-movflags +faststart',
          ])
        } else {
          // Build xfade filter chain
          // offset_i = sum(durations[0..i]) - (i+1)*XFADE_DUR
          const filterParts = []
          let prevLabel = '[0:v]'
          let cumulativeDur = 0
          for (let i = 0; i < slideClips.length - 1; i++) {
            cumulativeDur += clipDurations[i]
            const offset = Math.max(0.1, cumulativeDur - XFADE_DUR * (i + 1))
            const transition = XFADE_TRANSITIONS[i % XFADE_TRANSITIONS.length]
            const outLabel = i === slideClips.length - 2 ? '[vout]' : `[v${i}]`
            filterParts.push(`${prevLabel}[${i + 1}:v]xfade=transition=${transition}:duration=${XFADE_DUR}:offset=${offset.toFixed(3)}${outLabel}`)
            prevLabel = outLabel
          }
          const filterComplex = filterParts.join(';')
          slog('xfade', 'filter_complex', { filterComplex, clips: slideClips.length, durations: clipDurations })

          // Pass filter_complex as raw output option to bypass any fluent-ffmpeg
          // filter-string processing that could corrupt stream labels.
          cmd.outputOptions([
            '-filter_complex', filterComplex,
            '-map', '[vout]',
            '-map', `${audioIdx}:a:0`,
            '-c:v', 'libx264', '-c:a', 'aac', '-ar', '44100', '-ac', '2',
            '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            ...(audioIn ? ['-shortest'] : ['-t', totalVideoDur.toFixed(3)]),
          ])
        }

        cmd.output(videoOut)
          .on('start', (cmdLine) => slog('ffmpeg-cmd', 'slideshow xfade cmd', { cmdLine }))
          .on('end', resolve)
          .on('error', (err, stdout, stderr) => {
            slog('ffmpeg-err', 'slideshow xfade failed', { error: err.message, stderr: stderr?.slice(-1000) })
            reject(err)
          })
          .run()
      })
    } else {
      // ── Standard Logic (Cinematic, Canvas, Video, Remotion) ───────────────
      const videoIn = ['cinematic', 'video', 'canvas', 'remotion'].includes(backgroundType) ? tmpFile('.mp4') : null
      const imageIn = backgroundType === 'image' ? tmpFile('.jpg') : null
      if (videoIn) { await download(visualClipUrl, videoIn); tempFiles.push(videoIn) }
      if (imageIn && imageUrl) { await download(imageUrl, imageIn); tempFiles.push(imageIn) }

      await new Promise((resolve, reject) => {
        let cmd = imageIn ? ffmpeg().input(imageIn).inputOptions(['-loop 1']) : ffmpeg(videoIn)
        if (audioIn) cmd = cmd.input(audioIn)
        else cmd = cmd.input('anullsrc=r=44100:cl=stereo').inputOptions(['-f lavfi', `-t ${duration || 10}`])

        const videoFilters = []
        // Always force portrait 9:16 output regardless of source dimensions —
        // except remotion which already outputs 1080x1920 natively.
        if (backgroundType !== 'remotion') {
          if (videoIn) videoFilters.push('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920')
          if (imageIn) videoFilters.push('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920')
        }

        // Remotion handles all text rendering internally — skip drawtext overlays.
        if (backgroundType !== 'remotion') {
          const effectiveHex = canvasColor || CANVAS_COLORS[canvasStyle] || CANVAS_COLORS.dark
          const bgIsLight = (backgroundType === 'canvas') ? isLightColor(effectiveHex) : false
          const textFilter = buildRichTextFilter(onScreenText, fontVibe, backgroundType === 'canvas', bgIsLight)
          if (textFilter) videoFilters.push(textFilter)

          if (FONT_PATH && watermark === true) {
            videoFilters.push(`drawtext=fontfile='${FONT_PATH}':text='demostudio':fontsize=44:fontcolor=white@0.5:x=20:y=20`)
          }
        }

        if (videoFilters.length > 0) cmd = cmd.videoFilters(videoFilters)

        cmd.outputOptions(['-preset fast', '-crf 23', '-movflags +faststart', '-ar 44100', '-ac 2', audioIn ? '-shortest' : `-t ${duration || 10}`])
          .videoCodec('libx264').audioCodec('aac')
          .output(videoOut)
          .on('end', resolve).on('error', reject).run()
      })
    }

    // ── Sound effect mixing (post-composite pass) ──────────────────────────
    // Download each sfx audio file and mix them into the composited video at
    // their specified startTimes. Failures are non-fatal — the original videoOut
    // is used as-is if mixing fails.
    const sfxFiles = []
    if (Array.isArray(soundEffects) && soundEffects.length > 0) {
      for (const sfx of soundEffects) {
        if (!sfx?.url) continue
        try {
          const sfxPath = tmpFile('.mp3')
          await download(sfx.url, sfxPath)
          sfxFiles.push({ path: sfxPath, startTime: sfx.startTime ?? 0 })
          tempFiles.push(sfxPath)
        } catch (e) {
          slog('sfx-download', 'Failed to download sfx — skipping', { url: sfx.url, error: e.message })
        }
      }

      if (sfxFiles.length > 0) {
        const mixedOut = tmpFile('.mp4')
        tempFiles.push(mixedOut)
        try {
          await mixSoundEffects(videoOut, sfxFiles, mixedOut)
          // Swap videoOut content with the mixed version
          fs.renameSync(mixedOut, videoOut)
          slog('sfx-mix', 'Sound effects mixed', { count: sfxFiles.length })
        } catch (e) {
          slog('sfx-mix', 'Mixing failed — using original composite', { error: e.message })
          // Non-fatal: videoOut remains the original without sfx
        }
      }
    }

    const clipDuration = await probeFileDuration(videoOut)
    const outputUrl = await uploadToR2(outputKey, videoOut, 'video/mp4')
    slog('composite', 'Done', { outputUrl, clipDuration })
    res.json({ outputUrl, clipDuration })
  } catch (err) {
    slog('composite', 'Error', { error: err.message })
    res.status(500).json({ error: err.message })
  } finally {
    cleanup(...tempFiles, audioIn, videoOut)
  }
})

// POST /remotion-render
// Renders a Remotion composition to a 1080x1920 MP4 using headless Chromium.
// Requires REMOTION_BUNDLE_URL env var pointing to the deployed bundle index.html.
// Output: silent video — voiceover is mixed separately by /composite.
app.post('/remotion-render', async (req, res) => {
  const { template, props = {}, duration, outputKey } = req.body

  if (!process.env.REMOTION_BUNDLE_URL) {
    return res.status(501).json({ error: 'REMOTION_BUNDLE_URL not configured' })
  }
  if (!template) {
    return res.status(400).json({ error: 'template is required' })
  }
  if (!duration || duration <= 0) {
    return res.status(400).json({ error: 'duration must be a positive number' })
  }

  const fps = 30
  const durationInFrames = Math.round(duration * fps)
  const outPath = tmpFile('.mp4')

  slog('remotion-render', 'Start', { template, duration, durationInFrames, outputKey })

  try {
    const { renderMedia, selectComposition } = require('@remotion/renderer')
    const chromium = require('@sparticuz/chromium')

    const executablePath = await chromium.executablePath()

    // Resolve the composition — lets Remotion validate template ID and default props
    const composition = await selectComposition({
      serveUrl: process.env.REMOTION_BUNDLE_URL,
      id: template,
      inputProps: props,
      chromiumOptions: {
        executablePath,
        disableWebSecurity: true,
        gl: 'swiftshader',
      },
    })

    await renderMedia({
      composition: {
        ...composition,
        durationInFrames,
        fps,
        width: 1080,
        height: 1920,
      },
      serveUrl: process.env.REMOTION_BUNDLE_URL,
      codec: 'h264',
      outputLocation: outPath,
      inputProps: props,
      chromiumOptions: {
        executablePath,
        disableWebSecurity: true,
        gl: 'swiftshader',
      },
      timeoutInMilliseconds: 150_000,
      onProgress: ({ progress }) => {
        slog('remotion-render', 'Progress', { template, pct: Math.round(progress * 100) })
      },
    })

    const clipDuration = await probeFileDuration(outPath)
    const outputUrl = await uploadToR2(outputKey, outPath, 'video/mp4')

    slog('remotion-render', 'Done', { outputUrl, clipDuration })
    res.json({ outputUrl, clipDuration })
  } catch (err) {
    slog('remotion-render', 'Error', { error: err.message, stack: err.stack?.slice(0, 400) })
    res.status(500).json({ error: err.message })
  } finally {
    cleanup(outPath)
  }
})

function buildMusicVolumeFilter(timeline, fallbackVolume) {
  if (!timeline?.length) return `volume=${(fallbackVolume * 2).toFixed(3)}`
  const allSameVolume = timeline.every(s => (s.volume ?? fallbackVolume) === (timeline[0].volume ?? fallbackVolume))
  if (allSameVolume) return `volume=${((timeline[0].volume ?? fallbackVolume) * 2).toFixed(3)}`
  let t = 0
  const segments = timeline.map((seg) => {
    const start = t
    t += seg.duration || 5
    return { start, end: t, volume: seg.volume ?? fallbackVolume }
  })
  let expr = (segments[segments.length - 1].volume * 2).toFixed(3)
  for (let i = segments.length - 2; i >= 0; i--) {
    expr = `if(lt(t,${segments[i].end}),${(segments[i].volume * 2).toFixed(3)},${expr})`
  }
  return `volume='${expr}'`
}

app.post('/render', async (req, res) => {
  const { clipUrls, outputKey, backgroundMusicUrl, musicVolume = 0.2, musicVolumeTimeline } = req.body
  slog('render', 'Start', { clips: clipUrls?.length, outputKey, hasMusic: !!backgroundMusicUrl })
  if (!clipUrls?.length) return res.status(400).json({ error: 'No clip URLs provided' })
  const clipFiles = []
  const listFile = tmpFile('.txt')
  const musicFile = backgroundMusicUrl ? tmpFile('.mp3') : null
  const videoOut = tmpFile('.mp4')
  try {
    for (let i = 0; i < clipUrls.length; i++) {
      const f = tmpFile('.mp4')
      await download(clipUrls[i], f)
      clipFiles.push(f)
    }
    if (musicFile) await download(backgroundMusicUrl, musicFile)
    fs.writeFileSync(listFile, clipFiles.map(f => `file '${f}'`).join('\n'))
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg().input(listFile).inputOptions(['-f concat', '-safe 0'])
      if (musicFile) {
        const musicVolumeFilter = buildMusicVolumeFilter(musicVolumeTimeline, musicVolume)
        cmd = cmd.input(musicFile).inputOptions(['-stream_loop', '-1'])
        cmd = cmd.complexFilter([
          `[0:a]aresample=44100,aformat=channel_layouts=stereo,apad,volume=2.0[voice_padded]`,
          `[1:a]aresample=44100,aformat=channel_layouts=stereo,${musicVolumeFilter}[music]`,
          `[voice_padded][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
        ]).outputOptions([
          '-map 0:v:0', '-map [aout]', '-c:v libx264', '-c:a aac',
          '-preset fast', '-crf 20', '-movflags +faststart', '-shortest', '-threads 4'
        ])
      } else {
        cmd = cmd.videoCodec('libx264').audioCodec('aac')
          .outputOptions(['-preset fast', '-crf 20', '-movflags +faststart', '-threads 4'])
      }
      cmd.output(videoOut).on('end', resolve).on('error', reject).run()
    })
    const outputUrl = await uploadToR2(outputKey, videoOut, 'video/mp4')
    slog('render', 'Done', { outputUrl })
    res.json({ outputUrl })
  } catch (err) {
    slog('render', 'Error', { error: err.message })
    res.status(500).json({ error: err.message })
  } finally {
    cleanup(...clipFiles, listFile, musicFile, videoOut)
  }
})

// POST /ocr-frames
// Extracts N frames from a video at specified timestamps, runs Tesseract OCR on each,
// and returns the detected text strings. Used for on-screen word checks after compositing.
app.post('/ocr-frames', async (req, res) => {
  if (!TESSERACT_AVAILABLE) {
    return res.status(501).json({ error: 'Tesseract not available on this host — install tesseract to enable OCR checks' })
  }

  const { videoUrl, timestamps } = req.body
  if (!videoUrl || !Array.isArray(timestamps) || timestamps.length === 0) {
    return res.status(400).json({ error: 'videoUrl and timestamps[] required' })
  }

  const t0 = Date.now()
  const videoFile = tmpFile('.mp4')
  const frameFiles = timestamps.map(() => tmpFile('.png'))
  try {
    slog('ocr-frames', 'Start', {
      frameCount: timestamps.length,
      timestamps: timestamps.map(t => +t.toFixed(2)),
      videoUrl: videoUrl.slice(-60), // tail of URL for context without full token exposure
    })

    const t1 = Date.now()
    await download(videoUrl, videoFile)
    slog('ocr-frames', 'Video downloaded', { downloadMs: Date.now() - t1 })

    // Extract all frames in parallel
    const t2 = Date.now()
    const frameErrors = []
    await Promise.all(timestamps.map((ts, i) =>
      new Promise((resolve) => {
        ffmpeg(videoFile)
          .seekInput(Math.max(0, ts))
          .outputOptions(['-vframes 1'])
          .output(frameFiles[i])
          .on('end', resolve)
          .on('error', (err) => {
            frameErrors.push({ frame: i, ts: +ts.toFixed(2), error: err.message })
            resolve() // don't reject — partial results are still useful
          })
          .run()
      })
    ))
    slog('ocr-frames', 'Frames extracted', {
      extractMs: Date.now() - t2,
      total: timestamps.length,
      failed: frameErrors.length,
      frameErrors,
    })

    // Run Tesseract on each frame — psm 11 (sparse text) handles arbitrary text placement
    const t3 = Date.now()
    const texts = frameFiles.map((f, i) => {
      if (!require('fs').existsSync(f)) {
        slog('ocr-frames', 'Frame file missing — skipping OCR', { frame: i, ts: +timestamps[i].toFixed(2) })
        return ''
      }
      try {
        const text = execSync(`tesseract ${f} stdout --oem 3 --psm 11 2>/dev/null`, { encoding: 'utf8' }).trim()
        slog('ocr-frames', 'Tesseract result', {
          frame: i,
          ts: +timestamps[i].toFixed(2),
          chars: text.length,
          preview: text.slice(0, 120) || '(empty)',
        })
        return text
      } catch (err) {
        slog('ocr-frames', 'Tesseract failed for frame', { frame: i, ts: +timestamps[i].toFixed(2), error: err.message })
        return ''
      }
    })

    const nonEmpty = texts.filter(t => t).length
    slog('ocr-frames', 'Done', {
      totalMs: Date.now() - t0,
      tesseractMs: Date.now() - t3,
      framesWithText: nonEmpty,
      framesEmpty: texts.length - nonEmpty,
    })
    res.json({ texts })
  } catch (err) {
    slog('ocr-frames', 'Fatal error', { error: err.message, totalMs: Date.now() - t0 })
    res.status(500).json({ error: err.message })
  } finally {
    cleanup(videoFile, ...frameFiles)
  }
})

app.get('/health', (_, res) => res.json({ ok: true }))
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `ffmpeg-worker listening on :${PORT}` }))
})
