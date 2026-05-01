const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// 🔑 TUS DATOS
const CLIENT_ID = "d67ff6f68928459f81948f0de2b4c68b";
const CLIENT_SECRET = "dca742b376684b799e804f119f053a72";

let token = null;

// 🔥 SISTEMA DJ
let queue = [];
let history = [];
let nowPlaying = null;

// 📁 archivo de memoria
const DATA_FILE = path.join(__dirname, "data.json");

// ============================
// 💾 CARGAR DATOS
// ============================

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE);
            const data = JSON.parse(raw);

            queue = data.queue || [];
            history = data.history || [];
            nowPlaying = data.nowPlaying || null;

            console.log("💾 Datos cargados");
        }
    } catch {
        console.log("❌ Error cargando datos");
    }
}

// ============================
// 💾 GUARDAR DATOS
// ============================

function saveData() {
    try {
        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify({ queue, history, nowPlaying }, null, 2)
        );
    } catch {
        console.log("❌ Error guardando datos");
    }
}

// ============================
// TOKEN
// ============================

async function getToken() {
    const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            "Authorization":
                "Basic " +
                Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
    });

    const data = await res.json();

    if (!data.access_token) throw new Error("No token");

    token = data.access_token;
}

// ============================
// SCORE
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

// ============================
// SEARCH
// ============================

async function searchTrack(query) {
    if (!token) await getToken();

    const res = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`,
        {
            headers: { Authorization: `Bearer ${token}` },
        }
    );

    const data = await res.json();

    if (data.error) {
        if (data.error.status === 401) {
            token = null;
            return searchTrack(query);
        }
        throw new Error("Spotify API error");
    }

    const tracks = data.tracks?.items || [];
    if (!tracks.length) return null;

    return tracks
        .map(t => ({ t, s: scoreTrack(t, query) }))
        .sort((a, b) => b.s - a.s)[0].t;
}

// ============================
// AGREGAR
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
            user
        };

        if (mode === "now") {
            queue.unshift(item);
        } else {
            queue.push(item);
        }

        saveData();

        res.json({ ok: true, item });

    } catch {
        res.status(500).json({ error: "fail" });
    }
});

// ============================
// SIGUIENTE
// ============================

app.get("/next", (req, res) => {
    if (!queue.length) return res.json({});

    const next = queue.shift();

    nowPlaying = next;
    history.unshift(next);

    if (history.length > 20) history.pop();

    saveData();

    res.json(next);
});

// ============================
// 🔥 NUEVO: UPDATE REAL
// ============================

app.post("/update-playing", (req, res) => {
    const { name } = req.body;

    if (name) {
        nowPlaying = {
            name,
            user: "Spotify"
        };
        saveData();
    }

    res.json({ ok: true });
});

// ============================
// ESTADO
// ============================

app.get("/state", (req, res) => {
    res.json({
        nowPlaying,
        queue,
        history
    });
});

// ============================
// START
// ============================

loadData();

app.listen(3000, "0.0.0.0", () => {
    console.log("🔥 DJ Server con memoria + realtime");
});