const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.get('/login', (req, res) => {
  const scope = 'user-read-playback-state user-modify-playback-state playlist-modify-public';
  const query = querystring.stringify({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope,
    redirect_uri: process.env.REDIRECT_URI
  });
  res.redirect(`https://accounts.spotify.com/authorize?${query}`);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  const tokenUrl = 'https://accounts.spotify.com/api/token';

  try {
    const response = await axios.post(tokenUrl, querystring.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.REDIRECT_URI,
      client_id: process.env.SPOTIFY_CLIENT_ID,
      client_secret: process.env.SPOTIFY_CLIENT_SECRET
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { access_token, refresh_token } = response.data;
    res.send(`Access Token: ${access_token}<br>Refresh Token: ${refresh_token}`);
  } catch (err) {
    res.status(500).send('Error retrieving tokens');
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
