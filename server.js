const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// CONFIGURACIÓN DE SPOTIFY
// ==========================================
const CLIENT_ID = "5c6b12721f854e4ca3e00ea6c432b62f"; 
const CLIENT_SECRET = "1dd36b3cff78423b9363787733c89267";
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;

app.use(express.static(path.join(__dirname, "public"))); // Asegúrate de tener index.html y Akira.otf en la carpeta "public"
app.use(express.json());

// ==========================================
// BASES DE DATOS EN MEMORIA Y ARCHIVO
// ==========================================
const USERS_FILE = path.join(__dirname, "users.json");
let users = {};

if (fs.existsSync(USERS_FILE)) {
    users = JSON.parse(fs.readFileSync(USERS_FILE));
}

function saveUsers() {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

const rooms = {};

function getRoom(username) {
    const userKey = username.toLowerCase();
    if (!rooms[userKey]) {
        rooms[userKey] = { 
            queue: [], 
            history: [], 
            nowPlaying: null,
            stats: {}, // { "usuario1": { name: "Usuario1", tracks: 2, mins: 5, avatar: "url" } }
            anonCount: 0,
            lastActive: Date.now(),
            isOffline: false,
            offlineTimeStr: "0 MINS",
            djAvatar: ""
        };
    }
    return rooms[userKey];
}

// ==========================================
// FUNCIONES DE SPOTIFY
// ==========================================
async function refreshSpotifyToken(userKey) {
    const user = users[userKey];
    if (!user || !user.spotifyRefreshToken) return null;

    const params = new URLSearchParams();
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", user.spotifyRefreshToken);

    const authHeader = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    try {
        const res = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: {
                "Authorization": `Basic ${authHeader}`,
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params.toString()
        });
        const data = await res.json();
        if (data.access_token) {
            users[userKey].spotifyAccessToken = data.access_token;
            if (data.refresh_token) users[userKey].spotifyRefreshToken = data.refresh_token;
            saveUsers();
            return data.access_token;
        }
    } catch (e) {
        console.error("Error refrescando token para", userKey, e);
    }
    return null;
}

async function spotifyApiRequest(userKey, endpoint, method = "GET", body = null) {
    let token = users[userKey]?.spotifyAccessToken;
    if (!token) return null;

    let options = {
        method,
        headers: { "Authorization": `Bearer ${token}` }
    };
    if (body) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
    }

    let res = await fetch(`https://api.spotify.com/v1${endpoint}`, options);
    
    if (res.status === 401) { // Token expirado
        token = await refreshSpotifyToken(userKey);
        if (token) {
            options.headers["Authorization"] = `Bearer ${token}`;
            res = await fetch(`https://api.spotify.com/v1${endpoint}`, options);
        }
    }
    return res;
}

async function updateCurrentlyPlayingForUser(userKey) {
    const room = getRoom(userKey);
    
    // Calcular tiempo inactivo
    const timeInactiveMs = Date.now() - room.lastActive;
    const minsInactive = Math.floor(timeInactiveMs / 60000);
    room.isOffline = minsInactive >= 15;
    
    if (minsInactive >= 60) {
        room.offlineTimeStr = Math.floor(minsInactive / 60) + " HOURS";
    } else {
        room.offlineTimeStr = minsInactive + " MINS";
    }

    const res = await spotifyApiRequest(userKey, "/me/player/currently-playing");
    if (!res) return;

    if (res.status === 204 || res.status > 400) {
        if (room.nowPlaying) room.nowPlaying.isPlaying = false;
        return;
    }

    const data = await res.json();
    if (data && data.item) {
        const track = data.item;
        
        // Si está reproduciendo, reiniciar timer
        if (data.is_playing) {
            room.lastActive = Date.now();
            room.isOffline = false;
        }

        room.nowPlaying = {
            uri: track.uri,
            name: track.name,
            artist: track.artists.map(a => a.name).join(", "),
            albumCover: track.album && track.album.images && track.album.images[0] ? track.album.images[0].url : "",
            isPlaying: data.is_playing,
            progress_ms: data.progress_ms,
            duration_ms: track.duration_ms,
            user: room.nowPlaying ? room.nowPlaying.user : "Spotify Direct"
        };
    }
}

async function playTrackOnSpotify(userKey, uri) {
    await spotifyApiRequest(userKey, "/me/player/play", "PUT", { uris: [uri] });
}

async function addTrackToSpotifyQueue(userKey, uri) {
    await spotifyApiRequest(userKey, `/me/player/queue?uri=${encodeURIComponent(uri)}`, "POST");
}

