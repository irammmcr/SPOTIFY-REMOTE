const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jwt-simple"); // O puedes usar jsonwebtoken si prefieres

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// 🔑 CREDENCIALES
const CLIENT_ID = process.env.CLIENT_ID || "5c6b12721f854e4ca3e00ea6c432b62f";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "1dd36b3cff78423b9363787733c89267";
const REDIRECT_URI = process.env.REDIRECT_URI || "https://remotify.up.railway.app/callback";
const JWT_SECRET = process.env.JWT_SECRET || "remotify_secret_key_12345";

const USERS_FILE = path.join(__dirname, "users.json");
const MAX_USERS = 10;

let users = {}; // { username: { passwordHash, spotifyRefreshToken, spotifyAccessToken } }
let rooms = {}; // { username: { queue: [], history: [], nowPlaying: null } }

// 💾 CARGAR Y GUARDAR USUARIOS
function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const raw = fs.readFileSync(USERS_FILE, "utf8");
            users = JSON.parse(raw);
            console.log("💾 Usuarios cargados:", Object.keys(users).length);
        }
    } catch (e) {
        console.log("❌ Error cargando usuarios:", e.message);
    }
}

function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
        console.log("❌ Error guardando usuarios:", e.message);
    }
}

function getRoom(username) {
    const userKey = username.toLowerCase();
    if (!rooms[userKey]) {
        rooms[userKey] = { queue: [], history: [], nowPlaying: null };
    }
    return rooms[userKey];
}

// ============================
// 👤 SISTEMA DE USUARIOS (MAX 10)
// ============================

app.post("/api/register", async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: "Usuario y contraseña requeridos" });
    }

    const userKey = username.toLowerCase();

    if (users[userKey]) {
        return res.status(400).json({ error: "El usuario ya existe" });
    }

    if (Object.keys(users).length >= MAX_USERS) {
        return res.status(403).json({ error: "Se ha alcanzado el límite máximo de 10 usuarios." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    users[userKey] = {
        username: username,
        passwordHash: passwordHash,
        spotifyRefreshToken: null
    };

    saveUsers();
    res.json({ ok: true, message: "Usuario registrado con éxito" });
});

app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    const userKey = (username || "").toLowerCase();
    const user = users[userKey];

    if (!user) {
        return res.status(400).json({ error: "Usuario no encontrado" });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
        return res.status(400).json({ error: "Contraseña incorrecta" });
    }

    // Generar sesión básica (puedes enviar el username al cliente)
    res.json({ ok: true, username: user.username });
});

// ============================
// 🔐 AUTH SPOTIFY POR USUARIO
// ============================

