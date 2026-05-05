require('dotenv').config();
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    Browsers,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    makeInMemoryStore
} = require('@whiskeysockets/baileys');
const axios = require('axios');
const pino = require('pino');
const http = require('http');
const QRCode = require('qrcode');
const fs = require('fs');
const url = require('url');

// ─────────────────────────────────────────
// UPSTASH REDIS
// ─────────────────────────────────────────
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
    try {
        const r = await axios.get(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, timeout: 8000
        });
        if (r.data.result === null) return null;
        return JSON.parse(r.data.result);
    } catch (e) { return null; }
}

async function redisSet(key, value) {
    try {
        await axios.post(`${REDIS_URL}/set/${encodeURIComponent(key)}`,
            { value: JSON.stringify(value) },
            { headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 8000 }
        );
        return true;
    } catch (e) { return false; }
}

// ─────────────────────────────────────────
// GOOGLE SHEETS
// ─────────────────────────────────────────
async function getGoogleToken() {
    try {
        const email = process.env.GOOGLE_CLIENT_EMAIL;
        const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
        const sheetId = process.env.GOOGLE_SHEET_ID;
        if (!email || !key || !sheetId) return null;
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now })).toString('base64url');
        const crypto = require('crypto');
        const sign = crypto.createSign('RSA-SHA256');
        sign.update(`${header}.${payload}`);
        const jwt = `${header}.${payload}.${sign.sign(key, 'base64url')}`;
        const res = await axios.post('https://oauth2.googleapis.com/token', { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt });
        return res.data.access_token;
    } catch (e) { return null; }
}

async function saveToSheet(data) {
    try {
        const token = await getGoogleToken();
        if (!token) return;
        const sheetId = process.env.GOOGLE_SHEET_ID;
        await axios.post(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A:H:append?valueInputOption=USER_ENTERED`,
            { values: [[data.orderId || '', data.customerName || '', data.customerNumber || '', data.product || '', data.amount || '', data.status || '', data.language || '', new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })]] },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        console.log('✅ Sheet updated!');
    } catch (e) { console.log('Sheet error:', e.message); }
}

async function initSheet() {
    try {
        const token = await getGoogleToken();
        if (!token) return;
        const sheetId = process.env.GOOGLE_SHEET_ID;
        await axios.post(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED`, { values: [['Order ID', 'Customer', 'Phone', 'Product', 'Amount', 'Status', 'Language', 'Date']] }, { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) {}
}

// ─────────────────────────────────────────
// VOICE TO TEXT
// ─────────────────────────────────────────
async function voiceToText(audioBuffer) {
    try {
        const FormData = require('form-data');
        const form = new FormData();
        form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
        form.append('model', 'whisper-large-v3');
        form.append('response_format', 'json');
        const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
            headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
            timeout: 30000
        });
        return res.data.text || '';
    } catch (e) { return null; }
}

// ─────────────────────────────────────────
// LANGUAGE DETECTION
// ─────────────────────────────────────────
function detectLang(text) {
    if (/[\u0600-\u06FF]/.test(text)) return 'urdu';
    if (/\b(kya|hai|haan|nahi|bhai|yar|chahiye|theek|acha|karo|dedo|batao|kitna|lena|mujhe|yrr)\b/i.test(text)) return 'roman_urdu';
    return 'english';
}

// ─────────────────────────────────────────
// DATA STORE
// ─────────────────────────────────────────
const DATA_KEY = 'bot_data_v6';
const DATA_FILE = '/tmp/bot_data_v6.json';

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
            bank: { bankName: 'HBL', accountNumber: 'XXXXXXXXXXXXXXX', accountName: 'Tumhara Naam', iban: 'PK00XXXX0000000000000000' }
        },
        products: [{
            id: 1, name: '100+ Premium Shopify Themes Bundle', price: 999,
            description: 'Complete collection of 100+ premium themes for all niches',
            features: ['100+ Premium Themes', 'All Niches Covered', 'Fashion, Electronics, Food & More', 'Regular Updates', '24/7 Support', 'Installation Guide', 'Mobile Optimized'],
            downloadLink: '', active: true
        }],
        aiPrompt: `Tum Mega Agency ke professional AI Sales Agent ho. Tumhara naam "Max" hai.

TUMHARI SERVICE:
- Product: 100+ Premium Shopify Themes Mega Bundle
- Price: PKR 999 ONLY (yahi final price hai — koi aur price mat batana)
- Delivery: Payment approve hone ke 1 hour baad
- Features: 100+ themes, fashion/electronics/food/all niches, regular updates, installation guide, 24/7 support

LANGUAGE: Customer ki language follow karo (Urdu/Roman Urdu/English)

TUMHARA KAAM:
1. Customer se warmly greet karo
2. Unke niche ke baare mein poocho
3. Value explain karo specifically
4. Price objections confidently handle karo
5. Jab customer BUY karna chahe — ORDER_READY likho

PRICE NEGOTIATION — IRON RULE:
- Discount KABHI NAHI — PKR 999 FINAL HAI
- "Mehenga hai" → "Ek theme 5000+ ki, 100+ sirf 999 — PKR 10 per theme!"
- "Kam karo" → "Bhai yeh already lowest — quality se compromise nahi hoga"

SELLING:
- Value: "Market mein ek theme 5000+ ki hai, 100+ sirf PKR 999"
- Per unit: "Sirf PKR 10 per theme"
- FOMO: "Competitors already use kar rahe hain"
- ROI: "Ek sale se 999 wapas"

RULES:
- Short replies — 3-4 lines max
- Friendly emojis
- ORDER_READY bilkul start mein jab order ho`,
        broadcasts: [],
        orders: {},
        customers: {},
        orderCounter: 1000
    };
}

let botData = getDefaultData();

// Load from Upstash first, fallback to local file
async function loadData() {
    try {
        // Try Upstash first
        const saved = await redisGet(DATA_KEY);
        if (saved) {
            botData = { ...getDefaultData(), ...saved };
            if (!botData.customers) botData.customers = {};
            if (!botData.broadcasts) botData.broadcasts = [];
            console.log('✅ Data loaded from Upstash!');
            return;
        }
        // Fallback to local file
        if (fs.existsSync(DATA_FILE)) {
            const saved2 = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            botData = { ...getDefaultData(), ...saved2 };
            if (!botData.customers) botData.customers = {};
            if (!botData.broadcasts) botData.broadcasts = [];
            console.log('✅ Data loaded from local file!');
        }
    } catch (e) { console.log('Load error:', e.message); }
}

// Save to both Upstash and local file
async function saveData() {
    try {
        await redisSet(DATA_KEY, botData);
        fs.writeFileSync(DATA_FILE, JSON.stringify(botData, null, 2));
    } catch (e) { console.log('Save error:', e.message); }
}

loadData();

// ─────────────────────────────────────────
// BOT STATE
// ─────────────────────────────────────────
let currentQR = null;
let botStatus = 'starting';
let sockGlobal = null;
const salesHistory = {};
const sessions = {};
let broadcastRunning = false;
let existingChats = [];
let chatsLoaded = false;
let globalStore = null;

function isAuthenticated(req) {
    const cookies = req.headers.cookie || '';
    const sessionMatch = cookies.match(/session=([^;]+)/);
    if (!sessionMatch) return false;
    return sessions[sessionMatch[1]] === true;
}

async function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
}

// ─────────────────────────────────────────
// CHATS PROCESSING
// ─────────────────────────────────────────
function processChatsFromStore() {
    try {
        if (!globalStore) { chatsLoaded = true; return; }
        const chats = globalStore.chats.all();
        const newChats = [];
        for (const chat of chats) {
            if (!chat.id) continue;
            if (chat.id.endsWith('@g.us')) continue;
            if (chat.id.endsWith('@broadcast')) continue;
            if (chat.id === 'status@broadcast') continue;
            if (chat.id.includes('newsletter')) continue;
            const number = chat.id.replace('@s.whatsapp.net', '');
            if (number.length < 10) continue;
            newChats.push({
                jid: chat.id, number,
                name: chat.name || chat.pushName || number,
                lastMessage: chat.conversationTimestamp || 0
            });
        }
        newChats.sort((a, b) => b.lastMessage - a.lastMessage);
        existingChats = newChats;
        chatsLoaded = true;
        console.log(`✅ ${newChats.length} chats processed!`);
    } catch (e) {
        console.log('Chat process error:', e.message);
        chatsLoaded = true;
    }
}