// ==========================================
// ENDPOINTS DE AUTENTICACIÓN
// ==========================================
app.get("/login-spotify", (req, res) => {
    const username = req.query.username;
    if (!username) return res.send("Debes indicar un usuario para vincular Spotify.");

    if (!users[username.toLowerCase()]) {
        users[username.toLowerCase()] = { username: username };
        saveUsers();
    }

    const scope = "user-read-currently-playing user-read-playback-state user-modify-playback-state user-read-private";
    const state = encodeURIComponent(username);
    const authUrl = `https://accounts.spotify.com/authorize?response_type=code&client_id=${CLIENT_ID}&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;
    res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
    const code = req.query.code;
    const state = req.query.state;
    if (!code || !state) return res.send("Error en la autenticación.");

    const username = decodeURIComponent(state);
    const userKey = username.toLowerCase();

    const params = new URLSearchParams();
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("redirect_uri", REDIRECT_URI);

    const authHeader = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    try {
        const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: {
                "Authorization": `Basic ${authHeader}`,
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params.toString()
        });
        
        const data = await tokenRes.json();
        
        if (data.access_token) {
            if (!users[userKey]) users[userKey] = { username: username };
            users[userKey].spotifyAccessToken = data.access_token;
            users[userKey].spotifyRefreshToken = data.refresh_token;
            saveUsers();
            
            // Obtener el perfil de Spotify para el avatar del DJ
            try {
                const profileRes = await fetch("https://api.spotify.com/v1/me", {
                    headers: { "Authorization": `Bearer ${data.access_token}` }
                });
                const profileData = await profileRes.json();
                const room = getRoom(userKey);
                if (profileData.images && profileData.images.length > 0) {
                    room.djAvatar = profileData.images[0].url;
                }
            } catch (e) {
                console.log("Error obteniendo avatar del DJ");
            }

            res.redirect(`/?dj=${encodeURIComponent(users[userKey].username)}`);
        } else {
            res.send("No se pudo obtener el token.");
        }
    } catch (e) {
        res.send("Error de red: " + e.message);
    }
});

// ==========================================
// ENDPOINTS DE LA API (ESTADO Y BÚSQUEDA)
// ==========================================
app.get("/api/dj/:username/state", async (req, res) => {
    const userKey = req.params.username.toLowerCase();
    if (!users[userKey] || !users[userKey].spotifyAccessToken) {
        return res.json({ error: "DJ no encontrado o no vinculado." });
    }

    await updateCurrentlyPlayingForUser(userKey);
    const room = getRoom(userKey);
    
    // Procesar Top Players ordenando los stats por cantidad de tracks
    const topPlayersArray = Object.values(room.stats).sort((a, b) => b.tracks - a.tracks).slice(0, 3);
    
    res.json({
        ...room,
        topPlayers: topPlayersArray
    });
});

app.get("/api/dj/:username/search", async (req, res) => {
    const userKey = req.params.username.toLowerCase();
    const query = req.query.q;
    const visitor = req.query.user || "Anónimo";
    const mode = req.query.mode || "queue"; // "now" o "queue"

    if (!query) return res.json({ ok: false, error: "Falta término de búsqueda" });
    if (!users[userKey] || !users[userKey].spotifyAccessToken) {
        return res.json({ ok: false, error: "DJ no disponible" });
    }

    try {
        const searchRes = await spotifyApiRequest(userKey, `/search?q=${encodeURIComponent(query)}&type=track&limit=1`);
        if (!searchRes) return res.json({ ok: false });

        const data = await searchRes.json();
        const track = data.tracks?.items[0];
        if (!track) return res.json({ ok: false });

        const room = getRoom(userKey);
        const durationMins = Math.round(track.duration_ms / 60000);

        // Registro de Estadísticas de Top Players
        if (visitor === "Anónimo") {
            room.anonCount += 1;
        } else {
            const vKey = visitor.toLowerCase();
            if (!room.stats[vKey]) {
                room.stats[vKey] = { name: visitor, tracks: 0, mins: 0, avatar: "default-avatar.png" };
            }
            room.stats[vKey].tracks += 1;
            room.stats[vKey].mins += durationMins;
        }

        const item = {
            uri: track.uri,
            name: track.name,
            artist: track.artists.map(a => a.name).join(", "),
            albumCover: track.album?.images[0]?.url || "",
            user: visitor,
            timeAgo: "JUST NOW" 
        };

        if (mode === "now") {
            await playTrackOnSpotify(userKey, track.uri);
            if (room.nowPlaying && room.nowPlaying.user) {
                room.history.unshift(room.nowPlaying);
            }
            room.nowPlaying = item;
            room.lastActive = Date.now(); // Despierta al DJ al poner una canción
        } else {
            await addTrackToSpotifyQueue(userKey, track.uri);
            room.queue.push(item);
        }

        res.json({ ok: true, item });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ==========================================
// INICIO DEL SERVIDOR
// ==========================================
app.listen(PORT, () => {
    console.log(`Remotify Server corriendo en el puerto ${PORT}`);
    console.log(`URL de login: http://localhost:${PORT}/login-spotify?username=TU_USUARIO`);
});
