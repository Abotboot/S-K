const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const app = express();

// --- CONFIGURATION ---
const port = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Arn903_346";
const MONGO_URI = process.env.MONGO_URI;

// Linkvertise Configuration
const LINKVERTISE_KEY_HOURS = 24; // How long keys from Linkvertise last (hours)

// Script Files
const FILE_HEADLESS = 'headless';
const FILE_NORMAL = 'read';
const FILE_SAFE = 'safe';
const FILE_CHAINSAW = 'chainsaw';
const FILE_SOLO = 'Solo';

// --- MONGODB CONNECTION ---
if (!MONGO_URI) {
    console.error("❌ CRITICAL ERROR: MONGO_URI is missing from Environment Variables!");
    console.error("   Please add it in Render Dashboard -> Environment Variables.");
} else {
    mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 5000
    })
        .then(() => console.log("✅ Connected to MongoDB Atlas"))
        .catch(err => {
            console.error("❌ MongoDB Connection Error:", err);
            console.error("💡 HINT: Did you add 0.0.0.0/0 to MongoDB Network Access?");
        });

    mongoose.connection.on('error', err => console.error("❌ DB Runtime Error:", err));
}

// --- DATABASE SCHEMA ---
const keySchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    note: { type: String, default: "No Label" },
    hwid: { type: String, default: null },
    created_at: { type: Number, default: Date.now },
    expires: { type: Number, required: true }
});

const Key = mongoose.model('Key', keySchema);

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- AUTH MIDDLEWARE ---
const requireAuth = (req, res, next) => {
    const pass = req.headers['authorization'] || req.query.pass;
    if (pass !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: "Invalid Admin Password" });
    }
    next();
};

// --- API ROUTES (ADMIN) ---