// ─────────────────────────────────────────
// BROADCAST
// ─────────────────────────────────────────
async function generateBroadcastMessage(offerDetails, customerName, personalized) {
    const models = [
        { p: 'groq', m: 'llama-3.3-70b-versatile' },
        { p: 'groq', m: 'llama-3.1-8b-instant' },
        { p: 'openrouter', m: 'meta-llama/llama-3.1-8b-instruct:free' }
    ];
    const prompt = personalized
        ? `WhatsApp marketing message likho "${customerName}" ke liye.\nOffer: ${offerDetails}\nRules: Roman Urdu, 3-5 lines, compelling, naam use karo, emojis, price clear karo, call to action.`
        : `WhatsApp marketing message likho.\nOffer: ${offerDetails}\nRules: Roman Urdu, 3-5 lines, compelling, emojis, price clear karo, call to action.`;

    for (const { p, m } of models) {
        try {
            const url2 = p === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
            const headers = p === 'groq'
                ? { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }
                : { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://mega-agency.com', 'X-Title': 'Mega Agency' };
            const res = await axios.post(url2, { model: m, messages: [{ role: 'user', content: prompt }], max_tokens: 200, temperature: 0.9 }, { headers, timeout: 15000 });
            return res.data.choices[0].message.content.trim();
        } catch (e) {}
    }
    return offerDetails;
}

async function runBroadcast(broadcast) {
    if (!sockGlobal) return;
    broadcastRunning = true;
    const targets = broadcast.selectedContacts || [];
    let sent = 0, failed = 0;
    broadcast.status = 'running';
    broadcast.sentCount = 0;
    broadcast.failedCount = 0;
    await saveData();

    for (const contact of targets) {
        try {
            let message = broadcast.baseMessage;
            if (broadcast.personalized && broadcast.offerDetails) {
                message = await generateBroadcastMessage(broadcast.offerDetails, contact.name || 'Dost', true);
            }
            await sockGlobal.sendMessage(contact.jid, { text: message });
            sent++;
            broadcast.sentCount = sent;
            console.log(`📤 Sent ${sent}/${targets.length} → ${contact.name || contact.number}`);
            await new Promise(r => setTimeout(r, (broadcast.delaySeconds || 5) * 1000));
        } catch (e) {
            failed++;
            broadcast.failedCount = failed;
        }
    }
    broadcast.status = 'completed';
    broadcast.completedAt = Date.now();
    await saveData();
    broadcastRunning = false;
    console.log(`✅ Broadcast done! Sent:${sent} Failed:${failed}`);
}

// ─────────────────────────────────────────
// PAYMENT MESSAGE
// ─────────────────────────────────────────
function getPaymentMessage(orderId, product, lang) {
    const p = botData.payment;
    const details = `━━━━━━━━━━━━━━━━━━━━
💳 *Payment — ${botData.settings.currency} ${product.price}*

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
━━━━━━━━━━━━━━━━━━━━`;

    if (lang === 'urdu') return `🛒 *آرڈر کنفرم! #${orderId}*\n\n${details}\n\n✅ پیمنٹ کے بعد اسکرین شاٹ بھیجیں\n⏳ 1 گھنٹے میں ڈلیوری!`;
    if (lang === 'roman_urdu') return `🛒 *Order Confirmed! #${orderId}*\nProduct: *${product.name}*\n\n${details}\n\n✅ Payment ke baad *screenshot* bhejo\n📦 1 hour mein delivery guaranteed!`;
    return `🛒 *Order Confirmed! #${orderId}*\nProduct: *${product.name}*\n\n${details}\n\n✅ Send screenshot after payment\n📦 Delivery within 1 hour!`;
}

// ─────────────────────────────────────────
// AI SALES RESPONSE
// ─────────────────────────────────────────
async function getAISalesResponse(userMessage, userId, customerName, lang) {
    if (!salesHistory[userId]) salesHistory[userId] = [];
    salesHistory[userId].push({ role: 'user', content: userMessage });
    if (salesHistory[userId].length > 30) salesHistory[userId] = salesHistory[userId].slice(-30);

    const activeProduct = botData.products.find(p => p.active) || botData.products[0];
    const langRule = lang === 'urdu' ? 'Sirf Urdu script mein reply karo.' : lang === 'roman_urdu' ? 'Roman Urdu mein reply karo.' : 'English mein reply karo.';
    const systemPrompt = botData.aiPrompt +
        `\n\n${langRule}` +
        `\nCustomer naam: ${customerName}` +
        `\nActive Product: ${activeProduct.name}` +
        `\nPrice: ${botData.settings.currency} ${activeProduct.price}` +
        `\nYAD RAKHO: Price kabhi kam nahi karo!`;

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
            const apiUrl = provider === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
            const headers = provider === 'groq'
                ? { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }
                : { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://mega-agency.com', 'X-Title': 'Mega Agency' };

            const response = await axios.post(apiUrl, {
                model,
                messages: [{ role: 'system', content: systemPrompt }, ...salesHistory[userId]],
                max_tokens: 350, temperature: 0.85
            }, { headers, timeout: 15000 });

            const aiMessage = response.data.choices[0].message.content;
            salesHistory[userId].push({ role: 'assistant', content: aiMessage });
            const shouldOrder = aiMessage.toUpperCase().includes('ORDER_READY');
            const cleanMessage = aiMessage.replace(/ORDER_READY/gi, '').trim();
            console.log(`✅ AI: ${provider}/${model} | ${lang}`);
            return { message: cleanMessage, shouldOrder, product: activeProduct };
        } catch (err) {
            console.log(`❌ ${provider}/${model} fail`);
            if (salesHistory[userId].length > 0) salesHistory[userId].pop();
        }
    }

    const fb = { urdu: '⚠️ تکنیکی مسئلہ — 1 منٹ بعد کوشش کریں! 🙏', roman_urdu: '⚠️ Thodi technical difficulty. 1 min mein dobara try karo! 🙏', english: '⚠️ Technical issue. Try again in 1 minute! 🙏' };
    return { message: fb[lang] || fb.roman_urdu, shouldOrder: false, product: activeProduct };
}

