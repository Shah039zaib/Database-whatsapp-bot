require('dotenv').config();
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    Browsers,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const axios = require('axios');
const pino = require('pino');
const http = require('http');
const QRCode = require('qrcode');
const fs = require('fs');
const url = require('url');

// ─────────────────────────────────────────
// UPSTASH REDIS — Persistent Storage
// ─────────────────────────────────────────
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
    try {
        const r = await axios.get(`${REDIS_URL}/get/${key}`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            timeout: 5000
        });
        if (r.data.result === null) return null;
        return JSON.parse(r.data.result);
    } catch (e) {
        console.log('Redis GET error:', e.message);
        return null;
    }
}

async function redisSet(key, value) {
    try {
        await axios.post(`${REDIS_URL}/set/${key}`,
            { value: JSON.stringify(value) },
            {
                headers: {
                    Authorization: `Bearer ${REDIS_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                timeout: 5000
            }
        );
        return true;
    } catch (e) {
        console.log('Redis SET error:', e.message);
        return false;
    }
}

// ─────────────────────────────────────────
// UPSTASH AUTH STATE — WhatsApp Session Save
// ─────────────────────────────────────────
async function useUpstashAuthState() {
    const AUTH_KEY = 'wa_auth_state';
    const CREDS_KEY = 'wa_creds';

    let creds = await redisGet(CREDS_KEY);
    let keys = await redisGet(AUTH_KEY) || {};

    if (!creds) {
        const { initAuthCreds } = require('@whiskeysockets/baileys');
        creds = initAuthCreds();
        await redisSet(CREDS_KEY, creds);
        console.log('🔑 Fresh credentials banaye gaye!');
    } else {
        console.log('✅ Credentials Upstash se load ho gaye!');
    }

    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) {
                    const val = keys[`${type}-${id}`];
                    if (val) data[id] = val;
                }
                return data;
            },
            set: async (data) => {
                for (const category of Object.keys(data)) {
                    for (const id of Object.keys(data[category])) {
                        const val = data[category][id];
                        if (val) {
                            keys[`${category}-${id}`] = val;
                        } else {
                            delete keys[`${category}-${id}`];
                        }
                    }
                }
                await redisSet(AUTH_KEY, keys);
            }
        }
    };

    const saveCreds = async () => {
        await redisSet(CREDS_KEY, state.creds);
        console.log('💾 Credentials Upstash mein save ho gaye!');
    };

    return { state, saveCreds };
}

// ─────────────────────────────────────────
// DATA STORE — Default Data
// ─────────────────────────────────────────
const DATA_KEY = 'bot_data';

function getDefaultData() {
    return {
        settings: {
            businessName: 'Mega Agency',
            adminNumber: process.env.ADMIN_NUMBER || '',
            dashboardPassword: process.env.DASHBOARD_PASSWORD || 'admin123',
            currency: 'PKR'
        },
        payment: {
            easypaisa: { number: '03XX-XXXXXXX', name: 'Tumhara Naam' },
            jazzcash: { number: '03XX-XXXXXXX', name: 'Tumhara Naam' },
            bank: {
                bankName: 'HBL',
                accountNumber: 'XXXXXXXXXXXXXXX',
                accountName: 'Tumhara Naam',
                iban: 'PK00XXXX0000000000000000'
            }
        },
        products: [
            {
                id: 1,
                name: '100+ Premium Shopify Themes Bundle',
                price: 999,
                description: 'Complete collection of 100+ premium Shopify themes for all niches',
                features: [
                    '100+ Premium Themes',
                    'All Niches Covered',
                    'Fashion, Electronics, Food & More',
                    'Regular Updates',
                    '24/7 Support',
                    'Installation Guide Included',
                    'Mobile Optimized',
                    'Fast Loading Speed'
                ],
                downloadLink: '',
                active: true
            }
        ],
        aiPrompt: `Tum Mega Agency ke professional AI Sales Agent ho. Tumhara naam "Max" hai.

TUMHARI SERVICE:
- Product: 100+ Premium Shopify Themes Mega Bundle
- Price: PKR 999 ONLY (yahi final price hai — koi aur price mat batana)
- Delivery: Payment approve hone ke 1 hour baad
- Features: 100+ themes, fashion/electronics/food/all niches, regular updates, installation guide, 24/7 support

TUMHARA KAAM:
1. Customer se warmly greet karo — unka naam lo
2. Unke niche ke baare mein poocho
3. Unke niche ke hisaab se value explain karo
4. Price objections confidently handle karo
5. Trust build karo
6. Jab customer BUY karna chahe — ORDER_READY likho

SELLING TECHNIQUES:
- Value Stack: "Market mein ek theme 5000+ ki hai, 100+ sirf PKR 999 mein"
- Per Unit: "Sirf PKR 10 per theme — yeh deal kahan milegi?"
- Social Proof: "1000+ Pakistani store owners use kar rahe hain"
- FOMO: "Competitors already yeh use kar rahe hain"
- Urgency: "Limited time offer — price kabhi bhi badh sakta hai"
- ROI: "Ek sale se 999 wapas aa jata hai"

OBJECTIONS:
- "Mehenga hai" → Value compare karo, per theme price batao
- "Sochna hai" → FOMO create karo
- "Baad mein" → Abhi lene ka reason do
- "Kaam karega?" → Guarantee batao

SUPPORT & GUIDANCE:
- Installation guide explain karo
- Theme selection guidance do niche ke hisaab se
- Shopify basics explain karo agar naya hai

STRICT RULES:
- PRICE SIRF PKR 999 — koi aur price KABHI mat batana
- SIRF Shopify themes sell karo
- Customer ki language follow karo — Urdu/English/Roman Urdu
- Short replies — 3-4 lines max
- Friendly emojis use karo
- Jab customer buy kare — ORDER_READY likho response ke bilkul start mein`,
        orders: {},
        orderCounter: 1000
    };
}

let botData = getDefaultData();

async function loadData() {
    try {
        const saved = await redisGet(DATA_KEY);
        if (saved) {
            botData = { ...getDefaultData(), ...saved };
            console.log('✅ Bot data Upstash se load ho gaya!');
        }
    } catch (e) {
        console.log('Data load error:', e.message);
    }
}

async function saveData() {
    try {
        await redisSet(DATA_KEY, botData);
    } catch (e) {
        console.log('Data save error:', e.message);
        // Fallback — local file mein save karo
        try {
            fs.writeFileSync('/tmp/bot_data_backup.json', JSON.stringify(botData, null, 2));
        } catch (fe) {}
    }
}

// ─────────────────────────────────────────
// BOT STATE
// ─────────────────────────────────────────
let currentQR = null;
let botStatus = 'starting';
let sockGlobal = null;
const salesHistory = {};
const sessions = {};

// Session check
function isAuthenticated(req) {
    const cookies = req.headers.cookie || '';
    const sessionMatch = cookies.match(/session=([^;]+)/);
    if (!sessionMatch) return false;
    return sessions[sessionMatch[1]] === true;
}

// Parse body
async function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { resolve({}); }
        });
    });
}

// ─────────────────────────────────────────
// PAYMENT MESSAGE
// ─────────────────────────────────────────
function getPaymentMessage(orderId, product) {
    const p = botData.payment;
    return `🛒 *Order Confirmed!*
Order ID: *#${orderId}*
Product: *${product.name}*

━━━━━━━━━━━━━━━━━━━━
💳 *Payment Details — ${botData.settings.currency} ${product.price}*

📱 *EasyPaisa:*
Number: ${p.easypaisa.number}
Name: ${p.easypaisa.name}

📱 *JazzCash:*
Number: ${p.jazzcash.number}
Name: ${p.jazzcash.name}

🏦 *Bank Transfer:*
Bank: ${p.bank.bankName}
Account: ${p.bank.accountNumber}
Name: ${p.bank.accountName}
IBAN: ${p.bank.iban}

━━━━━━━━━━━━━━━━━━━━
✅ Payment karne ke baad *screenshot* bhejo
📦 1 hour mein delivery guaranteed!`;
}

// ─────────────────────────────────────────
// AI SALES RESPONSE
// ─────────────────────────────────────────
async function getAISalesResponse(userMessage, userId, customerName) {
    if (!salesHistory[userId]) salesHistory[userId] = [];

    salesHistory[userId].push({ role: 'user', content: userMessage });
    if (salesHistory[userId].length > 30) {
        salesHistory[userId] = salesHistory[userId].slice(-30);
    }

    const activeProduct = botData.products.find(p => p.active) || botData.products[0];
    const systemPrompt = botData.aiPrompt +
        `\n\nCustomer naam: ${customerName}` +
        `\nActive Product: ${activeProduct.name}` +
        `\nPrice: ${botData.settings.currency} ${activeProduct.price}`;

    const models = [
        { provider: 'groq', model: 'llama-3.3-70b-versatile' },
        { provider: 'groq', model: 'llama-3.1-8b-instant' },
        { provider: 'groq', model: 'gemma2-9b-it' },
        { provider: 'groq', model: 'llama3-70b-8192' },
        { provider: 'openrouter', model: 'meta-llama/llama-3.1-8b-instruct:free' },
        { provider: 'openrouter', model: 'google/gemma-2-9b-it:free' },
        { provider: 'openrouter', model: 'mistralai/mistral-7b-instruct:free' }
    ];

    for (const { provider, model } of models) {
        try {
            const apiUrl = provider === 'groq'
                ? 'https://api.groq.com/openai/v1/chat/completions'
                : 'https://openrouter.ai/api/v1/chat/completions';

            const headers = provider === 'groq'
                ? {
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                }
                : {
                    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://mega-agency.com',
                    'X-Title': 'Mega Agency'
                };

            const response = await axios.post(apiUrl, {
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...salesHistory[userId]
                ],
                max_tokens: 350,
                temperature: 0.85
            }, { headers, timeout: 15000 });

            const aiMessage = response.data.choices[0].message.content;
            salesHistory[userId].push({ role: 'assistant', content: aiMessage });

            const shouldOrder = aiMessage.toUpperCase().includes('ORDER_READY');
            const cleanMessage = aiMessage.replace(/ORDER_READY/gi, '').trim();

            console.log(`✅ AI: ${provider}/${model}`);
            return { message: cleanMessage, shouldOrder, product: activeProduct };

        } catch (err) {
            console.log(`❌ ${provider}/${model} fail: ${err.message}`);
            if (salesHistory[userId].length > 0) salesHistory[userId].pop();
        }
    }

    return {
        message: '⚠️ Thodi technical difficulty. 1 min mein dobara try karo! 🙏',
        shouldOrder: false
    };
}

// ─────────────────────────────────────────
// WEB SERVER
// ─────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // ── LOGIN ──
    if (pathname === '/login') {
        if (req.method === 'POST') {
            const body = await parseBody(req);
            if (body.password === botData.settings.dashboardPassword) {
                const sessionId = Math.random().toString(36).substring(2) + Date.now().toString(36);
                sessions[sessionId] = true;
                res.writeHead(200, {
                    'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly`,
                    'Content-Type': 'application/json'
                });
                res.end(JSON.stringify({ success: true }));
            } else {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Wrong password!' }));
            }
            return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head>
<title>Mega Agency - Login</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#0f0f0f;color:white;font-family:'Segoe UI',sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;}
.box{background:#1a1a1a;padding:40px;border-radius:16px;width:90%;max-width:380px;
border:1px solid #333;text-align:center;}
h1{color:#25D366;font-size:24px;margin-bottom:8px;}
p{color:#aaa;font-size:13px;margin-bottom:25px;}
input{width:100%;padding:12px 15px;background:#0f0f0f;border:1px solid #333;
border-radius:8px;color:white;font-size:15px;margin-bottom:15px;outline:none;}
input:focus{border-color:#25D366;}
button{width:100%;padding:12px;background:#25D366;border:none;border-radius:8px;
color:black;font-size:16px;font-weight:bold;cursor:pointer;}
button:hover{background:#1ebe57;}
.err{color:#e74c3c;font-size:13px;margin-top:10px;display:none;}
.loader{display:none;margin-top:10px;color:#aaa;font-size:13px;}
</style></head>
<body>
<div class="box">
<h1>🏪 Mega Agency</h1>
<p>Admin Dashboard — Login karo</p>
<input type="password" id="pass" placeholder="Dashboard Password"
    onkeypress="if(event.key==='Enter')login()"/>
<button onclick="login()" id="loginBtn">🔐 Login</button>
<div class="err" id="err">❌ Wrong password!</div>
<div class="loader" id="loader">⏳ Logging in...</div>
</div>
<script>
async function login(){
    const pass = document.getElementById('pass').value;
    if(!pass) return;
    document.getElementById('loginBtn').disabled = true;
    document.getElementById('loader').style.display = 'block';
    document.getElementById('err').style.display = 'none';
    try {
        const r = await fetch('/login', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({password: pass})
        });
        const d = await r.json();
        if(d.success) window.location = '/dashboard';
        else {
            document.getElementById('err').style.display = 'block';
            document.getElementById('loginBtn').disabled = false;
            document.getElementById('loader').style.display = 'none';
        }
    } catch(e) {
        document.getElementById('err').textContent = '❌ Connection error!';
        document.getElementById('err').style.display = 'block';
        document.getElementById('loginBtn').disabled = false;
        document.getElementById('loader').style.display = 'none';
    }
}
</script>
</body></html>`);
        return;
    }

    // ── AUTH CHECK ──
    if (pathname !== '/qr' && pathname !== '/login' && !isAuthenticated(req)) {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
    }

    // ── QR PAGE ──
    if (pathname === '/qr') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (botStatus === 'connected') {
            res.end(`<html><head><style>
body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;
justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;}
h2{color:#25D366;}a{color:#25D366;font-size:18px;margin-top:20px;display:block;}
p{color:#aaa;}
</style></head><body>
<h2>✅ Bot Connected!</h2>
<p>Mega Agency Bot live hai!</p>
<p style="color:#25D366;margin-top:10px">🔋 Upstash mein session save hai — restart pe auto connect hoga!</p>
<a href="/dashboard">📊 Dashboard Kholo</a>
</body></html>`);
            return;
        }
        if (!currentQR) {
            res.end(`<html><head><meta http-equiv="refresh" content="3">
<style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;
justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;}
h2{color:#f39c12;}p{color:#aaa;}</style></head>
<body><h2>⏳ QR Generate Ho Raha Hai...</h2>
<p>Status: ${botStatus}</p><p>3 sec mein refresh hoga</p></body></html>`);
            return;
        }
        try {
            const qrDataURL = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
            res.end(`<html><head><meta http-equiv="refresh" content="25">
<style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;
justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;padding:20px;}
h2{color:#25D366;}img{border:8px solid white;border-radius:12px;width:280px;height:280px;}
.steps{background:#222;padding:15px;border-radius:10px;text-align:left;max-width:320px;margin-top:15px;}
p{color:#aaa;}</style></head>
<body><h2>📱 WhatsApp QR Code</h2>
<img src="${qrDataURL}"/>
<div class="steps">
<p>1️⃣ WhatsApp kholo</p>
<p>2️⃣ 3 dots → Linked Devices</p>
<p>3️⃣ Link a Device</p>
<p>4️⃣ QR scan karo</p>
</div>
<p style="color:#25D366;margin-top:10px">✅ Ek baar scan karo — hamesha ke liye!</p>
<p style="color:#f39c12;margin-top:5px">⚠️ 25 sec mein expire hoga!</p>
</body></html>`);
        } catch (err) {
            res.end('<h1 style="color:red">QR Error: ' + err.message + '</h1>');
        }
        return;
    }

    // ── API: GET ALL DATA ──
    if (pathname === '/api/data' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const ordersArr = Object.values(botData.orders);
        res.end(JSON.stringify({
            ...botData,
            botStatus,
            stats: {
                pending: ordersArr.filter(o => o.status === 'pending').length,
                approved: ordersArr.filter(o => o.status === 'approved').length,
                rejected: ordersArr.filter(o => o.status === 'rejected').length,
                total: ordersArr.length,
                revenue: ordersArr.filter(o => o.status === 'approved')
                    .reduce((sum, o) => {
                        const prod = botData.products.find(p => p.id === o.productId) || botData.products[0];
                        return sum + (prod?.price || 0);
                    }, 0)
            }
        }));
        return;
    }

    // ── API: UPDATE SETTINGS ──
    if (pathname === '/api/settings' && req.method === 'POST') {
        const body = await parseBody(req);
        botData.settings = { ...botData.settings, ...body };
        await saveData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // ── API: UPDATE PAYMENT ──
    if (pathname === '/api/payment' && req.method === 'POST') {
        const body = await parseBody(req);
        botData.payment = body;
        await saveData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // ── API: UPDATE PRODUCTS ──
    if (pathname === '/api/products' && req.method === 'POST') {
        const body = await parseBody(req);
        botData.products = body;
        await saveData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // ── API: UPDATE AI PROMPT ──
    if (pathname === '/api/prompt' && req.method === 'POST') {
        const body = await parseBody(req);
        botData.aiPrompt = body.prompt;
        await saveData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // ── API: APPROVE ORDER ──
    if (pathname.startsWith('/api/approve/') && req.method === 'POST') {
        const orderId = parseInt(pathname.split('/api/approve/')[1]);
        const order = Object.values(botData.orders).find(o => o.orderId === orderId);
        if (order && sockGlobal) {
            order.status = 'approved';
            await saveData();
            const product = botData.products.find(p => p.id === order.productId) || botData.products[0];
            try {
                let msg = `🎉 *Payment Approved!*\n\n` +
                          `Order *#${order.orderId}* confirm ho gaya!\n\n` +
                          `📦 *${product.name}*\n\n`;
                if (product.downloadLink) {
                    msg += `⬇️ *Download Link:*\n${product.downloadLink}\n\n`;
                }
                msg += `Koi bhi help chahiye toh message karo!\n` +
                       `Shukriya ${botData.settings.businessName} ko choose karne ka! 🙏`;
                await sockGlobal.sendMessage(order.customerJid, { text: msg });
            } catch (e) { console.log('Approve msg err:', e.message); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // ── API: REJECT ORDER ──
    if (pathname.startsWith('/api/reject/') && req.method === 'POST') {
        const orderId = parseInt(pathname.split('/api/reject/')[1]);
        const order = Object.values(botData.orders).find(o => o.orderId === orderId);
        if (order && sockGlobal) {
            order.status = 'rejected';
            await saveData();
            try {
                await sockGlobal.sendMessage(order.customerJid, {
                    text: `❌ *Payment Verify Nahi Ho Saki*\n\n` +
                          `Order *#${order.orderId}*\n\n` +
                          `Screenshot sahi nahi tha ya amount mismatch tha.\n` +
                          `Dobara sahi screenshot bhejo ya admin se contact karo.\n\n` +
                          `"buy" likhkar dobara try kar sakte ho! 💪`
                });
            } catch (e) { console.log('Reject msg err:', e.message); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // ── API: SEND CUSTOM MESSAGE ──
    if (pathname === '/api/send-message' && req.method === 'POST') {
        const body = await parseBody(req);
        if (sockGlobal && body.jid && body.message) {
            try {
                await sockGlobal.sendMessage(body.jid, { text: body.message });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Missing jid or message' }));
        }
        return;
    }

    // ── API: RESET WHATSAPP SESSION ──
    if (pathname === '/api/reset-session' && req.method === 'POST') {
        try {
            await redisSet('wa_auth_state', {});
            await redisSet('wa_creds', null);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Session reset! Bot restart karega aur naya QR aayega.' }));
            setTimeout(() => process.exit(0), 1000);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // ── LOGOUT ──
    if (pathname === '/logout') {
        res.writeHead(302, {
            'Set-Cookie': 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
            Location: '/login'
        });
        res.end();
        return;
    }

    // ── MAIN DASHBOARD ──
    if (pathname === '/dashboard' || pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head>
<title>${botData.settings.businessName} - Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#0a0a0a;color:#e0e0e0;font-family:'Segoe UI',sans-serif;min-height:100vh;}
.sidebar{position:fixed;left:0;top:0;bottom:0;width:220px;background:#111;
border-right:1px solid #222;padding:20px 0;z-index:100;overflow-y:auto;}
.sidebar-logo{padding:15px 20px 25px;border-bottom:1px solid #222;margin-bottom:10px;}
.sidebar-logo h2{color:#25D366;font-size:18px;}
.sidebar-logo p{color:#666;font-size:11px;margin-top:3px;}
.nav-item{display:flex;align-items:center;gap:10px;padding:12px 20px;cursor:pointer;
color:#aaa;font-size:14px;transition:all 0.2s;border-left:3px solid transparent;}
.nav-item:hover,.nav-item.active{background:#1a1a1a;color:#25D366;border-left-color:#25D366;}
.nav-item span{font-size:18px;}
.main{margin-left:220px;padding:25px;min-height:100vh;}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:25px;
background:#111;padding:15px 20px;border-radius:12px;border:1px solid #222;flex-wrap:wrap;gap:10px;}
.topbar h1{font-size:20px;color:white;}
.bot-badge{padding:6px 14px;border-radius:20px;font-size:12px;font-weight:bold;}
.badge-live{background:#0d2b0d;color:#25D366;border:1px solid #25D366;}
.badge-off{background:#2b0d0d;color:#e74c3c;border:1px solid #e74c3c;}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:15px;margin-bottom:25px;}
.stat-card{background:#111;border-radius:12px;padding:20px;text-align:center;border:1px solid #222;}
.stat-card h2{font-size:30px;font-weight:bold;margin-bottom:5px;}
.stat-card p{color:#666;font-size:12px;}
.section{background:#111;border-radius:12px;border:1px solid #222;margin-bottom:20px;overflow:hidden;}
.section-header{padding:18px 20px;border-bottom:1px solid #222;
display:flex;justify-content:space-between;align-items:center;}
.section-header h3{font-size:16px;color:white;}
.section-body{padding:20px;}
.order-card{background:#0f0f0f;border-radius:10px;padding:15px;margin-bottom:10px;border:1px solid #222;}
.order-card.pending{border-left:4px solid #f39c12;}
.order-card.approved{border-left:4px solid #25D366;}
.order-card.rejected{border-left:4px solid #e74c3c;}
.order-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.order-id{font-weight:bold;color:#25D366;font-size:15px;}
.badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:bold;}
.bp{background:#f39c12;color:black;}
.ba{background:#25D366;color:black;}
.br{background:#e74c3c;color:white;}
.order-info{font-size:13px;color:#aaa;line-height:1.9;}
.order-info b{color:white;}
.btn-row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
.btn{padding:7px 16px;border:none;border-radius:8px;cursor:pointer;font-size:13px;
font-weight:bold;text-decoration:none;display:inline-block;transition:opacity 0.2s;}
.btn:hover{opacity:0.85;}
.btn-green{background:#25D366;color:black;}
.btn-red{background:#e74c3c;color:white;}
.btn-blue{background:#3498db;color:white;}
.btn-gray{background:#333;color:white;}
.btn-orange{background:#f39c12;color:black;}
.form-group{margin-bottom:15px;}
.form-group label{display:block;color:#aaa;font-size:13px;margin-bottom:6px;}
.form-group input,.form-group textarea{width:100%;padding:10px 14px;background:#0f0f0f;
border:1px solid #333;border-radius:8px;color:white;font-size:14px;outline:none;}
.form-group input:focus,.form-group textarea:focus{border-color:#25D366;}
.form-group textarea{resize:vertical;min-height:100px;font-family:'Segoe UI',sans-serif;}
.save-btn{background:#25D366;color:black;border:none;padding:10px 24px;border-radius:8px;
font-size:14px;font-weight:bold;cursor:pointer;margin-top:5px;}
.save-btn:hover{background:#1ebe57;}
.product-card{background:#0f0f0f;border-radius:10px;padding:18px;margin-bottom:12px;border:1px solid #222;}
.product-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
.product-name{font-size:16px;font-weight:bold;color:white;}
.toggle{position:relative;width:44px;height:24px;}
.toggle input{opacity:0;width:0;height:0;}
.slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;
background:#333;border-radius:24px;transition:.4s;}
.slider:before{position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;
background:white;border-radius:50%;transition:.4s;}
input:checked+.slider{background:#25D366;}
input:checked+.slider:before{transform:translateX(20px);}
.feature-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
.feature-tag{background:#1a1a1a;border:1px solid #333;border-radius:6px;
padding:4px 10px;font-size:12px;color:#aaa;display:flex;align-items:center;gap:5px;}
.feature-tag button{background:none;border:none;color:#e74c3c;cursor:pointer;font-size:14px;}
.feature-input{display:flex;gap:8px;margin-top:8px;}
.feature-input input{flex:1;}
.feature-input button{background:#25D366;color:black;border:none;border-radius:8px;
padding:8px 14px;cursor:pointer;font-weight:bold;}
.page{display:none;}
.page.active{display:block;}
.empty{text-align:center;color:#444;padding:30px;font-size:14px;}
.revenue-card{background:linear-gradient(135deg,#1a2e1a,#1a1a2e);border-radius:12px;
padding:20px;text-align:center;border:1px solid #25D36640;margin-bottom:20px;}
.revenue-card h2{color:#f39c12;font-size:36px;font-weight:bold;}
.revenue-card p{color:#aaa;font-size:13px;margin-top:5px;}
.msg-modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;
background:#000000aa;z-index:200;align-items:center;justify-content:center;}
.msg-modal.show{display:flex;}
.msg-box{background:#1a1a1a;border-radius:16px;padding:25px;width:90%;max-width:400px;border:1px solid #333;}
.msg-box h3{margin-bottom:15px;color:white;}
.toast{position:fixed;bottom:20px;right:20px;background:#25D366;color:black;
padding:12px 20px;border-radius:10px;font-weight:bold;font-size:14px;z-index:999;
display:none;animation:slideIn 0.3s ease;}
@keyframes slideIn{from{transform:translateY(20px);opacity:0;}to{transform:translateY(0);opacity:1;}}
.info-box{background:#1a2b1a;border:1px solid #25D36640;border-radius:8px;
padding:12px 15px;margin-bottom:15px;font-size:13px;color:#25D366;}
.warn-box{background:#2b1a0d;border:1px solid #f39c1240;border-radius:8px;
padding:12px 15px;margin-bottom:15px;font-size:13px;color:#f39c12;}
@media(max-width:768px){
.sidebar{width:55px;}
.sidebar-logo,.nav-item .nav-text{display:none;}
.nav-item{justify-content:center;padding:12px;}
.main{margin-left:55px;padding:12px;}
.stats-grid{grid-template-columns:repeat(2,1fr);}
}
</style></head>
<body>

<div class="sidebar">
<div class="sidebar-logo">
<h2>🏪 Mega</h2>
<p>Admin Panel</p>
</div>
<div class="nav-item active" onclick="showPage('orders',this)">
<span>📦</span><span class="nav-text"> Orders</span></div>
<div class="nav-item" onclick="showPage('products',this)">
<span>🎨</span><span class="nav-text"> Products</span></div>
<div class="nav-item" onclick="showPage('payment',this)">
<span>💳</span><span class="nav-text"> Payment</span></div>
<div class="nav-item" onclick="showPage('prompt',this)">
<span>🤖</span><span class="nav-text"> AI Prompt</span></div>
<div class="nav-item" onclick="showPage('settings',this)">
<span>⚙️</span><span class="nav-text"> Settings</span></div>
<div class="nav-item" onclick="window.open('/qr','_blank')">
<span>📱</span><span class="nav-text"> QR Code</span></div>
<div class="nav-item" onclick="window.location='/logout'">
<span>🚪</span><span class="nav-text"> Logout</span></div>
</div>

<div class="main">
<div class="topbar">
<h1 id="pageTitle">📦 Orders</h1>
<div style="display:flex;gap:10px;align-items:center;">
<span class="bot-badge" id="botBadge">⏳ Loading...</span>
<button class="btn btn-gray" onclick="loadData()" style="padding:6px 12px;font-size:12px;">🔄</button>
</div>
</div>

<div class="stats-grid" id="statsGrid" style="display:grid"></div>
<div class="revenue-card" id="revenueCard">
<p>💰 Total Revenue</p>
<h2 id="revenue">PKR 0</h2>
<p id="revenueDetail">0 orders approved</p>
</div>

<!-- ORDERS PAGE -->
<div class="page active" id="page-orders">
<div class="section">
<div class="section-header"><h3>⏳ Pending Orders</h3>
<span id="pendingCount" style="color:#f39c12;font-size:13px"></span></div>
<div class="section-body" id="pendingOrders"><div class="empty">Loading...</div></div>
</div>
<div class="section">
<div class="section-header"><h3>✅ Approved Orders</h3></div>
<div class="section-body" id="approvedOrders"><div class="empty">Loading...</div></div>
</div>
<div class="section">
<div class="section-header"><h3>❌ Rejected Orders</h3></div>
<div class="section-body" id="rejectedOrders"><div class="empty">Loading...</div></div>
</div>
</div>

<!-- PRODUCTS PAGE -->
<div class="page" id="page-products">
<div class="section">
<div class="section-header">
<h3>🎨 Products</h3>
<button class="btn btn-green" onclick="addProduct()">+ Add Product</button>
</div>
<div class="section-body" id="productsList"></div>
</div>
</div>

<!-- PAYMENT PAGE -->
<div class="page" id="page-payment">
<div class="section">
<div class="section-header"><h3>💳 Payment Details</h3></div>
<div class="section-body">
<div class="info-box">✅ Yeh details customer ko payment ke waqt bhejte hain</div>
<h4 style="color:#aaa;margin-bottom:12px">📱 EasyPaisa</h4>
<div class="form-group"><label>Number</label><input id="ep_number" placeholder="03XX-XXXXXXX"/></div>
<div class="form-group"><label>Account Name</label><input id="ep_name" placeholder="Tumhara Naam"/></div>
<h4 style="color:#aaa;margin:15px 0 12px">📱 JazzCash</h4>
<div class="form-group"><label>Number</label><input id="jc_number" placeholder="03XX-XXXXXXX"/></div>
<div class="form-group"><label>Account Name</label><input id="jc_name" placeholder="Tumhara Naam"/></div>
<h4 style="color:#aaa;margin:15px 0 12px">🏦 Bank Account</h4>
<div class="form-group"><label>Bank Name</label><input id="bank_name" placeholder="HBL"/></div>
<div class="form-group"><label>Account Number</label><input id="bank_acc" placeholder="XXXXXXXXXXXXXXX"/></div>
<div class="form-group"><label>Account Holder Name</label><input id="bank_holder" placeholder="Tumhara Naam"/></div>
<div class="form-group"><label>IBAN</label><input id="bank_iban" placeholder="PK00XXXX..."/></div>
<button class="save-btn" onclick="savePayment()">💾 Save Payment Details</button>
</div>
</div>
</div>

<!-- AI PROMPT PAGE -->
<div class="page" id="page-prompt">
<div class="section">
<div class="section-header"><h3>🤖 AI Sales Agent Prompt</h3></div>
<div class="section-body">
<div class="warn-box">⚠️ ORDER_READY word zaroor rakho — iske bina order create nahi hoga!</div>
<div class="form-group">
<label>System Prompt — AI ka behavior yahan se control karo</label>
<textarea id="aiPrompt" rows="20" style="min-height:400px;font-size:13px;"></textarea>
</div>
<button class="save-btn" onclick="savePrompt()">💾 Save Prompt</button>
</div>
</div>
</div>

<!-- SETTINGS PAGE -->
<div class="page" id="page-settings">
<div class="section">
<div class="section-header"><h3>⚙️ General Settings</h3></div>
<div class="section-body">
<div class="form-group"><label>Business Name</label>
<input id="s_bizName" placeholder="Mega Agency"/></div>
<div class="form-group"><label>Admin WhatsApp Number (92XXXXXXXXXX format)</label>
<input id="s_adminNum" placeholder="923001234567"/></div>
<div class="form-group"><label>New Dashboard Password (khali chhodo agar change nahi karna)</label>
<input id="s_password" type="password" placeholder="New password..."/></div>
<button class="save-btn" onclick="saveSettings()">💾 Save Settings</button>
</div>
</div>
<div class="section" style="margin-top:20px">
<div class="section-header"><h3>📱 WhatsApp Session</h3></div>
<div class="section-body">
<div class="info-box">✅ Session Upstash mein save hai — restart pe auto connect hoga!</div>
<p style="color:#aaa;font-size:13px;margin-bottom:15px">
Agar bot connect nahi ho raha ya koi masla ho toh session reset karo — naya QR scan karna hoga.
</p>
<button class="btn btn-red" onclick="resetSession()">🔄 Reset WhatsApp Session</button>
</div>
</div>
</div>
</div>

<!-- Message Modal -->
<div class="msg-modal" id="msgModal">
<div class="msg-box">
<h3>💬 Custom Message Bhejo</h3>
<input type="hidden" id="msgJid"/>
<div class="form-group">
<label>Message</label>
<textarea id="msgText" rows="4" placeholder="Yahan message likho..."></textarea>
</div>
<div class="btn-row">
<button class="btn btn-green" onclick="sendCustomMsg()">📤 Send</button>
<button class="btn btn-gray" onclick="closeModal()">Cancel</button>
</div>
</div>
</div>

<div class="toast" id="toast">✅ Saved!</div>

<script>
let allData = {};
let products = [];

async function loadData() {
    try {
        const r = await fetch('/api/data');
        allData = await r.json();
        products = JSON.parse(JSON.stringify(allData.products || []));
        renderAll();
    } catch(e) {
        console.error('Load error:', e);
    }
}

function renderAll() {
    const badge = document.getElementById('botBadge');
    badge.className = 'bot-badge ' + (allData.botStatus === 'connected' ? 'badge-live' : 'badge-off');
    badge.textContent = allData.botStatus === 'connected' ? '🟢 Bot Live' : '🔴 ' + allData.botStatus;

    const s = allData.stats || {};
    document.getElementById('statsGrid').innerHTML = \`
    <div class="stat-card" style="border-top:3px solid #f39c12">
    <h2 style="color:#f39c12">\${s.pending||0}</h2><p>⏳ Pending</p></div>
    <div class="stat-card" style="border-top:3px solid #25D366">
    <h2 style="color:#25D366">\${s.approved||0}</h2><p>✅ Approved</p></div>
    <div class="stat-card" style="border-top:3px solid #e74c3c">
    <h2 style="color:#e74c3c">\${s.rejected||0}</h2><p>❌ Rejected</p></div>
    <div class="stat-card" style="border-top:3px solid #9b59b6">
    <h2 style="color:#9b59b6">\${s.total||0}</h2><p>📦 Total</p></div>\`;

    document.getElementById('revenue').textContent = 'PKR ' + (s.revenue||0).toLocaleString();
    document.getElementById('revenueDetail').textContent = (s.approved||0) + ' orders approved';

    renderOrders();
    renderProducts();
    renderPayment();
    renderPrompt();
    renderSettings();
}

function renderOrders() {
    const orders = Object.values(allData.orders || {}).sort((a,b) => b.timestamp - a.timestamp);
    const pending = orders.filter(o => o.status === 'pending');
    const approved = orders.filter(o => o.status === 'approved');
    const rejected = orders.filter(o => o.status === 'rejected');

    const pc = document.getElementById('pendingCount');
    if(pc) pc.textContent = pending.length > 0 ? pending.length + ' new' : '';

    document.getElementById('pendingOrders').innerHTML = pending.length === 0
        ? '<div class="empty">Koi pending order nahi ✅</div>'
        : pending.map(o => orderCard(o)).join('');
    document.getElementById('approvedOrders').innerHTML = approved.length === 0
        ? '<div class="empty">Koi approved order nahi</div>'
        : approved.map(o => orderCard(o)).join('');
    document.getElementById('rejectedOrders').innerHTML = rejected.length === 0
        ? '<div class="empty">Koi rejected order nahi</div>'
        : rejected.map(o => orderCard(o)).join('');
}

function orderCard(o) {
    const time = new Date(o.timestamp).toLocaleString('en-PK');
    const bc = o.status === 'pending' ? 'bp' : o.status === 'approved' ? 'ba' : 'br';
    const actions = o.status === 'pending'
        ? \`<button class="btn btn-green" onclick="approveOrder(\${o.orderId})">✅ Approve</button>
           <button class="btn btn-red" onclick="rejectOrder(\${o.orderId})">❌ Reject</button>
           <button class="btn btn-blue" onclick="openMsg('\${o.customerJid}')">💬 Message</button>\`
        : \`<button class="btn btn-blue" onclick="openMsg('\${o.customerJid}')">💬 Message</button>\`;
    return \`<div class="order-card \${o.status}">
    <div class="order-header">
    <span class="order-id">#\${o.orderId}</span>
    <span class="badge \${bc}">\${o.status.toUpperCase()}</span>
    </div>
    <div class="order-info">
    📱 Number: <b>\${o.customerNumber}</b><br>
    👤 Name: <b>\${o.customerName||'N/A'}</b><br>
    📸 Screenshot: <b>\${o.hasScreenshot ? '✅ Received' : '❌ Pending'}</b><br>
    📅 Time: <b>\${time}</b>
    </div>
    <div class="btn-row">\${actions}</div>
    </div>\`;
}

async function approveOrder(id) {
    if(!confirm('Order #' + id + ' approve karo?')) return;
    const r = await fetch('/api/approve/' + id, {method:'POST'});
    const d = await r.json();
    showToast(d.success ? '✅ Order Approved!' : '❌ Error!');
    loadData();
}

async function rejectOrder(id) {
    if(!confirm('Order #' + id + ' reject karo?')) return;
    const r = await fetch('/api/reject/' + id, {method:'POST'});
    const d = await r.json();
    showToast(d.success ? '❌ Order Rejected!' : '❌ Error!');
    loadData();
}

function renderProducts() {
    const el = document.getElementById('productsList');
    if(!products.length) { el.innerHTML = '<div class="empty">Koi product nahi</div>'; return; }
    el.innerHTML = products.map((p,i) => \`
    <div class="product-card">
    <div class="product-header">
    <span class="product-name">\${p.name}</span>
    <label class="toggle">
    <input type="checkbox" \${p.active?'checked':''} onchange="products[\${i}].active=this.checked"/>
    <span class="slider"></span></label>
    </div>
    <div class="form-group"><label>Product Name</label>
    <input value="\${p.name}" onchange="products[\${i}].name=this.value"/></div>
    <div class="form-group"><label>Price (PKR)</label>
    <input type="number" value="\${p.price}" onchange="products[\${i}].price=parseInt(this.value)||0"/></div>
    <div class="form-group"><label>Description</label>
    <textarea onchange="products[\${i}].description=this.value">\${p.description||''}</textarea></div>
    <div class="form-group"><label>⬇️ Download Link (approve hone pe customer ko milega)</label>
    <input value="\${p.downloadLink||''}" placeholder="https://drive.google.com/..."
    onchange="products[\${i}].downloadLink=this.value"/></div>
    <div class="form-group"><label>Features</label>
    <div class="feature-list" id="fl_\${i}">
    \${(p.features||[]).map((f,j)=>\`<div class="feature-tag">\${f}
    <button onclick="removeFeature(\${i},\${j})">×</button></div>\`).join('')}
    </div>
    <div class="feature-input">
    <input id="nf_\${i}" placeholder="New feature add karo..."
    onkeypress="if(event.key==='Enter')addFeature(\${i})"/>
    <button onclick="addFeature(\${i})">+ Add</button>
    </div></div>
    <div class="btn-row">
    <button class="btn btn-green" onclick="saveProducts()">💾 Save</button>
    <button class="btn btn-red" onclick="removeProduct(\${i})">🗑️ Delete</button>
    </div></div>\`).join('');
}

function addFeature(i) {
    const inp = document.getElementById('nf_' + i);
    if(!inp.value.trim()) return;
    if(!products[i].features) products[i].features = [];
    products[i].features.push(inp.value.trim());
    inp.value = '';
    renderProducts();
}
function removeFeature(i,j) { products[i].features.splice(j,1); renderProducts(); }
function addProduct() {
    products.push({id:Date.now(),name:'New Product',price:999,description:'',
    features:[],downloadLink:'',active:false});
    renderProducts();
}
function removeProduct(i) {
    if(confirm('Delete karo?')) { products.splice(i,1); renderProducts(); }
}
async function saveProducts() {
    const r = await fetch('/api/products', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(products)
    });
    const d = await r.json();
    showToast(d.success ? '✅ Products Saved!' : '❌ Error!');
    loadData();
}

function renderPayment() {
    const p = allData.payment || {};
    document.getElementById('ep_number').value = p.easypaisa?.number || '';
    document.getElementById('ep_name').value = p.easypaisa?.name || '';
    document.getElementById('jc_number').value = p.jazzcash?.number || '';
    document.getElementById('jc_name').value = p.jazzcash?.name || '';
    document.getElementById('bank_name').value = p.bank?.bankName || '';
    document.getElementById('bank_acc').value = p.bank?.accountNumber || '';
    document.getElementById('bank_holder').value = p.bank?.accountName || '';
    document.getElementById('bank_iban').value = p.bank?.iban || '';
}
async function savePayment() {
    const data = {
        easypaisa: {
            number: document.getElementById('ep_number').value,
            name: document.getElementById('ep_name').value
        },
        jazzcash: {
            number: document.getElementById('jc_number').value,
            name: document.getElementById('jc_name').value
        },
        bank: {
            bankName: document.getElementById('bank_name').value,
            accountNumber: document.getElementById('bank_acc').value,
            accountName: document.getElementById('bank_holder').value,
            iban: document.getElementById('bank_iban').value
        }
    };
    const r = await fetch('/api/payment', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(data)
    });
    const d = await r.json();
    showToast(d.success ? '✅ Payment Details Saved!' : '❌ Error!');
}

function renderPrompt() {
    document.getElementById('aiPrompt').value = allData.aiPrompt || '';
}
async function savePrompt() {
    const prompt = document.getElementById('aiPrompt').value;
    const r = await fetch('/api/prompt', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({prompt})
    });
    const d = await r.json();
    showToast(d.success ? '✅ AI Prompt Saved!' : '❌ Error!');
}

function renderSettings() {
    const s = allData.settings || {};
    document.getElementById('s_bizName').value = s.businessName || '';
    document.getElementById('s_adminNum').value = s.adminNumber || '';
}
async function saveSettings() {
    const pass = document.getElementById('s_password').value;
    const data = {
        businessName: document.getElementById('s_bizName').value,
        adminNumber: document.getElementById('s_adminNum').value,
    };
    if(pass) data.dashboardPassword = pass;
    const r = await fetch('/api/settings', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(data)
    });
    const d = await r.json();
    showToast(d.success ? '✅ Settings Saved!' : '❌ Error!');
    document.getElementById('s_password').value = '';
}

async function resetSession() {
    if(!confirm('WhatsApp session reset karna chahte ho? Naya QR scan karna hoga!')) return;
    const r = await fetch('/api/reset-session', {method:'POST'});
    const d = await r.json();
    showToast(d.success ? '🔄 Session Reset! Bot restart ho raha hai...' : '❌ Error!');
    if(d.success) setTimeout(() => window.location = '/qr', 3000);
}

function showPage(page, el) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById('page-' + page).classList.add('active');
    if(el) el.classList.add('active');
    const titles = {
        orders:'📦 Orders',products:'🎨 Products',
        payment:'💳 Payment',prompt:'🤖 AI Prompt',settings:'⚙️ Settings'
    };
    document.getElementById('pageTitle').textContent = titles[page] || page;
    const showStats = page === 'orders';
    document.getElementById('statsGrid').style.display = showStats ? 'grid' : 'none';
    document.getElementById('revenueCard').style.display = showStats ? 'block' : 'none';
}

function openMsg(jid) {
    document.getElementById('msgJid').value = jid;
    document.getElementById('msgModal').classList.add('show');
}
function closeModal() { document.getElementById('msgModal').classList.remove('show'); }
async function sendCustomMsg() {
    const jid = document.getElementById('msgJid').value;
    const message = document.getElementById('msgText').value;
    if(!message.trim()) return;
    const r = await fetch('/api/send-message', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jid, message})
    });
    const d = await r.json();
    showToast(d.success ? '✅ Message Sent!' : '❌ Error: ' + (d.error||''));
    if(d.success) { closeModal(); document.getElementById('msgText').value = ''; }
}

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.display = 'block';
    setTimeout(() => t.style.display = 'none', 3000);
}

loadData();
setInterval(loadData, 15000);
</script>
</body></html>`);
        return;
    }

    res.writeHead(302, { Location: '/dashboard' });
    res.end();
});

server.listen(process.env.PORT || 3000, () => {
    console.log('🌐 Server ready!');
    console.log('📊 Dashboard: /dashboard');
    console.log('📱 QR: /qr');
});

// ─────────────────────────────────────────
// MESSAGE HANDLER
// ─────────────────────────────────────────
async function handleMessage(sock, message) {
    try {
        if (message.key.fromMe) return;

        const senderId = message.key?.remoteJid;
        if (!senderId) return;

        // Newsletter/Broadcast/Group ignore karo
        if (senderId === 'status@broadcast') return;
        if (senderId.endsWith('@broadcast')) return;
        if (senderId.includes('newsletter')) return;
        if (senderId.endsWith('@g.us')) return;

        const senderName = message.pushName || 'Customer';
        const msgType = Object.keys(message.message || {})[0];

        // Screenshot handle
        if (msgType === 'imageMessage') {
            const existingOrder = Object.values(botData.orders).find(
                o => o.customerJid === senderId && o.status === 'pending'
            );
            if (existingOrder) {
                existingOrder.hasScreenshot = true;
                await saveData();
                await sock.sendMessage(senderId, {
                    text: `📸 *Screenshot Receive Ho Gaya!*\n\n` +
                          `Order *#${existingOrder.orderId}*\n\n` +
                          `✅ Admin verify kar raha hai\n` +
                          `⏳ 1 hour mein themes deliver honge!\n\n` +
                          `Shukriya! 🙏`
                });
                // Admin ko alert
                const adminJid = botData.settings.adminNumber + '@s.whatsapp.net';
                try {
                    await sock.sendMessage(adminJid, {
                        text: `🔔 *New Payment Screenshot!*\n\n` +
                              `Order: *#${existingOrder.orderId}*\n` +
                              `Customer: ${senderName}\n` +
                              `Number: ${existingOrder.customerNumber}\n\n` +
                              `Dashboard pe approve/reject karo! ⚡`
                    });
                } catch (e) {}
            } else {
                const aiReply = await getAISalesResponse(
                    '[Customer ne ek image bheja bina order ke]',
                    senderId,
                    senderName
                );
                await sock.sendMessage(senderId, { text: aiReply.message });
            }
            return;
        }

        const userMessage =
            message.message?.conversation ||
            message.message?.extendedTextMessage?.text || '';

        if (!userMessage.trim()) return;

        console.log(`📩 ${senderName}: ${userMessage}`);
        await sock.sendPresenceUpdate('composing', senderId);

        const aiReply = await getAISalesResponse(userMessage, senderId, senderName);
        await sock.sendPresenceUpdate('paused', senderId);

        if (aiReply.shouldOrder) {
            botData.orderCounter++;
            const orderId = botData.orderCounter;
            const product = aiReply.product || botData.products[0];
            botData.orders[senderId] = {
                orderId,
                customerJid: senderId,
                customerNumber: senderId.replace('@s.whatsapp.net', ''),
                customerName: senderName,
                productId: product?.id,
                status: 'pending',
                hasScreenshot: false,
                timestamp: Date.now()
            };
            await saveData();
            if (aiReply.message) {
                await sock.sendMessage(senderId, { text: aiReply.message }, { quoted: message });
                await new Promise(r => setTimeout(r, 1500));
            }
            await sock.sendMessage(senderId, { text: getPaymentMessage(orderId, product) });
            console.log(`🛒 New Order: #${orderId} for ${senderName}`);
        } else {
            await sock.sendMessage(senderId, { text: aiReply.message }, { quoted: message });
        }
    } catch (err) {
        console.error('Handle error:', err.message);
    }
}

// ─────────────────────────────────────────
// WHATSAPP BOT
// ─────────────────────────────────────────
async function startBot() {
    try {
        console.log('🔄 Bot start ho raha hai...');

        // Bot data load karo
        await loadData();

        // ✅ Upstash se auth load karo
        const { state, saveCreds } = await useUpstashAuthState();

        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`📱 WA Version: ${version.join('.')} — Latest: ${isLatest}`);

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            emitOwnEvents: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            qrTimeout: 60000,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 5,
            fireInitQueries: true,
            syncFullHistory: false
        });

        sockGlobal = sock;
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQR = qr;
                botStatus = 'qr_ready';
                console.log('📱 QR Ready! /qr pe jao scan karne ke liye!');
            }

            if (connection === 'close') {
                currentQR = null;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log('❌ Disconnected, code:', code);

                if (code === DisconnectReason.loggedOut) {
                    botStatus = 'logged_out';
                    // Upstash se auth clear karo
                    try {
                        await redisSet('wa_auth_state', {});
                        await redisSet('wa_creds', null);
                    } catch (e) {}
                    console.log('🔄 Logged out — fresh start...');
                    setTimeout(startBot, 5000);
                } else {
                    botStatus = 'reconnecting';
                    const delay = code === 405 ? 15000 : 10000;
                    console.log(`🔄 ${delay/1000}sec mein reconnect...`);
                    setTimeout(startBot, delay);
                }
            }

            if (connection === 'open') {
                currentQR = null;
                botStatus = 'connected';
                console.log('✅ WhatsApp Connected!');
                console.log('🏪 Mega Agency AI Sales Bot LIVE!');
                console.log('💾 Session Upstash mein save hai — dobara scan nahi karna parega!');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const message of messages) {
                await handleMessage(sock, message);
            }
        });

    } catch (err) {
        console.error('Bot start error:', err.message);
        botStatus = 'error';
        setTimeout(startBot, 15000);
    }
}

console.log('🚀 Mega Agency AI Sales Bot start ho raha hai...');
startBot();