// 1. Get All Keys
app.get('/api/keys', requireAuth, async (req, res) => {
    if (mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: "Database not connected. Check Render Logs for 'MongoDB Connection Error'." });
    }
    try {
        const keys = await Key.find({}).sort({ created_at: -1 });
        res.json(keys);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. Create Key
app.post('/api/create', requireAuth, async (req, res) => {
    try {
        const { days, note } = req.body;
        const durationDays = parseInt(days) || 30;

        const newKey = await Key.create({
            key: "KEY_" + Math.random().toString(36).substr(2, 8).toUpperCase(),
            note: note || "No Label",
            expires: Date.now() + (durationDays * 24 * 60 * 60 * 1000)
        });

        res.json({ success: true, key: newKey });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Reset HWID
app.post('/api/reset', requireAuth, async (req, res) => {
    try {
        const { key } = req.body;
        const updated = await Key.findOneAndUpdate({ key: key }, { hwid: null }, { new: true });
        if (updated) res.json({ success: true });
        else res.status(404).json({ error: "Key not found" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Delete Key
app.post('/api/delete', requireAuth, async (req, res) => {
    try {
        const { key } = req.body;
        await Key.findOneAndDelete({ key: key });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- SCRIPT DELIVERY LOGIC ---

async function validateKey(req, res) {
    const { key, hwid } = req.query;

    const MSG_DENIED = `<h1>⛔ ACCESS DENIED</h1><p>Invalid Key or missing parameters.</p>`;
    const MSG_LOCKED = `<h1>🔒 HWID LOCKED</h1><p>This key is linked to another device.</p>`;
    const MSG_EXPIRED = `<h1>⌛ KEY EXPIRED</h1><p>This key is no longer valid.</p>`;

    if (!key || !hwid) { res.status(403).send(MSG_DENIED); return false; }

    try {
        const kData = await Key.findOne({ key: key });

        if (!kData) { res.status(403).send(MSG_DENIED); return false; }

        if (Date.now() > kData.expires) {
            res.status(403).send(MSG_EXPIRED);
            return false;
        }

        if (!kData.hwid) {
            kData.hwid = hwid;
            await kData.save();
        } else if (kData.hwid !== hwid) {
            res.status(403).send(MSG_LOCKED);
            return false;
        }

        return true;
    } catch (e) {
        console.error(e);
        res.status(500).send("Database Error");
        return false;
    }
}

// --- LUA SCRIPT ROUTES ---

app.get('/headless', async (req, res) => {
    if (!await validateKey(req, res)) return;
    if (!fs.existsSync(FILE_HEADLESS)) return res.send("print('Error: Server missing headless.lua')");
    try {
        let lua = fs.readFileSync(FILE_HEADLESS, 'utf8');
        const debugInfo = `\nprint("[SERVER] Authenticated: ${req.query.key.substr(0, 8)}...")\n`;
        res.send(debugInfo + lua);
    } catch (e) { res.send("print('Error reading file')"); }
});

app.get('/script', async (req, res) => {
    if (!await validateKey(req, res)) return;
    if (fs.existsSync(FILE_NORMAL)) res.send(fs.readFileSync(FILE_NORMAL, 'utf8'));
    else res.send("print('Error: read.lua missing')");
});

app.get('/safe', async (req, res) => {
    if (!await validateKey(req, res)) return;
    if (fs.existsSync(FILE_SAFE)) res.send(fs.readFileSync(FILE_SAFE, 'utf8'));
    else res.send("print('Error: safe.lua missing')");
});

app.get('/chainsaw', async (req, res) => {
    if (!await validateKey(req, res)) return;
    if (fs.existsSync(FILE_CHAINSAW)) {
        try {
            let lua = fs.readFileSync(FILE_CHAINSAW, 'utf8');
            res.send(lua);
        } catch (e) { res.send("print('Error reading chainsaw.lua')"); }
    } else {
        res.send("print('Error: chainsaw.lua missing on server')");
    }
});

app.get('/solo', async (req, res) => {
    if (!await validateKey(req, res)) return;
    if (fs.existsSync(FILE_SOLO)) {
        try {
            let lua = fs.readFileSync(FILE_SOLO, 'utf8');
            res.send(lua);
        } catch (e) { res.send("print('Error reading Solo')"); }
    } else {
        res.send("print('Error: Solo missing on server')");
    }
});

// --- DASHBOARD (EMBEDDED HTML) ---
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hub Admin Panel</title>
    <style>
        :root { --bg: #0f172a; --card: #1e293b; --text: #e2e8f0; --accent: #3b82f6; --danger: #ef4444; }
        body { background-color: var(--bg); color: var(--text); font-family: sans-serif; margin: 0; padding: 20px; }
        .login-container { display: flex; height: 100vh; justify-content: center; align-items: center; }
        .dashboard { display: none; max-width: 1000px; margin: 0 auto; }
        input, button { padding: 10px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: white; margin: 5px; }
        button { cursor: pointer; background: var(--card); }
        button:hover { background: #334155; }
        button.primary { background: var(--accent); border: none; }
        button.danger { background: var(--danger); border: none; }
        .controls { background: var(--card); padding: 15px; border-radius: 8px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #334155; }
        th { background: #0f172a; color: #94a3b8; }
        .badge { padding: 3px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: bold; }
        .badge.active { background: #064e3b; color: #34d399; }
        .badge.expired { background: #450a0a; color: #fca5a5; }
    </style>
</head>
<body>
    <div id="loginScreen" class="login-container">
        <div style="text-align:center;">
            <h2>🔐 Admin Access</h2>
            <input type="password" id="passwordInput" placeholder="Password">
            <button class="primary" onclick="login()">Enter</button>
        </div>
    </div>
    <div id="dashboard" class="dashboard">
        <div style="display:flex;justify-content:space-between;align-items:center;">
            <h2>⚡ Key Manager (MongoDB)</h2>
            <button onclick="logout()">Logout</button>
        </div>
        <div class="controls">
            <input type="text" id="noteInput" placeholder="Note (e.g. Buyer Name)">
            <input type="number" id="daysInput" placeholder="Days" value="30" style="width:60px;">
            <button class="primary" onclick="createKey()">+ Create Key</button>
        </div>
        <table>
            <thead><tr><th>Key</th><th>Note</th><th>Status</th><th>HWID</th><th>Expires</th><th>Actions</th></tr></thead>
            <tbody id="keyTableBody"></tbody>
        </table>
    </div>
    <script>
        let authToken = localStorage.getItem('adminPass') || '';
        function login() { authToken = document.getElementById('passwordInput').value; fetchKeys(); }
        function logout() { localStorage.removeItem('adminPass'); location.reload(); }
        async function api(endpoint, method='GET', body=null) {
            const headers = { 'Content-Type': 'application/json', 'Authorization': authToken };
            const opts = { method, headers };
            if (body) opts.body = JSON.stringify(body);
            try {
                const res = await fetch('/api'+endpoint, opts);
                if (res.status === 403) { 
                    alert("Invalid Password"); 
                    document.getElementById('loginScreen').style.display='flex'; 
                    document.getElementById('dashboard').style.display='none'; 
                    return null; 
                }
                const data = await res.json();
                if (data.error) {
                    alert("Server Error: " + data.error);
                    return null;
                }
                return data;
            } catch(e) {
                alert("Connection Failed: " + e.message);
                return null;
            }
        }
        async function fetchKeys() {
            const data = await api('/keys');
            if (data) {
                localStorage.setItem('adminPass', authToken);
                document.getElementById('loginScreen').style.display='none';
                document.getElementById('dashboard').style.display='block';
                renderTable(data);
            }
        }
        async function createKey() {
            const res = await api('/create', 'POST', { days: document.getElementById('daysInput').value, note: document.getElementById('noteInput').value });
            if (res && res.success) { fetchKeys(); }
        }
        async function resetHWID(key) { if(confirm('Reset HWID?')) { await api('/reset', 'POST', { key }); fetchKeys(); } }
        async function deleteKey(key) { if(confirm('Delete Key?')) { await api('/delete', 'POST', { key }); fetchKeys(); } }
        function renderTable(keys) {
            document.getElementById('keyTableBody').innerHTML = keys.map(k => {
                const isExp = Date.now() > k.expires;
                const daysLeft = Math.max(0, Math.ceil((k.expires - Date.now()) / 86400000));
                return \`<tr>
                    <td style="font-family:monospace;cursor:pointer;color:#3b82f6" onclick="copy('\${k.key}')">\${k.key}</td>
                    <td>\${k.note}</td>
                    <td>\${isExp ? '<span class="badge expired">EXPIRED</span>' : '<span class="badge active">ACTIVE</span>'}</td>
                    <td style="font-size:0.8em">\${k.hwid ? '🔒 Linked' : '🔓 Open'}</td>
                    <td>\${daysLeft} Days</td>
                    <td><button onclick="copy('\${k.key}')">Copy</button> <button onclick="resetHWID('\${k.key}')">Reset</button> <button class="danger" onclick="deleteKey('\${k.key}')">Del</button></td>
                </tr>\`;
            }).join('');
        }
        function copy(t) { navigator.clipboard.writeText(t); alert("Copied!"); }
        if(authToken) fetchKeys();
    </script>
</body>
</html>
`;

app.get('/admin', (req, res) => res.send(DASHBOARD_HTML));

// --- LINKVERTISE KEY GENERATION ---

// Page shown after completing Linkvertise
const GETKEY_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Get Your Key</title>
    <style>
        :root { --bg: #0f172a; --card: #1e293b; --text: #e2e8f0; --accent: #3b82f6; --success: #10b981; }
        body { background: var(--bg); color: var(--text); font-family: sans-serif; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { background: var(--card); padding: 40px; border-radius: 16px; text-align: center; max-width: 500px; }
        h1 { color: var(--success); margin-bottom: 20px; }
        .key-box { background: #0f172a; padding: 20px; border-radius: 8px; margin: 20px 0; font-family: monospace; font-size: 1.5rem; color: var(--accent); cursor: pointer; border: 2px dashed var(--accent); }
        .key-box:hover { background: #1a2744; }
        .info { color: #94a3b8; font-size: 0.9rem; margin-top: 15px; }
        .copy-btn { background: var(--accent); color: white; border: none; padding: 12px 30px; border-radius: 8px; font-size: 1rem; cursor: pointer; margin-top: 15px; }
        .copy-btn:hover { background: #2563eb; }
        .expires { color: #f59e0b; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>✅ Key Generated!</h1>
        <p>Your temporary access key:</p>
        <div class="key-box" onclick="copyKey()" id="keyDisplay">GENERATING...</div>
        <button class="copy-btn" onclick="copyKey()">📋 Copy Key</button>
        <p class="expires" id="expiresInfo"></p>
        <p class="info">This key is linked to your device (HWID).<br>Use it in your script's getgenv().Key</p>
    </div>
    <script>
        const urlParams = new URLSearchParams(window.location.search);
        const key = urlParams.get('key');
        const hours = urlParams.get('hours') || 24;
        
        if (key) {
            document.getElementById('keyDisplay').textContent = key;
            document.getElementById('expiresInfo').textContent = '⏰ Expires in ' + hours + ' hours';
        } else {
            document.getElementById('keyDisplay').textContent = 'ERROR: No key generated';
        }
        
        function copyKey() {
            navigator.clipboard.writeText(document.getElementById('keyDisplay').textContent);
            document.querySelector('.copy-btn').textContent = '✓ Copied!';
            setTimeout(() => document.querySelector('.copy-btn').textContent = '📋 Copy Key', 2000);
        }
    </script>
</body>
</html>
`;

// Generate key endpoint - called after Linkvertise completion
app.get('/getkey', async (req, res) => {
    try {
        // Generate a temporary key
        const newKey = await Key.create({
            key: "KEY_" + Math.random().toString(36).substr(2, 8).toUpperCase(),
            note: "Linkvertise - " + new Date().toISOString().split('T')[0],
            expires: Date.now() + (LINKVERTISE_KEY_HOURS * 60 * 60 * 1000)
        });

        // Redirect to key display page
        res.redirect('/showkey?key=' + newKey.key + '&hours=' + LINKVERTISE_KEY_HOURS);
    } catch (e) {
        console.error("Key generation error:", e);
        res.status(500).send("Error generating key. Please try again.");
    }
});

// Show key page
app.get('/showkey', (req, res) => {
    res.send(GETKEY_HTML);
});

// --- SERVER START ---
app.listen(port, () => {
    console.log("Server Online!");
    console.log("Listening on port: " + port);
});