// ─────────────────────────────────────────
// WEB SERVER
// ─────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // LOGIN
    if (pathname === '/login') {
        if (req.method === 'POST') {
            const body = await parseBody(req);
            if (body.password === botData.settings.dashboardPassword) {
                const sessionId = Math.random().toString(36).substring(2);
                sessions[sessionId] = true;
                res.writeHead(200, { 'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly`, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } else {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Wrong password!' }));
            }
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>Login</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#0f0f0f;color:white;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}.box{background:#1a1a1a;padding:40px;border-radius:16px;width:90%;max-width:380px;border:1px solid #333;text-align:center;}h1{color:#25D366;font-size:24px;margin-bottom:8px;}p{color:#aaa;font-size:13px;margin-bottom:25px;}input{width:100%;padding:12px 15px;background:#0f0f0f;border:1px solid #333;border-radius:8px;color:white;font-size:15px;margin-bottom:15px;outline:none;}input:focus{border-color:#25D366;}button{width:100%;padding:12px;background:#25D366;border:none;border-radius:8px;color:black;font-size:16px;font-weight:bold;cursor:pointer;}button:hover{background:#1ebe57;}.err{color:#e74c3c;font-size:13px;margin-top:10px;display:none;}</style></head><body><div class="box"><h1>🏪 Mega Agency</h1><p>Admin Dashboard Login</p><input type="password" id="pass" placeholder="Password" onkeypress="if(event.key==='Enter')login()"/><button onclick="login()">🔐 Login</button><div class="err" id="err">❌ Wrong password!</div></div><script>async function login(){const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pass').value})});const d=await r.json();if(d.success)window.location='/dashboard';else document.getElementById('err').style.display='block';}</script></body></html>`);
        return;
    }

    // AUTH CHECK
    if (pathname !== '/qr' && pathname !== '/login' && !isAuthenticated(req)) {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
    }

    // QR PAGE
    if (pathname === '/qr') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (botStatus === 'connected') {
            res.end(`<html><head><style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;}h2{color:#25D366;}a{color:#25D366;font-size:18px;margin-top:20px;display:block;}p{color:#aaa;}</style></head><body><h2>✅ Bot Connected!</h2><p>Mega Agency Bot live hai!</p><a href="/dashboard">📊 Dashboard Kholo</a></body></html>`);
            return;
        }
        if (!currentQR) {
            res.end(`<html><head><meta http-equiv="refresh" content="3"><style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;}h2{color:#f39c12;}p{color:#aaa;}</style></head><body><h2>⏳ QR Generate Ho Raha Hai...</h2><p>Status: ${botStatus}</p></body></html>`);
            return;
        }
        try {
            const qrDataURL = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
            res.end(`<html><head><meta http-equiv="refresh" content="25"><style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;padding:20px;}h2{color:#25D366;}img{border:8px solid white;border-radius:12px;width:280px;height:280px;}.steps{background:#222;padding:15px;border-radius:10px;text-align:left;max-width:320px;margin-top:15px;}p{color:#aaa;}</style></head><body><h2>📱 WhatsApp QR Code</h2><img src="${qrDataURL}"/><div class="steps"><p>1️⃣ WhatsApp kholo</p><p>2️⃣ 3 dots → Linked Devices</p><p>3️⃣ Link a Device</p><p>4️⃣ QR scan karo</p></div><p style="color:#f39c12;margin-top:15px">⚠️ 25 sec mein expire!</p></body></html>`);
        } catch (err) { res.end('<h1 style="color:red">QR Error: ' + err.message + '</h1>'); }
        return;
    }

    // API: GET DATA
    if (pathname === '/api/data' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const ordersArr = Object.values(botData.orders || {});
        res.end(JSON.stringify({
            ...botData, botStatus, chatsLoaded,
            stats: {
                pending: ordersArr.filter(o => o.status === 'pending').length,
                approved: ordersArr.filter(o => o.status === 'approved').length,
                rejected: ordersArr.filter(o => o.status === 'rejected').length,
                total: ordersArr.length,
                customers: Object.keys(botData.customers || {}).length,
                existingChats: existingChats.length,
                revenue: ordersArr.filter(o => o.status === 'approved').reduce((s, o) => {
                    const pr = botData.products.find(p => p.id === o.productId) || botData.products[0];
                    return s + (pr?.price || 0);
                }, 0)
            }
        }));
        return;
    }

    // API: GET CHATS
    if (pathname === '/api/chats' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ chats: existingChats, loaded: chatsLoaded, count: existingChats.length }));
        return;
    }

    // API: GENERATE MESSAGE
    if (pathname === '/api/generate-message' && req.method === 'POST') {
        const body = await parseBody(req);
        try {
            const msg = await generateBroadcastMessage(body.offerDetails || '', body.customerName || 'Dost', body.personalized || false);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: msg }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: SMART BROADCAST
    if (pathname === '/api/smart-broadcast' && req.method === 'POST') {
        const body = await parseBody(req);
        if (!body.selectedContacts || body.selectedContacts.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Contacts select karo!' }));
            return;
        }
        const bc = { id: Date.now(), offerDetails: body.offerDetails || '', baseMessage: body.baseMessage || '', personalized: body.personalized || false, delaySeconds: body.delaySeconds || 5, selectedContacts: body.selectedContacts, status: 'pending', sentCount: 0, failedCount: 0, totalContacts: body.selectedContacts.length, createdAt: Date.now() };
        if (!botData.broadcasts) botData.broadcasts = [];
        botData.broadcasts.unshift(bc);
        if (botData.broadcasts.length > 20) botData.broadcasts = botData.broadcasts.slice(0, 20);
        await saveData();
        if (!broadcastRunning) runBroadcast(bc).catch(console.error);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, broadcast: bc }));
        return;
    }

    if (pathname === '/api/settings' && req.method === 'POST') { const b = await parseBody(req); botData.settings = { ...botData.settings, ...b }; await saveData(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); return; }
    if (pathname === '/api/payment' && req.method === 'POST') { const b = await parseBody(req); botData.payment = b; await saveData(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); return; }
    if (pathname === '/api/products' && req.method === 'POST') { const b = await parseBody(req); botData.products = b; await saveData(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); return; }
    if (pathname === '/api/prompt' && req.method === 'POST') { const b = await parseBody(req); botData.aiPrompt = b.prompt; await saveData(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); return; }

    if (pathname.startsWith('/api/approve/') && req.method === 'POST') {
        const orderId = parseInt(pathname.split('/api/approve/')[1]);
        const order = Object.values(botData.orders).find(o => o.orderId === orderId);
        if (order && sockGlobal) {
            order.status = 'approved'; await saveData();
            const product = botData.products.find(p => p.id === order.productId) || botData.products[0];
            try {
                let msg = `🎉 *Payment Approved!*\n\nOrder *#${order.orderId}* confirm ho gaya!\n\n📦 *${product.name}*\n\n`;
                if (product.downloadLink) msg += `⬇️ *Download Link:*\n${product.downloadLink}\n\n`;
                msg += `Koi bhi help chahiye toh message karo!\nShukriya ${botData.settings.businessName} ko choose karne ka! 🙏`;
                await sockGlobal.sendMessage(order.customerJid, { text: msg });
                await saveToSheet({ ...order, product: product.name, amount: product.price, status: 'approved' });
            } catch (e) { console.log('Approve err:', e.message); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); return;
    }

    if (pathname.startsWith('/api/reject/') && req.method === 'POST') {
        const orderId = parseInt(pathname.split('/api/reject/')[1]);
        const order = Object.values(botData.orders).find(o => o.orderId === orderId);
        if (order && sockGlobal) {
            order.status = 'rejected'; await saveData();
            try {
                await sockGlobal.sendMessage(order.customerJid, { text: `❌ *Payment Verify Nahi Ho Saki*\n\nOrder *#${order.orderId}*\n\nScreenshot sahi nahi tha.\nDobara sahi screenshot bhejo ya admin se contact karo.\n\n"buy" likhkar dobara try karo! 💪` });
                await saveToSheet({ ...order, status: 'rejected' });
            } catch (e) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); return;
    }

    if (pathname === '/api/send-message' && req.method === 'POST') {
        const b = await parseBody(req);
        if (sockGlobal && b.jid && b.message) {
            try { await sockGlobal.sendMessage(b.jid, { text: b.message }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); }
            catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: e.message })); }
        } else { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false })); }
        return;
    }

    if (pathname === '/logout') { res.writeHead(302, { 'Set-Cookie': 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', Location: '/login' }); res.end(); return; }

    // MAIN DASHBOARD
    if (pathname === '/dashboard' || pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head>
<title>${botData.settings.businessName} - Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#0a0a0a;color:#e0e0e0;font-family:'Segoe UI',sans-serif;min-height:100vh;}
.sidebar{position:fixed;left:0;top:0;bottom:0;width:220px;background:#111;border-right:1px solid #222;padding:20px 0;z-index:100;overflow-y:auto;}
.sidebar-logo{padding:15px 20px 25px;border-bottom:1px solid #222;margin-bottom:10px;}
.sidebar-logo h2{color:#25D366;font-size:18px;}.sidebar-logo p{color:#666;font-size:11px;margin-top:3px;}
.nav-item{display:flex;align-items:center;gap:10px;padding:12px 20px;cursor:pointer;color:#aaa;font-size:14px;transition:all 0.2s;border-left:3px solid transparent;}
.nav-item:hover,.nav-item.active{background:#1a1a1a;color:#25D366;border-left-color:#25D366;}
.main{margin-left:220px;padding:25px;min-height:100vh;}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:25px;background:#111;padding:15px 20px;border-radius:12px;border:1px solid #222;flex-wrap:wrap;gap:10px;}
.topbar h1{font-size:20px;color:white;}
.bot-badge{padding:6px 14px;border-radius:20px;font-size:12px;font-weight:bold;}
.badge-live{background:#0d2b0d;color:#25D366;border:1px solid #25D366;}
.badge-off{background:#2b0d0d;color:#e74c3c;border:1px solid #e74c3c;}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:20px;}
.stat-card{background:#111;border-radius:12px;padding:18px;text-align:center;border:1px solid #222;}
.stat-card h2{font-size:28px;font-weight:bold;margin-bottom:4px;}.stat-card p{color:#666;font-size:11px;}
.section{background:#111;border-radius:12px;border:1px solid #222;margin-bottom:20px;overflow:hidden;}
.section-header{padding:15px 20px;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:center;}
.section-header h3{font-size:15px;color:white;}.section-body{padding:18px;}
.order-card{background:#0f0f0f;border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid #222;}
.order-card.pending{border-left:4px solid #f39c12;}.order-card.approved{border-left:4px solid #25D366;}.order-card.rejected{border-left:4px solid #e74c3c;}
.order-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.order-id{font-weight:bold;color:#25D366;font-size:15px;}
.badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:bold;}
.bp{background:#f39c12;color:black;}.ba{background:#25D366;color:black;}.br{background:#e74c3c;color:white;}
.order-info{font-size:13px;color:#aaa;line-height:1.9;}.order-info b{color:white;}
.btn-row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
.btn{padding:7px 16px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:bold;text-decoration:none;display:inline-block;}
.btn-green{background:#25D366;color:black;}.btn-red{background:#e74c3c;color:white;}.btn-blue{background:#3498db;color:white;}.btn-gray{background:#333;color:white;}.btn-purple{background:#9b59b6;color:white;}
.form-group{margin-bottom:15px;}.form-group label{display:block;color:#aaa;font-size:13px;margin-bottom:6px;}
.form-group input,.form-group textarea,.form-group select{width:100%;padding:10px 14px;background:#0f0f0f;border:1px solid #333;border-radius:8px;color:white;font-size:14px;outline:none;}
.form-group input:focus,.form-group textarea:focus{border-color:#25D366;}
.form-group textarea{resize:vertical;min-height:100px;font-family:'Segoe UI',sans-serif;}
.save-btn{background:#25D366;color:black;border:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;}
.product-card{background:#0f0f0f;border-radius:10px;padding:16px;margin-bottom:12px;border:1px solid #222;}
.product-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
.product-name{font-size:16px;font-weight:bold;color:white;}
.toggle{position:relative;width:44px;height:24px;}.toggle input{opacity:0;width:0;height:0;}
.slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#333;border-radius:24px;transition:.4s;}
.slider:before{position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;background:white;border-radius:50%;transition:.4s;}
input:checked+.slider{background:#25D366;}input:checked+.slider:before{transform:translateX(20px);}
.feature-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
.feature-tag{background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:4px 10px;font-size:12px;color:#aaa;display:flex;align-items:center;gap:5px;}
.feature-tag button{background:none;border:none;color:#e74c3c;cursor:pointer;font-size:14px;}
.feature-input{display:flex;gap:8px;margin-top:8px;}.feature-input input{flex:1;}
.feature-input button{background:#25D366;color:black;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:bold;}
.page{display:none;}.page.active{display:block;}
.empty{text-align:center;color:#444;padding:30px;font-size:14px;}
.revenue-card{background:linear-gradient(135deg,#1a2e1a,#1a1a2e);border-radius:12px;padding:18px;text-align:center;border:1px solid #25D36640;margin-bottom:20px;}
.revenue-card h2{color:#f39c12;font-size:32px;font-weight:bold;}
.info-box{background:#1a2b1a;border:1px solid #25D36640;border-radius:8px;padding:12px 15px;margin-bottom:15px;font-size:13px;color:#25D366;}
.warn-box{background:#2b1a0d;border:1px solid #f39c1240;border-radius:8px;padding:12px 15px;margin-bottom:15px;font-size:13px;color:#f39c12;}
.chat-item{background:#0f0f0f;border-radius:8px;padding:10px 14px;margin-bottom:6px;border:1px solid #222;display:flex;align-items:center;gap:10px;cursor:pointer;}
.chat-item:hover{background:#1a1a1a;}.chat-item.selected{border-color:#25D366;background:#0d2b0d;}
.chat-avatar{width:36px;height:36px;border-radius:50%;background:#25D36633;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}
.chat-info{flex:1;min-width:0;}
.chat-name{font-weight:bold;color:white;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.chat-number{color:#aaa;font-size:12px;}
.progress-bar{background:#222;border-radius:10px;height:8px;margin-top:10px;overflow:hidden;}
.progress-fill{background:#25D366;height:100%;border-radius:10px;transition:width 0.3s;}
.msg-modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:#000000aa;z-index:200;align-items:center;justify-content:center;}
.msg-modal.show{display:flex;}
.msg-box{background:#1a1a1a;border-radius:16px;padding:25px;width:90%;max-width:400px;border:1px solid #333;}
.msg-box h3{margin-bottom:15px;color:white;}
.toast{position:fixed;bottom:20px;right:20px;background:#25D366;color:black;padding:12px 20px;border-radius:10px;font-weight:bold;font-size:14px;z-index:999;display:none;}
@media(max-width:768px){
.sidebar{width:60px;}.sidebar-logo p,.nav-item span+span{display:none;}
.nav-item{justify-content:center;}.main{margin-left:60px;padding:15px;}.stats-grid{grid-template-columns:repeat(2,1fr);}
}
</style>
</head>
<body>
<div class="sidebar">
<div class="sidebar-logo"><h2>🏪 Mega</h2><p>Admin Panel</p></div>
<div class="nav-item active" id="nav-orders" onclick="showPage('orders')"><span>📦</span><span> Orders</span></div>
<div class="nav-item" id="nav-broadcast" onclick="showPage('broadcast')"><span>📢</span><span> Broadcast</span></div>
<div class="nav-item" id="nav-customers" onclick="showPage('customers')"><span>👥</span><span> Customers</span></div>
<div class="nav-item" id="nav-products" onclick="showPage('products')"><span>🎨</span><span> Products</span></div>
<div class="nav-item" id="nav-payment" onclick="showPage('payment')"><span>💳</span><span> Payment</span></div>
<div class="nav-item" id="nav-prompt" onclick="showPage('prompt')"><span>🤖</span><span> AI Prompt</span></div>
<div class="nav-item" id="nav-settings" onclick="showPage('settings')"><span>⚙️</span><span> Settings</span></div>
<div class="nav-item" onclick="window.location='/qr'"><span>📱</span><span> QR Code</span></div>
<div class="nav-item" onclick="window.location='/logout'"><span>🚪</span><span> Logout</span></div>
</div>

<div class="main">
<div class="topbar">
<h1 id="pageTitle">📦 Orders</h1>
<div style="display:flex;gap:10px;align-items:center;">
<span class="bot-badge" id="botBadge">⏳ Loading...</span>
<button class="btn btn-gray" onclick="loadData()" style="padding:6px 12px;font-size:12px;">🔄</button>
</div></div>

<div class="stats-grid" id="statsGrid"></div>
<div class="revenue-card" id="revenueCard"><p>💰 Total Revenue</p><h2 id="revenue">PKR 0</h2><p id="revenueDetail">0 orders approved</p></div>

<!-- ORDERS -->
<div class="page active" id="page-orders">
<div class="section"><div class="section-header"><h3>⏳ Pending Orders</h3></div><div class="section-body" id="pendingOrders"><div class="empty">Loading...</div></div></div>
<div class="section"><div class="section-header"><h3>✅ Approved Orders</h3></div><div class="section-body" id="approvedOrders"><div class="empty">Loading...</div></div></div>
<div class="section"><div class="section-header"><h3>❌ Rejected Orders</h3></div><div class="section-body" id="rejectedOrders"><div class="empty">Loading...</div></div></div>
</div>

<!-- BROADCAST -->
<div class="page" id="page-broadcast">
<div class="section"><div class="section-header"><h3>🤖 AI Message Generator</h3></div><div class="section-body">
<div class="info-box">✅ AI tumhara offer message generate karega</div>
<div class="form-group"><label>Offer Details (AI ko batao)</label><textarea id="offerDetails" rows="3" placeholder="e.g. 100+ Shopify themes bundle sirf PKR 999 mein — limited time offer!"></textarea></div>
<div class="form-group"><label>Message Type</label>
<select id="msgType"><option value="personalized">🎯 Personalized (har customer ke naam se)</option><option value="same">📋 Same message sab ko</option></select></div>
<button class="btn btn-purple" onclick="generateMsg()" id="genBtn">🤖 AI Se Message Generate Karo</button>
<div id="generatedMsg" style="display:none;margin-top:15px;">
<div class="form-group"><label>Generated Message (edit kar sakte ho)</label><textarea id="msgPreview" rows="6"></textarea></div>
</div>
</div></div>

<div class="section"><div class="section-header">
<h3>📱 Contacts Select Karo</h3>
<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
<button class="btn btn-green" onclick="selectAll()">✅ Select All</button>
<button class="btn btn-gray" onclick="deselectAll()">❌ Deselect</button>
<span id="selCount" style="color:#25D366;font-size:13px;"></span>
</div>
</div><div class="section-body">
<div style="margin-bottom:12px;">
<div class="form-group"><label>Delay Between Messages (seconds)</label><input type="number" id="bc_delay" value="5" min="1" max="60"/></div>
<input type="text" id="chatSearch" placeholder="🔍 Search contacts..." oninput="filterChats()" style="width:100%;padding:10px;background:#0f0f0f;border:1px solid #333;border-radius:8px;color:white;outline:none;"/>
</div>
<div id="chatStatus" style="text-align:center;color:#25D366;padding:20px;font-size:14px;">⏳ Bot connect hone ke baad contacts load honge...</div>
<div id="chatsList"></div>
</div></div>

<div class="section"><div class="section-header"><h3>🚀 Send Broadcast</h3></div><div class="section-body">
<div id="bcPreview" style="color:#aaa;font-size:13px;margin-bottom:15px;"></div>
<button class="btn btn-green" onclick="sendBroadcast()" style="width:100%;padding:12px;font-size:16px;">📢 Broadcast Bhejo</button>
<div id="bcProgress" style="display:none;margin-top:15px;">
<p style="color:#25D366;font-size:14px;" id="bcProgressText">Sending...</p>
<div class="progress-bar"><div class="progress-fill" id="bcProgressFill" style="width:0%"></div></div>
</div>
</div></div>

<div class="section"><div class="section-header"><h3>📋 Broadcast History</h3></div><div class="section-body" id="bcHistory"><div class="empty">Loading...</div></div></div>
</div>

<!-- CUSTOMERS -->
<div class="page" id="page-customers">
<div class="section"><div class="section-header"><h3>👥 Customers</h3><span id="custCount" style="color:#aaa;font-size:13px;"></span></div>
<div class="section-body" id="custList"><div class="empty">Loading...</div></div>
</div></div>

<!-- PRODUCTS -->
<div class="page" id="page-products">
<div class="section"><div class="section-header"><h3>🎨 Products</h3><button class="btn btn-green" onclick="addProduct()">+ Add Product</button></div>
<div class="section-body" id="productsList"></div>
</div></div>

<!-- PAYMENT -->
<div class="page" id="page-payment">
<div class="section"><div class="section-header"><h3>💳 Payment Details</h3></div><div class="section-body">
<h4 style="color:#aaa;margin-bottom:15px">📱 EasyPaisa</h4>
<div class="form-group"><label>Number</label><input id="ep_number" placeholder="03XX-XXXXXXX"/></div>
<div class="form-group"><label>Account Name</label><input id="ep_name" placeholder="Tumhara Naam"/></div>
<h4 style="color:#aaa;margin:15px 0">📱 JazzCash</h4>
<div class="form-group"><label>Number</label><input id="jc_number" placeholder="03XX-XXXXXXX"/></div>
<div class="form-group"><label>Account Name</label><input id="jc_name" placeholder="Tumhara Naam"/></div>
<h4 style="color:#aaa;margin:15px 0">🏦 Bank Account</h4>
<div class="form-group"><label>Bank Name</label><input id="bank_name" placeholder="HBL"/></div>
<div class="form-group"><label>Account Number</label><input id="bank_acc" placeholder="XXXXXXXXXXXXXXX"/></div>
<div class="form-group"><label>Account Holder Name</label><input id="bank_holder" placeholder="Tumhara Naam"/></div>
<div class="form-group"><label>IBAN</label><input id="bank_iban" placeholder="PK00XXXX..."/></div>
<button class="save-btn" onclick="savePayment()">💾 Save Payment Details</button>
</div></div></div>

<!-- AI PROMPT -->
<div class="page" id="page-prompt">
<div class="section"><div class="section-header"><h3>🤖 AI Sales Agent Prompt</h3></div><div class="section-body">
<div class="warn-box">⚠️ ORDER_READY word zaroor rakho. Price negotiation rules strong rakho!</div>
<div class="form-group"><label>System Prompt</label><textarea id="aiPrompt" rows="20" style="min-height:400px;"></textarea></div>
<button class="save-btn" onclick="savePrompt()">💾 Save Prompt</button>
</div></div></div>

<!-- SETTINGS -->
<div class="page" id="page-settings">
<div class="section"><div class="section-header"><h3>⚙️ Settings</h3></div><div class="section-body">
<div class="form-group"><label>Business Name</label><input id="s_bizName" placeholder="Mega Agency"/></div>
<div class="form-group"><label>Admin WhatsApp Number (92XXXXXXXXXX)</label><input id="s_adminNum" placeholder="923001234567"/></div>
<div class="form-group"><label>Dashboard Password (khali chhodo agar same rakho)</label><input id="s_password" type="password" placeholder="New password..."/></div>
<button class="save-btn" onclick="saveSettings()">💾 Save Settings</button>
</div></div></div>
</div>

<!-- Message Modal -->
<div class="msg-modal" id="msgModal">
<div class="msg-box"><h3>💬 Custom Message Bhejo</h3>
<input type="hidden" id="msgJid"/>
<div class="form-group"><label>Message</label><textarea id="msgText" rows="4" placeholder="Yahan message likho..."></textarea></div>
<div class="btn-row">
<button class="btn btn-green" onclick="sendCustomMsg()">📤 Send</button>
<button class="btn btn-gray" onclick="closeModal()">Cancel</button>
</div></div></div>
<div class="toast" id="toast">✅ Saved!</div>

<script>
let allData={};let products=[];let allChats=[];let selectedChats=new Set();let filteredChats=[];

async function loadData(){
    try{const r=await fetch('/api/data');allData=await r.json();products=JSON.parse(JSON.stringify(allData.products||[]));renderAll();}
    catch(e){console.error(e);}
}

function renderAll(){
    const badge=document.getElementById('botBadge');
    badge.className='bot-badge '+(allData.botStatus==='connected'?'badge-live':'badge-off');
    badge.textContent=allData.botStatus==='connected'?'🟢 Bot Live':'🔴 '+allData.botStatus;
    const s=allData.stats||{};
    document.getElementById('statsGrid').innerHTML=\`
    <div class="stat-card" style="border-top:3px solid #f39c12"><h2 style="color:#f39c12">\${s.pending||0}</h2><p>⏳ Pending</p></div>
    <div class="stat-card" style="border-top:3px solid #25D366"><h2 style="color:#25D366">\${s.approved||0}</h2><p>✅ Approved</p></div>
    <div class="stat-card" style="border-top:3px solid #e74c3c"><h2 style="color:#e74c3c">\${s.rejected||0}</h2><p>❌ Rejected</p></div>
    <div class="stat-card" style="border-top:3px solid #3498db"><h2 style="color:#3498db">\${s.existingChats||0}</h2><p>📱 Chats</p></div>\`;
    document.getElementById('revenue').textContent='PKR '+(s.revenue||0).toLocaleString();
    document.getElementById('revenueDetail').textContent=(s.approved||0)+' orders approved';
    renderOrders();renderBcHistory();renderCustomers();renderProducts();renderPayment();renderPrompt();renderSettings();
}

function orderCard(o){
    const time=new Date(o.timestamp).toLocaleString('en-PK');
    const bc=o.status==='pending'?'bp':o.status==='approved'?'ba':'br';
    const lb=o.language?'<span style="background:#333;padding:2px 8px;border-radius:10px;font-size:11px;color:#aaa;">'+o.language+'</span>':'';
    const acts=o.status==='pending'?\`<button class="btn btn-green" onclick="approveOrder(\${o.orderId})">✅ Approve</button><button class="btn btn-red" onclick="rejectOrder(\${o.orderId})">❌ Reject</button><button class="btn btn-blue" onclick="openMsg('\${o.customerJid}')">💬 Message</button>\`:\`<button class="btn btn-blue" onclick="openMsg('\${o.customerJid}')">💬 Message</button>\`;
    return \`<div class="order-card \${o.status}"><div class="order-header"><span class="order-id">#\${o.orderId}</span><div style="display:flex;gap:6px;">\${lb}<span class="badge \${bc}">\${o.status.toUpperCase()}</span></div></div><div class="order-info">📱 Number: <b>\${o.customerNumber}</b><br>👤 Name: <b>\${o.customerName||'N/A'}</b><br>📸 Screenshot: <b>\${o.hasScreenshot?'✅ Received':'❌ Pending'}</b><br>📅 Time: <b>\${time}</b></div><div class="btn-row">\${acts}</div></div>\`;
}

function renderOrders(){
    const orders=Object.values(allData.orders||{}).sort((a,b)=>b.timestamp-a.timestamp);
    const p=orders.filter(o=>o.status==='pending');const a=orders.filter(o=>o.status==='approved');const r=orders.filter(o=>o.status==='rejected');
    document.getElementById('pendingOrders').innerHTML=p.length===0?'<div class="empty">Koi pending order nahi ✅</div>':p.map(orderCard).join('');
    document.getElementById('approvedOrders').innerHTML=a.length===0?'<div class="empty">Koi approved order nahi</div>':a.map(orderCard).join('');
    document.getElementById('rejectedOrders').innerHTML=r.length===0?'<div class="empty">Koi rejected order nahi</div>':r.map(orderCard).join('');
}

async function approveOrder(id){if(!confirm('Approve?'))return;await fetch('/api/approve/'+id,{method:'POST'});showToast('✅ Approved!');loadData();}
async function rejectOrder(id){if(!confirm('Reject?'))return;await fetch('/api/reject/'+id,{method:'POST'});showToast('❌ Rejected!');loadData();}

async function loadChats(){
    try{const r=await fetch('/api/chats');const d=await r.json();allChats=d.chats||[];filteredChats=[...allChats];renderChats();}
    catch(e){}
}

function renderChats(){
    const cs=document.getElementById('chatStatus');const cl=document.getElementById('chatsList');
    if(allChats.length===0){cs.style.display='block';cs.textContent=allData.botStatus==='connected'?'⏳ Chats load ho rahi hain...':'❌ Bot connect karo pehle!';cl.innerHTML='';updateSelCount();return;}
    cs.style.display='none';
    cl.innerHTML=filteredChats.map(c=>\`<div class="chat-item \${selectedChats.has(c.jid)?'selected':''}" onclick="toggleChat('\${c.jid}')">
    <div class="chat-avatar">👤</div>
    <div class="chat-info"><div class="chat-name">\${c.name||c.number}</div><div class="chat-number">\${c.number}</div></div>
    <input type="checkbox" \${selectedChats.has(c.jid)?'checked':''} onclick="event.stopPropagation()"/>
    </div>\`).join('');
    updateSelCount();updateBcPreview();
}

function toggleChat(jid){if(selectedChats.has(jid))selectedChats.delete(jid);else selectedChats.add(jid);renderChats();}
function selectAll(){filteredChats.forEach(c=>selectedChats.add(c.jid));renderChats();showToast('✅ '+selectedChats.size+' selected!');}
function deselectAll(){selectedChats.clear();renderChats();}
function filterChats(){const q=document.getElementById('chatSearch').value.toLowerCase();filteredChats=allChats.filter(c=>(c.name||'').toLowerCase().includes(q)||c.number.includes(q));renderChats();}
function updateSelCount(){const el=document.getElementById('selCount');if(el)el.textContent=selectedChats.size+' selected';}
function updateBcPreview(){const d=parseInt(document.getElementById('bc_delay')?.value||5);const el=document.getElementById('bcPreview');if(el)el.innerHTML=\`📊 <b style="color:white">\${selectedChats.size}</b> contacts | Delay: <b style="color:white">\${d}s</b> | Est: <b style="color:white">\${Math.ceil(selectedChats.size*d/60)} min</b>\`;}

async function generateMsg(){
    const offer=document.getElementById('offerDetails').value;
    if(!offer.trim()){showToast('❌ Offer details likho!');return;}
    const btn=document.getElementById('genBtn');btn.textContent='⏳ Generating...';btn.disabled=true;
    const personalized=document.getElementById('msgType').value==='personalized';
    try{
        const r=await fetch('/api/generate-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({offerDetails:offer,customerName:'Dost',personalized})});
        const d=await r.json();
        if(d.success){document.getElementById('msgPreview').value=d.message;document.getElementById('generatedMsg').style.display='block';showToast('✅ Message generated!');}
    }catch(e){showToast('❌ Error!');}
    btn.textContent='🤖 AI Se Message Generate Karo';btn.disabled=false;updateBcPreview();
}

async function sendBroadcast(){
    const msg=document.getElementById('msgPreview')?.value||'';
    const offer=document.getElementById('offerDetails').value;
    const personalized=document.getElementById('msgType').value==='personalized';
    const delay=parseInt(document.getElementById('bc_delay').value)||5;
    if(!msg.trim()&&!offer.trim()){showToast('❌ Pehle message generate karo!');return;}
    if(selectedChats.size===0){showToast('❌ Contacts select karo!');return;}
    if(!confirm('📢 '+selectedChats.size+' contacts ko message bhejein?'))return;
    const contacts=allChats.filter(c=>selectedChats.has(c.jid)).map(c=>({jid:c.jid,name:c.name||c.number,number:c.number}));
    document.getElementById('bcProgress').style.display='block';
    try{
        const r=await fetch('/api/smart-broadcast',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({offerDetails:offer,baseMessage:msg,personalized,delaySeconds:delay,selectedContacts:contacts})});
        const d=await r.json();
        if(d.success){showToast('✅ Broadcast shuru! '+contacts.length+' messages jaayenge.');loadData();}
        else showToast('❌ Error: '+(d.error||''));
    }catch(e){showToast('❌ Error: '+e.message);}
}

function renderBcHistory(){
    const bcs=allData.broadcasts||[];
    document.getElementById('bcHistory').innerHTML=bcs.length===0?'<div class="empty">Koi broadcast nahi</div>':bcs.map(b=>\`<div class="order-card \${b.status==='completed'?'approved':'pending'}"><div class="order-header"><span class="order-id">\${b.status==='completed'?'✅':'⏳'} \${b.status.toUpperCase()}</span><span style="color:#aaa;font-size:12px;">\${new Date(b.createdAt).toLocaleString('en-PK')}</span></div><div class="order-info">\${(b.baseMessage||b.offerDetails||'').substring(0,80)}...<br>Sent:<b>\${b.sentCount||0}</b> Failed:<b>\${b.failedCount||0}</b> Total:<b>\${b.totalContacts||0}</b> Delay:<b>\${b.delaySeconds}s</b></div></div>\`).join('');
}

function renderCustomers(){
    const cs=Object.values(allData.customers||{}).sort((a,b)=>b.lastSeen-a.lastSeen);
    const cc=document.getElementById('custCount');if(cc)cc.textContent=cs.length+' total';
    document.getElementById('custList').innerHTML=cs.length===0?'<div class="empty">Koi customer nahi abhi</div>':cs.map(c=>\`<div style="background:#0f0f0f;border-radius:10px;padding:12px;margin-bottom:8px;border:1px solid #222;display:flex;justify-content:space-between;align-items:center;"><div><p style="font-weight:bold;color:white;">\${c.name||'Unknown'}</p><p style="color:#aaa;font-size:12px;">\${c.number} • \${c.language||'?'} • \${new Date(c.lastSeen).toLocaleDateString('en-PK')}</p></div><button class="btn btn-blue" onclick="openMsg('\${c.jid}')">💬</button></div>\`).join('');
}

function renderProducts(){
    const el=document.getElementById('productsList');
    if(!products.length){el.innerHTML='<div class="empty">Koi product nahi</div>';return;}
    el.innerHTML=products.map((p,i)=>\`<div class="product-card"><div class="product-header"><span class="product-name">\${p.name}</span><label class="toggle"><input type="checkbox" \${p.active?'checked':''} onchange="products[\${i}].active=this.checked"/><span class="slider"></span></label></div><div class="form-group"><label>Product Name</label><input value="\${p.name}" onchange="products[\${i}].name=this.value"/></div><div class="form-group"><label>Price (PKR)</label><input type="number" value="\${p.price}" onchange="products[\${i}].price=parseInt(this.value)"/></div><div class="form-group"><label>Description</label><textarea onchange="products[\${i}].description=this.value">\${p.description}</textarea></div><div class="form-group"><label>Download Link</label><input value="\${p.downloadLink||''}" placeholder="https://drive.google.com/..." onchange="products[\${i}].downloadLink=this.value"/></div><div class="form-group"><label>Features</label><div class="feature-list">\${(p.features||[]).map((f,j)=>\`<div class="feature-tag">\${f}<button onclick="removeFeature(\${i},\${j})">×</button></div>\`).join('')}</div><div class="feature-input"><input id="newFeature_\${i}" placeholder="New feature..." onkeypress="if(event.key==='Enter')addFeature(\${i})"/><button onclick="addFeature(\${i})">+ Add</button></div></div><div class="btn-row"><button class="btn btn-green" onclick="saveProducts()">💾 Save</button><button class="btn btn-red" onclick="removeProduct(\${i})">🗑️ Delete</button></div></div>\`).join('');
}

function toggleProduct(i){products[i].active=!products[i].active;}
function addFeature(i){const inp=document.getElementById('newFeature_'+i);if(!inp.value.trim())return;if(!products[i].features)products[i].features=[];products[i].features.push(inp.value.trim());inp.value='';renderProducts();}
function removeFeature(i,j){products[i].features.splice(j,1);renderProducts();}
function addProduct(){products.push({id:Date.now(),name:'New Product',price:999,description:'',features:[],downloadLink:'',active:false});renderProducts();}
function removeProduct(i){if(confirm('Delete karo?')){products.splice(i,1);renderProducts();}}
async function saveProducts(){await fetch('/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(products)});showToast('✅ Products Saved!');loadData();}

function renderPayment(){const p=allData.payment||{};document.getElementById('ep_number').value=p.easypaisa?.number||'';document.getElementById('ep_name').value=p.easypaisa?.name||'';document.getElementById('jc_number').value=p.jazzcash?.number||'';document.getElementById('jc_name').value=p.jazzcash?.name||'';document.getElementById('bank_name').value=p.bank?.bankName||'';document.getElementById('bank_acc').value=p.bank?.accountNumber||'';document.getElementById('bank_holder').value=p.bank?.accountName||'';document.getElementById('bank_iban').value=p.bank?.iban||'';}
async function savePayment(){const data={easypaisa:{number:document.getElementById('ep_number').value,name:document.getElementById('ep_name').value},jazzcash:{number:document.getElementById('jc_number').value,name:document.getElementById('jc_name').value},bank:{bankName:document.getElementById('bank_name').value,accountNumber:document.getElementById('bank_acc').value,accountName:document.getElementById('bank_holder').value,iban:document.getElementById('bank_iban').value}};await fetch('/api/payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});showToast('✅ Payment Details Saved!');}

function renderPrompt(){document.getElementById('aiPrompt').value=allData.aiPrompt||'';}
async function savePrompt(){await fetch('/api/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:document.getElementById('aiPrompt').value})});showToast('✅ AI Prompt Saved!');}

function renderSettings(){const s=allData.settings||{};document.getElementById('s_bizName').value=s.businessName||'';document.getElementById('s_adminNum').value=s.adminNumber||'';}
async function saveSettings(){const pw=document.getElementById('s_password').value;const data={businessName:document.getElementById('s_bizName').value,adminNumber:document.getElementById('s_adminNum').value,dashboardPassword:pw||allData.settings?.dashboardPassword};await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});showToast('✅ Settings Saved!');document.getElementById('s_password').value='';}

function showPage(page){
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
    const pageEl=document.getElementById('page-'+page);if(pageEl)pageEl.classList.add('active');
    const navEl=document.getElementById('nav-'+page);if(navEl)navEl.classList.add('active');
    const titles={orders:'📦 Orders',broadcast:'📢 Smart Broadcast',customers:'👥 Customers',products:'🎨 Products',payment:'💳 Payment',prompt:'🤖 AI Prompt',settings:'⚙️ Settings'};
    document.getElementById('pageTitle').textContent=titles[page]||page;
    const showStats=['orders'].includes(page);
    document.getElementById('statsGrid').style.display=showStats?'grid':'none';
    document.getElementById('revenueCard').style.display=showStats?'block':'none';
    if(page==='broadcast'&&allData.botStatus==='connected')loadChats();
}

function openMsg(jid){document.getElementById('msgJid').value=jid;document.getElementById('msgModal').classList.add('show');}
function closeModal(){document.getElementById('msgModal').classList.remove('show');}
async function sendCustomMsg(){const jid=document.getElementById('msgJid').value;const message=document.getElementById('msgText').value;if(!message.trim())return;await fetch('/api/send-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid,message})});showToast('✅ Message Sent!');closeModal();document.getElementById('msgText').value='';}

function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';setTimeout(()=>t.style.display='none',3000);}

loadData();
setInterval(loadData,15000);
setInterval(()=>{if(allData.botStatus==='connected')loadChats();},30000);
</script>
</body></html>`);
        return;
    }

    res.writeHead(302, { Location: '/dashboard' });
    res.end();
});

server.listen(process.env.PORT || 3000, () => {
    console.log('🌐 Server ready! /dashboard | /qr');
});

// ─────────────────────────────────────────
// MESSAGE HANDLER
// ─────────────────────────────────────────
async function handleMessage(sock, message) {
    try {
        if (message.key.fromMe) return;
        const senderId = message.key?.remoteJid;
        if (!senderId) return;
        if (senderId === 'status@broadcast') return;
        if (senderId.endsWith('@broadcast')) return;
        if (senderId.includes('newsletter')) return;
        if (senderId.endsWith('@g.us')) return;

        const senderName = message.pushName || 'Customer';
        const msgType = Object.keys(message.message || {})[0];

        // Save customer
        if (!botData.customers) botData.customers = {};
        botData.customers[senderId] = {
            jid: senderId,
            number: senderId.replace('@s.whatsapp.net', ''),
            name: senderName, lastSeen: Date.now(),
            language: botData.customers[senderId]?.language || 'roman_urdu'
        };

        // VOICE MESSAGE
        if (msgType === 'audioMessage' || msgType === 'pttMessage') {
            await sock.sendPresenceUpdate('composing', senderId);
            try {
                const buf = await downloadMediaMessage(message, 'buffer', {});
                const text = await voiceToText(buf);
                if (text && text.trim()) {
                    const lang = detectLang(text);
                    botData.customers[senderId].language = lang;
                    await saveData();
                    const ai = await getAISalesResponse(text, senderId, senderName, lang);
                    await sock.sendPresenceUpdate('paused', senderId);
                    const prefix = { urdu: `🎤 آپ نے کہا: "${text}"\n\n`, roman_urdu: `🎤 Aap ne kaha: "${text}"\n\n`, english: `🎤 You said: "${text}"\n\n` };
                    await sock.sendMessage(senderId, { text: (prefix[lang] || prefix.roman_urdu) + ai.message }, { quoted: message });
                    if (ai.shouldOrder) {
                        botData.orderCounter++;
                        const orderId = botData.orderCounter;
                        const product = ai.product || botData.products[0];
                        botData.orders[senderId] = { orderId, customerJid: senderId, customerNumber: senderId.replace('@s.whatsapp.net', ''), customerName: senderName, productId: product?.id, language: lang, status: 'pending', hasScreenshot: false, timestamp: Date.now() };
                        await saveData();
                        await new Promise(r => setTimeout(r, 1500));
                        await sock.sendMessage(senderId, { text: getPaymentMessage(orderId, product, lang) });
                    }
                } else {
                    await sock.sendPresenceUpdate('paused', senderId);
                    await sock.sendMessage(senderId, { text: '⚠️ Voice samajh nahi aaya. Text mein likhein please! 🙏' });
                }
            } catch (e) {
                await sock.sendPresenceUpdate('paused', senderId);
                await sock.sendMessage(senderId, { text: '⚠️ Voice error. Text likhein please!' });
            }
            return;
        }

        // IMAGE/SCREENSHOT
        if (msgType === 'imageMessage') {
            const existingOrder = Object.values(botData.orders).find(o => o.customerJid === senderId && o.status === 'pending');
            if (existingOrder) {
                existingOrder.hasScreenshot = true;
                await saveData();
                const lang = botData.customers[senderId]?.language || 'roman_urdu';
                const msgs = {
                    urdu: `📸 *اسکرین شاٹ موصول!*\n\nآرڈر *#${existingOrder.orderId}*\n✅ ایڈمن تصدیق کر رہا ہے\n⏳ 1 گھنٹے میں! 🙏`,
                    roman_urdu: `📸 *Screenshot Receive Ho Gaya!*\n\nOrder *#${existingOrder.orderId}*\n✅ Admin verify kar raha hai\n⏳ 1 hour mein themes deliver honge!\n\nShukriya! 🙏`,
                    english: `📸 *Screenshot Received!*\n\nOrder *#${existingOrder.orderId}*\n✅ Admin is verifying\n⏳ Delivery within 1 hour!\n\nThank you! 🙏`
                };
                await sock.sendMessage(senderId, { text: msgs[lang] || msgs.roman_urdu });
                const adminJid = botData.settings.adminNumber + '@s.whatsapp.net';
                try {
                    await sock.sendMessage(adminJid, { text: `🔔 *New Payment Screenshot!*\n\nOrder: *#${existingOrder.orderId}*\nCustomer: ${senderName}\nNumber: ${existingOrder.customerNumber}\n\nDashboard pe approve/reject karo! ⚡` });
                } catch (e) {}
            } else {
                const lang = botData.customers[senderId]?.language || 'roman_urdu';
                const aiReply = await getAISalesResponse('[Customer ne image bheja bina order ke]', senderId, senderName, lang);
                await sock.sendMessage(senderId, { text: aiReply.message });
            }
            return;
        }

        // TEXT MESSAGE
        const userMessage = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
        if (!userMessage.trim()) return;

        const lang = detectLang(userMessage);
        botData.customers[senderId].language = lang;
        await saveData();

        console.log(`📩 ${senderName}[${lang}]: ${userMessage}`);
        await sock.sendPresenceUpdate('composing', senderId);
        const aiReply = await getAISalesResponse(userMessage, senderId, senderName, lang);
        await sock.sendPresenceUpdate('paused', senderId);

        if (aiReply.shouldOrder) {
            botData.orderCounter++;
            const orderId = botData.orderCounter;
            const product = aiReply.product || botData.products[0];
            botData.orders[senderId] = { orderId, customerJid: senderId, customerNumber: senderId.replace('@s.whatsapp.net', ''), customerName: senderName, productId: product?.id, language: lang, status: 'pending', hasScreenshot: false, timestamp: Date.now() };
            await saveData();
            await saveToSheet({ orderId, customerName: senderName, customerNumber: senderId.replace('@s.whatsapp.net', ''), product: product?.name, amount: product?.price, status: 'pending', language: lang });
            if (aiReply.message) {
                await sock.sendMessage(senderId, { text: aiReply.message }, { quoted: message });
                await new Promise(r => setTimeout(r, 1500));
            }
            await sock.sendMessage(senderId, { text: getPaymentMessage(orderId, product, lang) });
            console.log(`🛒 New Order: #${orderId} for ${senderName}`);
        } else {
            await sock.sendMessage(senderId, { text: aiReply.message }, { quoted: message });
        }
    } catch (err) {
        console.error('Handle error:', err.message);
    }
}

// ─────────────────────────────────────────
// WHATSAPP BOT — PURANA SIMPLE LOGIC JO KAAM KARTA THA
// ─────────────────────────────────────────
async function startBot() {
    try {
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`📱 WA Version: ${version.join('.')} — Latest: ${isLatest}`);

        const { state, saveCreds } = await useMultiFileAuthState('/tmp/auth_info');

        // Global store for chats
        globalStore = makeInMemoryStore({ logger: pino({ level: 'silent' }) });

        const sock = makeWASocket({
            version, auth: state,
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

        // Store bind
        globalStore.bind(sock.ev);

        sockGlobal = sock;
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQR = qr;
                botStatus = 'qr_ready';
                console.log('✅ QR Ready! /qr pe jao scan karne ke liye!');
            }

            if (connection === 'close') {
                currentQR = null;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log('❌ Disconnected, code:', code);

                if (code === DisconnectReason.loggedOut) {
                    botStatus = 'logged_out';
                    try { fs.rmSync('/tmp/auth_info', { recursive: true, force: true }); } catch (e) {}
                    setTimeout(startBot, 5000);
                } else {
                    botStatus = 'reconnecting';
                    setTimeout(startBot, code === 405 ? 15000 : 10000);
                }
            }

            if (connection === 'open') {
                currentQR = null;
                botStatus = 'connected';
                console.log('✅ WhatsApp Connected! Mega Agency LIVE!');
                // Chats load karo background mein
                setTimeout(processChatsFromStore, 5000);
                await initSheet().catch(() => {});
            }
        });

        // Chats sync events
        sock.ev.on('chats.upsert', () => { processChatsFromStore(); });
        sock.ev.on('chats.set', () => { setTimeout(processChatsFromStore, 2000); });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const message of messages) await handleMessage(sock, message);
        });

    } catch (err) {
        console.error('Bot error:', err.message);
        setTimeout(startBot, 15000);
    }
}

console.log('🚀 Mega Agency AI Sales Bot v6 — STARTING...');
startBot();