app.get("/login-spotify", (req, res) => {
    const username = req.query.username;
    if (!username) return res.send("Debes indicar un usuario para vincular Spotify.");

    const scope = "user-read-currently-playing user-read-playback-state user-modify-playback-state";
    const state = encodeURIComponent(username);
    const authUrl = `https://accounts.spotify.com/authorize?response_type=code&client_id=${CLIENT_ID}&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;
    res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
    const code = req.query.code;
    const username = req.query.state;

    if (!code || !username) return res.send("Error al obtener autenticación de Spotify");

    const userKey = username.toLowerCase();
    if (!users[userKey]) return res.send("Usuario no registrado en el sistema");

    try {
        const bodyParams = new URLSearchParams({
            grant_type: "authorization_code",
            code: code,
            redirect_uri: REDIRECT_URI,
        });

        const response = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: {
                "Authorization": "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: bodyParams.toString(),
        });

        const data = await response.json();

        if (data.access_token) {
            users[userKey].spotifyAccessToken = data.access_token;
            users[userKey].spotifyRefreshToken = data.refresh_token;
            saveUsers();
            res.redirect(`/?dj=${encodeURIComponent(users[userKey].username)}`);
        } else {
            res.status(400).json(data);
        }
    } catch (err) {
        res.status(500).send("Error autenticando con Spotify: " + err.message);
    }
});

async function refreshUserAccessToken(userKey) {
    const user = users[userKey];
    if (!user || !user.spotifyRefreshToken) return null;

    try {
        const bodyParams = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: user.spotifyRefreshToken,
        });

        const response = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: {
                "Authorization": "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: bodyParams.toString(),
        });

        const data = await response.json();
        if (data.access_token) {
            user.spotifyAccessToken = data.access_token;
            if (data.refresh_token) {
                user.spotifyRefreshToken = data.refresh_token;
            }
            saveUsers();
            return user.spotifyAccessToken;
        }
    } catch (e) {
        console.log(`❌ Error renovando token de ${userKey}:`, e.message);
    }
    return null;
}

// ============================
// 🎵 SINCRO Y CONTROL POR SALA
// ============================

async function updateCurrentlyPlayingForUser(userKey) {
    const user = users[userKey];
    if (!user || !user.spotifyRefreshToken) return;

    let token = user.spotifyAccessToken;
    if (!token) token = await refreshUserAccessToken(userKey);
    if (!token) return;

    try {
        let res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (res.status === 401) {
            token = await refreshUserAccessToken(userKey);
            if (token) {
                res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
                    headers: { Authorization: `Bearer ${token}` },
                });
            }
        }

        const room = getRoom(userKey);
        if (res.status === 204 || res.status > 400) {
            room.nowPlaying = { name: "Offline", user: "Sin música activa" };
            return;
        }

        const data = await res.json();
        if (data && data.item) {
            const track = data.item;
            room.nowPlaying = {
                uri: track.uri,
                name: track.name,
                artist: track.artists.map(a => a.name).join(", "),
                albumCover: track.album && track.album.images && track.album.images[0] ? track.album.images[0].url : "",
                isPlaying: data.is_playing,
                progress_ms: data.progress_ms,
                duration_ms: track.duration_ms,
                user: "Spotify Direct"
            };
        }
    } catch (err) {
        console.log(`Error actualizando ${userKey}:`, err.message);
    }
}

setInterval(() => {
    Object.keys(users).forEach(userKey => {
        updateCurrentlyPlayingForUser(userKey);
    });
}, 4000);

async function playTrackOnSpotify(userKey, uri) {
    let token = users[userKey]?.spotifyAccessToken || await refreshUserAccessToken(userKey);
    if (!token) return false;

    const res = await fetch("https://api.spotify.com/v1/me/player/play", {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ uris: [uri] })
    });
    return res.status === 204 || res.status === 200;
}

async function addTrackToSpotifyQueue(userKey, uri) {
    let token = users[userKey]?.spotifyAccessToken || await refreshUserAccessToken(userKey);
    if (!token) return false;

    const res = await fetch(`https://api.spotify.com/v1/me/player/add-to-queue?uri=${encodeURIComponent(uri)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
    });
    return res.status === 204 || res.status === 200;
}

// ============================
// 🔍 ENDPOINTS PÚBLICOS POR SALA
// ============================

app.get("/api/dj/:username/state", (req, res) => {
    function getRoom(username) {
    const userKey = username.toLowerCase();
    if (!rooms[userKey]) {
        rooms[userKey] = { 
            queue: [], 
            history: [], 
            nowPlaying: null,
            stats: {}, // { "user1": { tracks: 2, mins: 5, avatar: "url" } }
            anonCount: 0,
            lastActive: Date.now(),
            isOffline: false,
            djAvatar: ""
        };
    }
    return rooms[userKey];
}
});

app.get("/api/dj/:username/search", async (req, res) => {
    const userKey = req.params.username.toLowerCase();
    const user = users[userKey];
    const q = req.query.q;
    const visitor = req.query.user || "Anónimo";
    const mode = req.query.mode || "queue";

    if (!user) return res.status(404).json({ error: "DJ no encontrado" });
    if (!q) return res.json({ ok: false });

    try {
        let token = user.spotifyAccessToken || await refreshUserAccessToken(userKey);
        if (!token) return res.status(400).json({ error: "El DJ no tiene Spotify vinculado." });

        const searchRes = await fetch(
            `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        const data = await searchRes.json();
        const track = data.tracks?.items[0];
        if (!track) return res.json({ ok: false });

        const item = {
            uri: track.uri,
            name: track.name,
            artist: track.artists.map(a => a.name).join(", "),
            albumCover: track.album?.images[0]?.url || "",
            user: visitor
        };

        const room = getRoom(userKey);

        if (mode === "now") {
            await playTrackOnSpotify(userKey, track.uri);
            if (room.nowPlaying) room.history.unshift(room.nowPlaying);
            room.nowPlaying = item;
        } else {
            await addTrackToSpotifyQueue(userKey, track.uri);
            room.queue.push(item);
        }

        res.json({ ok: true, item });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

loadUsers();

const PORT = 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🔥 Remotify Multiusuario listo en puerto ${PORT}`);
});
