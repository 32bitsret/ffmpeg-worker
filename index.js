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

// Detect a usable font file for drawtext filter
function detectFont() {
  const candidates = [
    '/nix/var/nix/profiles/default/share/fonts/truetype/FreeSans.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
  ]
  for (const f of candidates) {
    if (fs.existsSync(f)) return f
  }
  try {
    const result = execSync('fc-list : file | grep -i "freesans\\|dejavusans\\|liberation" | head -1', { timeout: 3000 })
      .toString().trim().split(':')[0]
    if (result && fs.existsSync(result)) return result
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

// ── POST /composite ────────────────────────────────────────────────────────────
// Burns voiceover audio + on-screen text onto a raw visual clip.
// Body: { visualClipUrl, voiceoverUrl, onScreenText, duration, outputKey, watermark, quality }
// Returns: { outputUrl }
app.post('/composite', async (req, res) => {
  const { visualClipUrl, voiceoverUrl, onScreenText, duration, outputKey, watermark } = req.body
  slog('composite', 'Start', { outputKey })

  const videoIn = tmpFile('.mp4')
  const audioIn = voiceoverUrl ? tmpFile('.mp3') : null
  const videoOut = tmpFile('.mp4')

  try {
    await download(visualClipUrl, videoIn)
    if (audioIn) await download(voiceoverUrl, audioIn)

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(videoIn)

      if (audioIn) {
        cmd = cmd.input(audioIn).audioCodec('aac').audioBitrate('128k')
      }

      // On-screen text overlay
      const filters = []
      if (FONT_PATH && onScreenText?.trim()) {
        const escaped = onScreenText.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:')
        filters.push(
          `drawtext=fontfile='${FONT_PATH}':text='${escaped}':fontsize=48:fontcolor=white:` +
          `x=(w-text_w)/2:y=h-120:borderw=3:bordercolor=black:shadowx=2:shadowy=2`
        )
      }

      // Watermark
      if (FONT_PATH && watermark) {
        filters.push(`drawtext=fontfile='${FONT_PATH}':text='ugcforapps.com':fontsize=22:fontcolor=white@0.5:x=20:y=20`)
      }

      if (filters.length) {
        cmd = cmd.videoFilters(filters)
      }

      cmd
        .videoCodec('libx264')
        .outputOptions(['-preset fast', '-crf 23', '-movflags +faststart', `-t ${duration || 10}`])
        .output(videoOut)
        .on('end', resolve)
        .on('error', reject)
        .run()
    })

    const outputUrl = await uploadToR2(outputKey, videoOut, 'video/mp4')
    slog('composite', 'Done', { outputUrl })
    res.json({ outputUrl })
  } catch (err) {
    slog('composite', 'Error', { error: err.message })
    res.status(500).json({ error: err.message })
  } finally {
    cleanup(videoIn, audioIn, videoOut)
  }
})

// ── POST /render ───────────────────────────────────────────────────────────────
// Concatenates multiple composited clip URLs into a single final export MP4.
// Body: { clipUrls, outputKey, quality, watermark }
// Returns: { outputUrl }
app.post('/render', async (req, res) => {
  const { clipUrls, outputKey } = req.body
  slog('render', 'Start', { clips: clipUrls?.length, outputKey })

  if (!clipUrls?.length) {
    return res.status(400).json({ error: 'No clip URLs provided' })
  }

  const clipFiles = []
  const listFile = tmpFile('.txt')
  const videoOut = tmpFile('.mp4')

  try {
    // Download all clips
    for (let i = 0; i < clipUrls.length; i++) {
      const f = tmpFile('.mp4')
      await download(clipUrls[i], f)
      clipFiles.push(f)
    }

    // Write concat list
    const listContent = clipFiles.map(f => `file '${f}'`).join('\n')
    fs.writeFileSync(listFile, listContent)

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listFile)
        .inputOptions(['-f concat', '-safe 0'])
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions(['-preset fast', '-crf 20', '-movflags +faststart'])
        .output(videoOut)
        .on('end', resolve)
        .on('error', reject)
        .run()
    })

    const outputUrl = await uploadToR2(outputKey, videoOut, 'video/mp4')
    slog('render', 'Done', { outputUrl })
    res.json({ outputUrl })
  } catch (err) {
    slog('render', 'Error', { error: err.message })
    res.status(500).json({ error: err.message })
  } finally {
    cleanup(...clipFiles, listFile, videoOut)
  }
})

app.get('/health', (_, res) => res.json({ ok: true }))

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `ffmpeg-worker listening on :${PORT}` }))
})
