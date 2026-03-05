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

// Detect a usable font file for drawtext filter.
function detectFont() {
  const candidates = [
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  ]
  for (const f of candidates) {
    if (fs.existsSync(f)) return f
  }
  try {
    const nixFont = execSync('find /nix/store -name "FreeSans.ttf" 2>/dev/null | head -1', { timeout: 5000 })
      .toString().trim()
    if (nixFont && fs.existsSync(nixFont)) return nixFont
  } catch {}
  try {
    const fcMatch = execSync('fc-match -f "%{file}" :spacing=proportional:fontformat=TrueType 2>/dev/null', { timeout: 3000 })
      .toString().trim()
    if (fcMatch && fs.existsSync(fcMatch)) return fcMatch
  } catch {}
  return null
}

const FONT_PATH = detectFont()
console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `Font: ${FONT_PATH || 'none — drawtext disabled'}` }))

const app = express()
app.use(express.json())

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
  const clean = hex.replace(/^#|^0x/i, '')
  if (clean.length !== 6) return false
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 > 128
}

function buildTextFilter(fontPath, text, isTemplate, bgIsLight) {
  if (!fontPath || !text?.trim()) return null
  const len = text.trim().length
  let fontSize, maxChars
  if (isTemplate) {
    if      (len <= 10) { fontSize = 90; maxChars = 10 }
    else if (len <= 16) { fontSize = 80; maxChars = 16 }
    else if (len <= 24) { fontSize = 68; maxChars = 20 }
    else                { fontSize = 56; maxChars = 24 }
  } else {
    fontSize = 48
    maxChars = 24
  }
  const wrapped  = wrapText(text.trim(), maxChars)
  const escaped  = escapeDrawtext(wrapped)
  const fontColor   = (isTemplate && bgIsLight) ? 'black' : 'white'
  const borderColor = (isTemplate && bgIsLight) ? 'white@0.5' : 'black@0.7'
  if (isTemplate) {
    return (
      `drawtext=fontfile='${fontPath}':text='${escaped}':fontsize=${fontSize}` +
      `:fontcolor=${fontColor}:x=(w-text_w)/2:y=(h-text_h)/2` +
      `:borderw=4:bordercolor=${borderColor}:shadowx=2:shadowy=2:line_spacing=12`
    )
  } else {
    return (
      `drawtext=fontfile='${fontPath}':text='${escaped}':fontsize=${fontSize}` +
      `:fontcolor=white:x=(w-text_w)/2:y=h-140` +
      `:borderw=3:bordercolor=black:shadowx=2:shadowy=2:line_spacing=8`
    )
  }
}

const CANVAS_COLORS = { white: '0xf5f5f5', dark: '0x111111', muted: '0x1a1a2e' }

app.post('/composite', async (req, res) => {
  const {
    visualClipUrl, voiceoverUrl, onScreenText, duration, outputKey, watermark,
    backgroundType = 'cinematic', canvasStyle = 'dark', canvasColor = null, imageUrl,
  } = req.body
  slog('composite', 'Start', { outputKey, backgroundType, hasVoiceover: !!voiceoverUrl })

  const isTemplate = backgroundType === 'canvas'
  // NEW: canvas now behaves like cinematic (uses video input)
  const videoIn = (backgroundType === 'cinematic' || backgroundType === 'video' || backgroundType === 'canvas') ? tmpFile('.mp4') : null
  const imageIn = backgroundType === 'image' ? tmpFile('.jpg') : null
  const audioIn = voiceoverUrl ? tmpFile('.mp3') : null
  const videoOut = tmpFile('.mp4')

  try {
    if (videoIn) await download(visualClipUrl, videoIn)
    if (imageIn && imageUrl) await download(imageUrl, imageIn)
    else if (imageIn && !imageUrl) return res.status(400).json({ error: 'backgroundType=image requires imageUrl' })
    if (audioIn) await download(voiceoverUrl, audioIn)

    await new Promise((resolve, reject) => {
      let cmd
      if (backgroundType === 'image') {
        cmd = ffmpeg().input(imageIn).inputOptions(['-loop 1'])
      } else {
        // Covers 'video' and 'canvas'
        cmd = ffmpeg(videoIn)
      }

      if (audioIn) cmd = cmd.input(audioIn)

      const videoFilters = []
      if (backgroundType === 'image') {
        videoFilters.push('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920')
      }

      const effectiveHex = canvasColor || CANVAS_COLORS[canvasStyle] || CANVAS_COLORS.dark
      const bgIsLight = isTemplate ? isLightColor(effectiveHex) : false
      const textFilter = buildTextFilter(FONT_PATH, onScreenText, isTemplate, bgIsLight)
      if (textFilter) videoFilters.push(textFilter)

      if (FONT_PATH && watermark === true) {
        videoFilters.push(`drawtext=fontfile='${FONT_PATH}':text='demostudio':fontsize=22:fontcolor=white@0.5:x=20:y=20`)
      }

      if (isTemplate) {
        const chain = videoFilters.length
          ? `[0:v]format=yuv420p,${videoFilters.join(',')}[vout]`
          : `[0:v]format=yuv420p[vout]`
        cmd = cmd.complexFilter([chain])
        const outputOpts = [
          '-map', '[vout]',
          '-map', audioIn ? '1:a:0' : '0:a?',
          '-c:v', 'libx264', '-c:a', 'aac',
          '-preset', 'fast', '-crf', '23', '-movflags', '+faststart',
          '-threads', '4'
        ]
        if (audioIn) outputOpts.push('-shortest')
        else outputOpts.push('-t', String(duration || 10))
        cmd.outputOptions(outputOpts).output(videoOut).on('end', resolve).on('error', reject).run()
        return
      }

      if (videoFilters.length) cmd = cmd.videoFilters(videoFilters)
      const outputOpts = ['-preset fast', '-crf 23', '-movflags +faststart', '-threads 4']
      if (audioIn) outputOpts.push('-map', '0:v:0', '-map', '1:a:0', '-shortest')
      else outputOpts.push(`-t ${duration || 10}`)

      cmd.videoCodec('libx264').audioCodec('aac').audioBitrate('128k')
        .outputOptions(outputOpts).output(videoOut).on('end', resolve).on('error', reject).run()
    })

    const outputUrl = await uploadToR2(outputKey, videoOut, 'video/mp4')
    slog('composite', 'Done', { outputUrl })
    res.json({ outputUrl })
  } catch (err) {
    slog('composite', 'Error', { error: err.message })
    res.status(500).json({ error: err.message })
  } finally {
    cleanup(videoIn, imageIn, audioIn, videoOut)
  }
})

app.post('/render', async (req, res) => {
  const { clipUrls, outputKey, backgroundMusicUrl, musicVolume = 0.2 } = req.body
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
    const listContent = clipFiles.map(f => `file '${f}'`).join('\n')
    fs.writeFileSync(listFile, listContent)
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg().input(listFile).inputOptions(['-f concat', '-safe 0'])
      if (musicFile) {
        cmd = cmd.input(musicFile).inputOptions(['-stream_loop', '-1'])
        cmd = cmd.complexFilter([
          `[0:a]apad,volume=2.0[voice_padded]`,
          `[1:a]volume=${(musicVolume * 2).toFixed(3)}[music]`,
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

app.get('/health', (_, res) => res.json({ ok: true }))
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `ffmpeg-worker listening on :${PORT}` }))
})
