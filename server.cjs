const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const app = express();

// --- CONFIGURATION ---
const port = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Arn903_346"; 
const MONGO_URI = process.env.MONGO_URI; 

// Script Files
const FILE_HEADLESS = 'headless.lua'; 
const FILE_NORMAL   = 'read.lua';
const FILE_SAFE     = 'safe.lua';

// --- MONGODB CONNECTION ---
if (!MONGO_URI) {
    console.error("❌ CRITICAL ERROR: MONGO_URI is missing from Environment Variables!");
    console.error("   Please add it in Render Dashboard -> Environment Variables.");
} else {
    mongoose.connect(MONGO_URI)
        .then(() => console.log("✅ Connected to MongoDB Atlas"))
        .catch(err => console.error("❌ MongoDB Connection Error:", err));
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

    const MSG_DENIED  = `<h1>⛔ ACCESS DENIED</h1><p>Invalid Key or missing parameters.</p>`;
    const MSG_LOCKED  = `<h1>🔒 HWID LOCKED</h1><p>This key is linked to another device.</p>`;
    const MSG_EXPIRED = `<h1>⌛ KEY EXPIRED</h1><p>This key is no longer valid.</p>`;

    if (!key || !hwid) { res.status(403).send(MSG_DENIED); return false; }

    try {
        const kData = await Key.findOne({ key: key });

        if (!kData) { res.status(403).send(MSG_DENIED); return false; }

        if (Date.now() > kData.expires) { 
            res.status(403).send(MSG_EXPIRED); 
            return false; 
        }

        // Logic: If no HWID, set it. If HWID exists, check match.
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

// Lua Script Routes (Now Async)
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

// --- DASHBOARD (EMBEDDED HTML) ---
// Note: Dashboard HTML logic updated to show errors
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

// --- SERVER START ---
app.listen(port, () => {
    console.log("Server Online!");
    console.log("Listening on port: " + port);
});
