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
// Checks known system paths first, then searches the Nix store (Railway/NixOS),
// then falls back to fc-match.
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
  // Nix store — freefont_ttf installs to /nix/store/{hash}-freefont-ttf-*/share/fonts/truetype/
  try {
    const nixFont = execSync('find /nix/store -name "FreeSans.ttf" 2>/dev/null | head -1', { timeout: 5000 })
      .toString().trim()
    if (nixFont && fs.existsSync(nixFont)) return nixFont
  } catch {}
  // Fallback: any TTF via fc-match
  try {
    const fcMatch = execSync('fc-match -f "%{file}" :spacing=proportional:fontformat=TrueType 2>/dev/null', { timeout: 3000 })
      .toString().trim()
    if (fcMatch && fs.existsSync(fcMatch)) return fcMatch
  } catch {}
  // Last resort: any TTF via fc-list
  try {
    const fcList = execSync('fc-list : file | grep -i "\\.ttf" | head -1', { timeout: 3000 })
      .toString().trim().split(':')[0]
    if (fcList && fs.existsSync(fcList)) return fcList
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
// Burns voiceover audio + on-screen text onto a background.
// Body: {
//   backgroundType?: 'video' (default) | 'canvas' | 'image',
//   visualClipUrl?,   // for backgroundType='video'
//   canvasStyle?,     // 'white' | 'dark' | 'muted' — for backgroundType='canvas'
//   imageUrl?,        // for backgroundType='image'
//   voiceoverUrl, onScreenText, duration, outputKey, watermark, quality
// }
// Returns: { outputUrl }
//
// Duration behaviour:
//   - With voiceover: -shortest trims to whichever ends first
//   - Without voiceover: -t <duration> caps at intended scene length
//   - canvas: lavfi color source already has d=<duration>; -shortest trims to audio

const CANVAS_COLORS = { white: '0xf5f5f5', dark: '0x111111', muted: '0x1a1a2e' }

app.post('/composite', async (req, res) => {
  const {
    visualClipUrl, voiceoverUrl, onScreenText, duration, outputKey, watermark,
    backgroundType = 'video', canvasStyle = 'dark', imageUrl,
  } = req.body
  slog('composite', 'Start', { outputKey, backgroundType, hasVoiceover: !!voiceoverUrl })

  const isTemplate = backgroundType === 'canvas' || backgroundType === 'image'
  const videoIn = backgroundType === 'video' ? tmpFile('.mp4') : null
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

      if (backgroundType === 'canvas') {
        const hex = CANVAS_COLORS[canvasStyle] || CANVAS_COLORS.dark
        cmd = ffmpeg()
          .input(`color=c=${hex}:s=1080x1920:r=30:d=${duration || 10}`)
          .inputOptions(['-f lavfi'])
      } else if (backgroundType === 'image') {
        cmd = ffmpeg()
          .input(imageIn)
          .inputOptions(['-loop 1'])
      } else {
        // Default: video clip background
        cmd = ffmpeg(videoIn)
      }

      if (audioIn) {
        cmd = cmd.input(audioIn).audioCodec('aac').audioBitrate('128k')
      }

      const filters = []

      // Scale/crop image to fill 1080x1920 portrait
      if (backgroundType === 'image') {
        filters.push('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920')
      }

      // On-screen text overlay — centered for template scenes, bottom for video
      if (FONT_PATH && onScreenText?.trim()) {
        const escaped = onScreenText.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:')
        // For white canvas, use dark text so it's visible
        const fontColor = (backgroundType === 'canvas' && canvasStyle === 'white') ? 'black' : 'white'
        const borderColor = (backgroundType === 'canvas' && canvasStyle === 'white') ? 'white@0.5' : 'black@0.7'
        if (isTemplate) {
          filters.push(
            `drawtext=fontfile='${FONT_PATH}':text='${escaped}':fontsize=80:fontcolor=${fontColor}:` +
            `x=(w-text_w)/2:y=(h-text_h)/2:borderw=4:bordercolor=${borderColor}:shadowx=2:shadowy=2`
          )
        } else {
          filters.push(
            `drawtext=fontfile='${FONT_PATH}':text='${escaped}':fontsize=48:fontcolor=white:` +
            `x=(w-text_w)/2:y=h-120:borderw=3:bordercolor=black:shadowx=2:shadowy=2`
          )
        }
      }

      // Watermark
      if (FONT_PATH && watermark) {
        filters.push(`drawtext=fontfile='${FONT_PATH}':text='demostudio':fontsize=22:fontcolor=white@0.5:x=20:y=20`)
      }

      if (filters.length) {
        cmd = cmd.videoFilters(filters)
      }

      const outputOpts = ['-preset fast', '-crf 23', '-movflags +faststart']
      if (audioIn) {
        outputOpts.push('-map', '0:v:0', '-map', '1:a:0', '-shortest')
      } else {
        outputOpts.push(`-t ${duration || 10}`)
      }

      cmd
        .videoCodec('libx264')
        .outputOptions(outputOpts)
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
    cleanup(videoIn, imageIn, audioIn, videoOut)
  }
})

