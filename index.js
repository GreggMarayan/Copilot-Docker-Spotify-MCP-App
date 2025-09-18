require('dotenv').config();
const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET || !process.env.REDIRECT_URI) {
  console.warn('Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / REDIRECT_URI in env — set them before using OAuth.');
}

// In-memory stores (for demo). Replace with a persistent store for production.
const states = new Set();
const tokenStore = {
  access_token: null,
  refresh_token: null,
  expires_at: 0 // epoch ms
};

function base64Client() {
  return Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
}

async function refreshAccessTokenIfNeeded() {
  if (!tokenStore.refresh_token) return;
  if (Date.now() < tokenStore.expires_at - 10000) return; // still valid (10s buffer)

  const tokenUrl = 'https://accounts.spotify.com/api/token';
  try {
    const body = querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token: tokenStore.refresh_token
    });
    const resp = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${base64Client()}`
      }
    });
    tokenStore.access_token = resp.data.access_token;
    if (resp.data.refresh_token) tokenStore.refresh_token = resp.data.refresh_token;
    tokenStore.expires_at = Date.now() + (resp.data.expires_in || 3600) * 1000;
    console.log('Refreshed access token');
  } catch (err) {
    console.error('Failed to refresh token:', err.response ? err.response.data : err.message);
    throw err;
  }
}

function ensureAuth(req, res, next) {
  if (!tokenStore.access_token) return res.status(401).json({ error: 'Not authenticated. Visit /login to authorize.' });
  refreshAccessTokenIfNeeded().then(() => next()).catch(e => res.status(500).json({ error: 'Failed to refresh token' }));
}

// Simple mood -> seed genres mapping and naive sentiment checking
function mapPromptToSeeds(prompt) {
  if (!prompt) return { seed_genres: ['pop'], description: 'default' };
  const p = prompt.toLowerCase();
  const positive = ['happy', 'joy', 'energetic', 'upbeat', 'excited'];
  const calm = ['calm', 'chill', 'relaxed', 'sleep', 'soft'];
  const sad = ['sad', 'melancholy', 'down', 'blue'];
  for (const w of positive) if (p.includes(w)) return { seed_genres: ['dance', 'pop'], description: 'energetic' };
  for (const w of calm) if (p.includes(w)) return { seed_genres: ['chill', 'ambient'], description: 'calm' };
  for (const w of sad) if (p.includes(w)) return { seed_genres: ['acoustic', 'sad'], description: 'melancholic' };
  // fallback: try to detect genre keywords
  const genres = ['rock','hip-hop','rap','jazz','classical','electronic','country'];
  for (const g of genres) if (p.includes(g)) return { seed_genres: [g], description: g };
  return { seed_genres: ['pop'], description: 'general' };
}

// Auth endpoints
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  states.add(state);
  const scope = 'playlist-modify-public playlist-modify-private user-read-email user-read-private user-modify-playback-state user-read-playback-state';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID || '',
    scope,
    redirect_uri: process.env.REDIRECT_URI || '',
    state
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send('Authorization error: ' + error);
  if (!code || !state || !states.has(state)) return res.status(400).send('Missing/invalid state or code');

  states.delete(state);

  try {
    const tokenUrl = 'https://accounts.spotify.com/api/token';
    const body = querystring.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.REDIRECT_URI
    });
    const response = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${base64Client()}`
      }
    });

    tokenStore.access_token = response.data.access_token;
    tokenStore.refresh_token = response.data.refresh_token;
    tokenStore.expires_at = Date.now() + (response.data.expires_in || 3600) * 1000;

    // Do not show secrets in production. For demo, show a success message.
    res.send('Authorization successful. You can now call /api endpoints.');
  } catch (err) {
    console.error('Token exchange failed:', err.response ? err.response.data : err.message);
    res.status(500).send('Token exchange failed: ' + (err.response ? JSON.stringify(err.response.data) : err.message));
  }
});

// API routes
app.get('/api/recommendations', ensureAuth, async (req, res) => {
  try {
    const prompt = req.query.prompt || req.query.mood || '';
    const { seed_genres, description } = mapPromptToSeeds(prompt);
    const params = new URLSearchParams({
      seed_genres: seed_genres.slice(0, 5).join(','),
      limit: req.query.limit || 10
    });
    await refreshAccessTokenIfNeeded();
    const resp = await axios.get(`https://api.spotify.com/v1/recommendations?${params.toString()}`, {
      headers: { Authorization: `Bearer ${tokenStore.access_token}` }
    });
    res.json({ description, seeds: seed_genres, tracks: resp.data.tracks });
  } catch (err) {
    console.error('Recommendations error:', err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

app.post('/api/playlist', ensureAuth, async (req, res) => {
  try {
    const { name, description = '', public = false, prompt = '', track_limit = 10 } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });

    await refreshAccessTokenIfNeeded();
    // Create playlist for current user
    const createResp = await axios.post('https://api.spotify.com/v1/me/playlists', {
      name,
      description,
      public
    }, {
      headers: { Authorization: `Bearer ${tokenStore.access_token}`, 'Content-Type': 'application/json' }
    });

    const playlistId = createResp.data.id;

    // Get recommendations based on prompt
    const { seed_genres } = mapPromptToSeeds(prompt);
    const recParams = new URLSearchParams({
      seed_genres: seed_genres.slice(0, 5).join(','),
      limit: track_limit
    });
    const recResp = await axios.get(`https://api.spotify.com/v1/recommendations?${recParams.toString()}`, {
      headers: { Authorization: `Bearer ${tokenStore.access_token}` }
    });

    const uris = recResp.data.tracks.map(t => t.uri);
    if (uris.length) {
      await axios.post(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, { uris }, {
        headers: { Authorization: `Bearer ${tokenStore.access_token}`, 'Content-Type': 'application/json' }
      });
    }

    res.json({ playlist: createResp.data, added: uris.length });
  } catch (err) {
    console.error('Create playlist error:', err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'Failed to create playlist' });
  }
});

app.post('/api/queue', ensureAuth, async (req, res) => {
  try {
    const { uri, track_name } = req.body || {};
    await refreshAccessTokenIfNeeded();

    let trackUri = uri;
    if (!trackUri && track_name) {
      // search for the track
      const q = encodeURIComponent(track_name);
      const searchResp = await axios.get(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`, {
        headers: { Authorization: `Bearer ${tokenStore.access_token}` }
      });
      const items = searchResp.data.tracks.items;
      if (!items || items.length === 0) return res.status(404).json({ error: 'Track not found' });
      trackUri = items[0].uri;
    }
    if (!trackUri) return res.status(400).json({ error: 'uri or track_name required' });

    // Queue track - requires an active device
    await axios.post(`https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}`, null, {
      headers: { Authorization: `Bearer ${tokenStore.access_token}` }
    });

    res.json({ queued: trackUri });
  } catch (err) {
    console.error('Queue error:', err.response ? err.response.data : err.message);
    const status = err.response ? err.response.status : 500;
    res.status(status).json({ error: 'Failed to queue track', details: err.response ? err.response.data : err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Export app for tests; start server when run directly
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
}
module.exports = app;
