const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// 🔑 CONFIGURACIÓN
const CLIENT_ID = process.env.CLIENT_ID || "d67ff6f68928459f81948f0de2b4c68b";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "dca742b376684b799e804f119f053a72";
const REDIRECT_URI = process.env.REDIRECT_URI || "https://remotify.up.railway.app/callback";

let userRefreshToken = null;
let userAccessToken = null;

// 🔥 SISTEMA DJ
let queue = [];
let history = [];
let nowPlaying = null;

const DATA_FILE = path.join(__dirname, "data.json");

// ============================
// 💾 CARGAR / GUARDAR DATOS
// ============================

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE);
            const data = JSON.parse(raw);
            queue = data.queue || [];
            history = data.history || [];
            nowPlaying = data.nowPlaying || null;
            userRefreshToken = data.userRefreshToken || null;
            console.log("💾 Datos cargados con éxito");
        }
    } catch {
        console.log("❌ Error cargando datos");
    }
}

function saveData() {
    try {
        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify({ queue, history, nowPlaying, userRefreshToken }, null, 2)
        );
    } catch {
        console.log("❌ Error guardando datos");
    }
}

// ============================
// 🔐 AUTENTICACIÓN USUARIO SPOTIFY
// ============================

app.get("/login", (req, res) => {
    const scope = "user-read-currently-playing user-read-playback-state";
    const authUrl = `https://accounts.spotify.com/authorize?response_type=code&client_id=${CLIENT_ID}&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
    res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("Error al obtener el código de Spotify");

    try {
        const response = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: {
                "Authorization": "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: code,
                redirect_uri: REDIRECT_URI,
            }),
        });

        const data = await response.json();

        if (data.access_token) {
            userAccessToken = data.access_token;
            userRefreshToken = data.refresh_token;
            saveData();
            res.send("<h1>¡Remotify conectado con tu Spotify con éxito! 🎉</h1><p>Ya puedes cerrar esta ventana y volver a la app.</p>");
        } else {
            res.status(400).json(data);
        }
    } catch (err) {
        res.status(500).send("Error autenticando con Spotify: " + err.message);
    }
});

async function refreshUserAccessToken() {
    if (!userRefreshToken) return null;

    try {
        const response = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: {
                "Authorization": "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: userRefreshToken,
            }),
        });

        const data = await response.json();
        if (data.access_token) {
            userAccessToken = data.access_token;
            if (data.refresh_token) {
                userRefreshToken = data.refresh_token;
                saveData();
            }
            return userAccessToken;
        }
    } catch (e) {
        console.log("❌ Error renovando token:", e);
    }
    return null;
}

// ============================
// 🎵 CONSULTA EN TIEMPO REAL
// ============================

async function updateCurrentlyPlaying() {
    if (!userAccessToken && userRefreshToken) {
        await refreshUserAccessToken();
    }
    if (!userAccessToken) return;

    try {
        let res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
            headers: { Authorization: `Bearer ${userAccessToken}` },
        });

        if (res.status === 401) {
            const newToken = await refreshUserAccessToken();
            if (newToken) {
                res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
                    headers: { Authorization: `Bearer ${newToken}` },
                });
            }
        }

        if (res.status === 204 || res.status > 400) {
            nowPlaying = { name: "Offline", user: "Sin música activa" };
            return;
        }

        const data = await res.json();
        if (data && data.item) {
            const track = data.item;
            nowPlaying = {
                uri: track.uri,
                name: track.name,
                artist: track.artists.map(a => a.name).join(", "),
                albumCover: track.album.images[0]?.url || "",
                isPlaying: data.is_playing,
                progress_ms: data.progress_ms,
                duration_ms: track.duration_ms,
                user: "Spotify Direct"
            };
            saveData();
        }
    } catch (err) {
        console.log("Error obteniendo canción actual:", err.message);
    }
}

setInterval(updateCurrentlyPlaying, 3000);

// ============================
// SEARCH & LOGICA DE BÚSQUEDA
// ============================

function scoreTrack(track, query) {
    const q = query.toLowerCase();
    const name = track.name.toLowerCase();
    const artist = track.artists.map(a => a.name).join(" ").toLowerCase();

    let score = 0;
    if (name === q) score += 100;
    if (name.includes(q)) score += 50;
    if (artist.includes(q)) score += 20;

    score += track.popularity / 2;
    return score;
}

async function searchTrack(query) {
    if (!userAccessToken) await refreshUserAccessToken();
    if (!userAccessToken) throw new Error("Debes vincular tu cuenta en /login primero.");

    const res = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`,
        {
            headers: { Authorization: `Bearer ${userAccessToken}` },
        }
    );

    const data = await res.json();
    const tracks = data.tracks?.items || [];
    if (!tracks.length) return null;

    return tracks
        .map(t => ({ t, s: scoreTrack(t, query) }))
        .sort((a, b) => b.s - a.s)[0].t;
}

// ============================
// ENDPOINTS DE LA APP
// ============================

app.get("/search", async (req, res) => {
    const q = req.query.q;
    const user = req.query.user || "Anónimo";
    const mode = req.query.mode || "queue";

    if (!q) return res.json({ ok: false });

    try {
        const track = await searchTrack(q);
        if (!track) return res.json({ ok: false });

        const item = {
            uri: track.uri,
            name: track.name,
            artist: track.artists.map(a => a.name).join(", "),
            albumCover: track.album.images[0]?.url || "",
            user
        };

        if (mode === "now") {
            queue.unshift(item);
        } else {
            queue.push(item);
        }

        saveData();
        res.json({ ok: true, item });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/next", (req, res) => {
    if (!queue.length) return res.json({});

    const next = queue.shift();
    nowPlaying = next;
    history.unshift(next);

    if (history.length > 20) history.pop();
    saveData();

    res.json(next);
});

app.get("/state", (req, res) => {
    res.json({
        nowPlaying,
        queue,
        history
    });
});

// ============================
// INICIO DEL SERVIDOR
// ============================

loadData();

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🔥 Remotify listo en puerto ${PORT}`);
});