// ── POST /render ───────────────────────────────────────────────────────────────
// Concatenates multiple composited clip URLs into a single final export MP4.
// Body: { clipUrls, outputKey, backgroundMusicUrl?, musicVolume?, quality, watermark }
// Returns: { outputUrl }
//
// If backgroundMusicUrl is provided, the music is looped to match the video
// duration and mixed under the voiceover at musicVolume (default 0.2).
app.post('/render', async (req, res) => {
  const { clipUrls, outputKey, backgroundMusicUrl, musicVolume = 0.2 } = req.body
  slog('render', 'Start', { clips: clipUrls?.length, outputKey, hasMusic: !!backgroundMusicUrl })

  if (!clipUrls?.length) {
    return res.status(400).json({ error: 'No clip URLs provided' })
  }

  const clipFiles = []
  const listFile = tmpFile('.txt')
  const musicFile = backgroundMusicUrl ? tmpFile('.mp3') : null
  const videoOut = tmpFile('.mp4')

  try {
    // Download all clips
    for (let i = 0; i < clipUrls.length; i++) {
      const f = tmpFile('.mp4')
      await download(clipUrls[i], f)
      clipFiles.push(f)
    }

    // Download background music if provided
    if (musicFile) await download(backgroundMusicUrl, musicFile)

    // Write concat list
    const listContent = clipFiles.map(f => `file '${f}'`).join('\n')
    fs.writeFileSync(listFile, listContent)

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg()
        .input(listFile)
        .inputOptions(['-f concat', '-safe 0'])

      if (musicFile) {
        // Loop music so it covers the full video duration
        cmd = cmd.input(musicFile).inputOptions(['-stream_loop', '-1'])

        // Music mixing strategy:
        // - Pre-scale voice to 2× and music to 2×musicVolume so that after amix's
        //   built-in ÷2 normalization the effective levels are 1.0 and musicVolume.
        // - apad extends the voiceover with silence so it covers the full video length.
        //   Without this, amix stops when the voiceover ends even if the video continues.
        // - Music is [1:a] with -stream_loop -1 (looped), so it outlasts the video.
        // - amix duration=first uses the first stream ([voice_padded]) to set length.
        //   Since apad makes voice_padded infinite, amix runs indefinitely.
        // - -shortest in outputOptions then trims the final output to the video length.
        cmd = cmd
          .complexFilter([
            `[0:a]apad,volume=2.0[voice_padded]`,
            `[1:a]volume=${(musicVolume * 2).toFixed(3)}[music]`,
            `[voice_padded][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
          ])
          .outputOptions([
            '-map 0:v:0',
            '-map [aout]',
            '-c:v libx264',
            '-c:a aac',
            '-preset fast',
            '-crf 20',
            '-movflags +faststart',
            '-shortest',
          ])
      } else {
        cmd = cmd
          .videoCodec('libx264')
          .audioCodec('aac')
          .outputOptions(['-preset fast', '-crf 20', '-movflags +faststart'])
      }

      cmd
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
    cleanup(...clipFiles, listFile, musicFile, videoOut)
  }
})

app.get('/health', (_, res) => res.json({ ok: true }))

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `ffmpeg-worker listening on :${PORT}` }))
})
