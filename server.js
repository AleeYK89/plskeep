const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

function isValidTikTokUrl(url) {
  return /tiktok\.com/.test(url) || /vm\.tiktok\.com/.test(url) || /vt\.tiktok\.com/.test(url);
}

function sanitize(str) {
  return str.replace(/[^a-zA-Z0-9_\-.:/?=&%@]/g, '');
}

function sanitizeUsername(u) {
  return u.replace(/^@/, '').trim();
}

// ── POST /api/info — single video metadata ──────────────────────────────────
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url || !isValidTikTokUrl(url))
    return res.status(400).json({ error: 'Ongeldige TikTok URL.' });

  const safeUrl = sanitize(url);
  exec(`yt-dlp --dump-json --no-playlist "${safeUrl}"`, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('yt-dlp error:', stderr);
      return res.status(500).json({ error: 'Kon video info niet ophalen. Controleer de URL.' });
    }
    try {
      const info = JSON.parse(stdout);
      res.json({
        title: info.title || 'TikTok Video',
        uploader: info.uploader || info.creator || 'Unknown',
        duration: info.duration || 0,
        thumbnail: info.thumbnail || null,
        formats: (info.formats || [])
          .filter(f => f.ext === 'mp4' && f.height)
          .map(f => ({ format_id: f.format_id, quality: `${f.height}p`, height: f.height, filesize: f.filesize || null, ext: f.ext }))
          .sort((a, b) => b.height - a.height)
          .slice(0, 4),
        hasAudio: true,
      });
    } catch {
      res.status(500).json({ error: 'Kon video info niet verwerken.' });
    }
  });
});

// ── POST /api/user/videos — paginated video list ────────────────────────────
// Query: username, page (1-based), pageSize (default 24)
app.post('/api/user/videos', (req, res) => {
  let { username, page = 1, pageSize = 24 } = req.body;
  if (!username) return res.status(400).json({ error: 'Gebruikersnaam is verplicht.' });

  username = sanitizeUsername(username);
  if (!/^[\w.]+$/.test(username))
    return res.status(400).json({ error: 'Ongeldige gebruikersnaam.' });

  page = Math.max(1, parseInt(page) || 1);
  pageSize = Math.min(50, Math.max(6, parseInt(pageSize) || 24));

  const start = (page - 1) * pageSize + 1;
  const end   = page * pageSize;

  const profileUrl = `https://www.tiktok.com/@${username}`;
  console.log(`[user/videos] @${username} page=${page} items=${start}-${end}`);

  const cmd = `yt-dlp --flat-playlist --dump-json --playlist-start ${start} --playlist-end ${end} "${profileUrl}"`;

  exec(cmd, { timeout: 90000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && !stdout) {
      console.error('yt-dlp user error:', stderr);
      return res.status(500).json({ error: 'Kon profiel niet ophalen. Gebruiker bestaat mogelijk niet of is privé.' });
    }

    const lines = stdout.trim().split('\n').filter(Boolean);
    const videos = [];

    for (const line of lines) {
      try {
        const v = JSON.parse(line);
        videos.push({
          id: v.id,
          url: v.url || v.webpage_url || `https://www.tiktok.com/@${username}/video/${v.id}`,
          title: v.title || v.description || 'TikTok Video',
          thumbnail: v.thumbnail || v.thumbnails?.[0]?.url || null,
          duration: v.duration || 0,
          view_count: v.view_count || 0,
          like_count: v.like_count || 0,
          upload_date: v.upload_date || null,
        });
      } catch { /* skip */ }
    }

    // If we got fewer results than pageSize, we've hit the end
    const hasMore = videos.length >= pageSize;

    res.json({ username, videos, page, pageSize, hasMore });
  });
});

// ── GET /api/download — stream video to browser ─────────────────────────────
app.get('/api/download', (req, res) => {
  const { url, format, type } = req.query;
  if (!url || !isValidTikTokUrl(decodeURIComponent(url)))
    return res.status(400).json({ error: 'Ongeldige URL.' });

  const safeUrl = sanitize(decodeURIComponent(url));
  const tmpFile = path.join(os.tmpdir(), `tiksave_${Date.now()}`);

  let cmd, outputFile, mimeType, filename;

  if (type === 'mp3') {
    outputFile = `${tmpFile}.mp3`;
    filename = 'tiksave_audio.mp3';
    mimeType = 'audio/mpeg';
    cmd = `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${outputFile}" "${safeUrl}"`;
  } else {
    const fmtArg = format
      ? `-f "${format}+bestaudio/best"`
      : '-f "bestvideo[ext=mp4]+bestaudio/best/best[ext=mp4]"';
    outputFile = `${tmpFile}.mp4`;
    filename = 'tiksave_video.mp4';
    mimeType = 'video/mp4';
    cmd = `yt-dlp ${fmtArg} --merge-output-format mp4 --no-mark-watched -o "${outputFile}" "${safeUrl}"`;
  }

  console.log(`[download] type=${type || 'mp4'} url=${safeUrl}`);

  exec(cmd, { timeout: 120000 }, (err) => {
    if (err || !fs.existsSync(outputFile)) {
      return res.status(500).json({ error: 'Download mislukt. Video is mogelijk privé of niet beschikbaar.' });
    }
    const stat = fs.statSync(outputFile);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(outputFile, () => {}));
    stream.on('error', () => fs.unlink(outputFile, () => {}));
  });
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  exec('yt-dlp --version', (err, stdout) => {
    res.json({
      status: 'ok',
      ytdlp: err ? 'niet gevonden — installeer yt-dlp' : stdout.trim(),
    });
  });
});

app.listen(PORT, () => {
  console.log(`\n✅ TikSave draait op http://localhost:${PORT}\n`);
});
