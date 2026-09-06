const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.CLIENT_ID || "5c6b12721f854e4ca3e00ea6c432b62f"; 
const CLIENT_SECRET = process.env.CLIENT_SECRET || "1dd36b3cff78423b9363787733c89267";
const REDIRECT_URI = process.env.REDIRECT_URI || `https://remotify.up.railway.app/callback`;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Manejo seguro de users.json
const USERS_FILE = path.join(__dirname, "users.json");
let users = {};

try {
    if (fs.existsSync(USERS_FILE)) {
        users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    } else {
        fs.writeFileSync(USERS_FILE, JSON.stringify({}), "utf8");
    }
} catch (e) {
    console.error("Error cargando users.json:", e);
    users = {};
}

function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
    } catch (e) {
        console.error("Error guardando users.json:", e);
    }
}

const rooms = {};

function getRoom(username) {
    const userKey = username.toLowerCase();
    if (!rooms[userKey]) {
        rooms[userKey] = { 
            queue: [], 
            history: [], 
            nowPlaying: null,
            stats: {},
            anonCount: 0,
            lastActive: Date.now(),
            isOffline: false,
            offlineTimeStr: "0 MINS",
            djAvatar: ""
        };
    }
    return rooms[userKey];
}

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
    
    if (res.status === 401) {
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
        
        if (data.is_playing) {
            room.lastActive = Date.now();
            room.isOffline = false;
        }

        room.nowPlaying = {
            uri: track.uri,
            name: track.name,
            artist: track.artists.map(a => a.name).join(", "),
            albumCover: track.album?.images[0]?.url || "",
            isPlaying: data.is_playing,
            progress_ms: data.progress_ms,
            duration_ms: track.duration_ms,
            user: room.nowPlaying ? room.nowPlaying.user : "Spotify Direct"
        };
    }
}

// RUTA RAÍZ: Lleva al registro
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "register.html"));
});

// RUTAS DE AUTENTICACIÓN
app.get("/login", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/api/register", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ ok: false, error: "Llena todos los campos" });

    const key = username.toLowerCase();
    if (users[key]) return res.json({ ok: false, error: "El usuario ya existe" });

    users[key] = { username, password };
    saveUsers();
    res.json({ ok: true, username });
});

app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    const key = (username || "").toLowerCase();
    const user = users[key];

    if (user && user.password === password) {
        res.json({ ok: true, username: user.username });
    } else {
        res.json({ ok: false, error: "Usuario o contraseña incorrectos" });
    }
});

app.get("/login-spotify", (req, res) => {
    const username = req.query.username;
    if (!username) return res.send("Debes indicar un usuario para vincular Spotify.");

    const key = username.toLowerCase();
    if (!users[key]) {
        users[key] = { username: username };
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

            res.redirect(`/${encodeURIComponent(users[userKey].username)}`);
        } else {
            res.send("No se pudo obtener el token.");
        }
    } catch (e) {
        res.send("Error de red: " + e.message);
    }
});

// API DE DATOS
app.get("/api/dj/:username/state", async (req, res) => {
    const userKey = req.params.username.toLowerCase();
    if (!users[userKey] || !users[userKey].spotifyAccessToken) {
        return res.json({ error: "DJ no encontrado o no vinculado." });
    }

    await updateCurrentlyPlayingForUser(userKey);
    const room = getRoom(userKey);
    
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
    const mode = req.query.mode || "queue";

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
            await spotifyApiRequest(userKey, "/me/player/play", "PUT", { uris: [track.uri] });
            if (room.nowPlaying && room.nowPlaying.user) {
                room.history.unshift(room.nowPlaying);
            }
            room.nowPlaying = item;
            room.lastActive = Date.now();
        } else {
            await spotifyApiRequest(userKey, `/me/player/queue?uri=${encodeURIComponent(track.uri)}`, "POST");
            room.queue.push(item);
        }

        res.json({ ok: true, item });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// RUTA DINÁMICA DE PERFILES (remotify.up.railway.app/USUARIO)
app.get("/:username", (req, res) => {
    const username = req.params.username;
    const reservedRoutes = ["login", "register", "callback", "login-spotify", "api", "index.html", "register.html", "login.html"];
    
    if (reservedRoutes.includes(username.toLowerCase())) {
        return res.status(404).send("Ruta no encontrada");
    }

    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
    console.log(`Remotify Server corriendo en el puerto ${PORT}`);
});
