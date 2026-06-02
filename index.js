require('dotenv').config();
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    Browsers,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    makeInMemoryStore,
    proto
} = require('@whiskeysockets/baileys');
const axios = require('axios');
const pino = require('pino');
const http = require('http');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const os = require('os');

// ─────────────────────────────────────────
// LOGGING SYSTEM WITH LEVELS
// ─────────────────────────────────────────
const LOG_LEVEL = {
    SILENT: 0,
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4
};
const CURRENT_LOG_LEVEL = LOG_LEVEL.INFO; // Only show ERROR, WARN, INFO (no DEBUG logs)

function logBot(level, message) {
    if (level > CURRENT_LOG_LEVEL) return;
    const prefix = level === LOG_LEVEL.ERROR ? '❌' : level === LOG_LEVEL.WARN ? '⚠️' : '✅';
    console.log(`${prefix} ${message}`);
}

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
        if (r.data.result === null || r.data.result === undefined) return null;
        return JSON.parse(r.data.result);
    } catch (e) { console.log('redisGet error:', e.message); return null; }
}

async function redisSet(key, value) {
    try {
        await axios.post(
            `${REDIS_URL}/set/${encodeURIComponent(key)}`,
            JSON.stringify(value), // body IS the value
            { headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 8000 }
        );
        return true;
    } catch (e) { console.log('redisSet error:', e.message); return false; }
}

// ─────────────────────────────────────────
// AUTH BACKUP / RESTORE
// ─────────────────────────────────────────
const AUTH_DIR = path.join(os.tmpdir(), 'auth_info');
const AUTH_KEY = 'wa_auth_v3';

async function backupAuthToRedis() {
    try {
        if (!fs.existsSync(AUTH_DIR)) return;
        const files = fs.readdirSync(AUTH_DIR);
        if (!files.length) return;
        const authData = {};
        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(AUTH_DIR, file), 'utf8');
                authData[file] = content;
            } catch (e) { }
        }
        const zlib = require('zlib');
        const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(authData), 'utf8')).toString('base64');
        await redisSet(AUTH_KEY, compressed);
        console.log(`✅ Auth backed up! (${Object.keys(authData).length} files, ~${Math.round(compressed.length / 1024)}KB)`);
    } catch (e) { console.log('Auth backup error:', e.message); }
}

async function restoreAuthFromRedis() {
    try {
        const payload = await redisGet(AUTH_KEY);
        console.log('Restore payload type:', typeof payload, 'len:', payload ? String(payload).length : 0);
        if (!payload) {
            console.log('ℹ️ No auth backup — fresh QR needed');
            return false;
        }
        let authData;
        if (typeof payload === 'object' && !Array.isArray(payload)) {
            authData = payload; // legacy structure fallback
        } else if (typeof payload === 'string') {
            const zlib = require('zlib');
            const uncompressed = zlib.gunzipSync(Buffer.from(payload, 'base64')).toString('utf8');
            authData = JSON.parse(uncompressed);
        } else {
            return false;
        }

        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
        for (const [file, content] of Object.entries(authData)) {
            if (typeof content === 'string') fs.writeFileSync(path.join(AUTH_DIR, file), content, 'utf8');
        }
        console.log(`✅ Auth restored from Redis! (${Object.keys(authData).length} files)`);
        return true;
    } catch (e) {
        console.log('Auth restore error:', e.message);
        return false;
    }
}

async function clearAllAuth() {
    await redisSet(AUTH_KEY, {});
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) { }
    console.log('🗑️ Auth cleared!');
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
        try {
            const check = await axios.get(
                `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            if (check.data.values && check.data.values.length > 0) return;
        } catch (e) { }
        await axios.post(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED`,
            { values: [['Order ID', 'Customer', 'Phone', 'Product', 'Amount', 'Status', 'Language', 'Date']] },
            { headers: { Authorization: `Bearer ${token}` } }
        );
    } catch (e) { }
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
const DATA_FILE = path.join(os.tmpdir(), 'bot_data_v6.json');

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
        aiPrompt: `Tum Mega Agency ke professional AI Sales Agent ho. Tumhara naam "Max" hai.\n\nTUMHARI SERVICE:\n- Product: 100+ Premium Shopify Themes Mega Bundle\n- Price: PKR 999 ONLY (yahi final price hai)\n- Delivery: Payment approve hone ke 1 hour baad\n- Features: 100+ themes, fashion/electronics/food/all niches, regular updates, installation guide, 24/7 support\n\nLANGUAGE: Customer ki language follow karo (Urdu/Roman Urdu/English)\n\nTUMHARA KAAM:\n1. Customer se warmly greet karo\n2. Unke niche ke baare mein poocho\n3. Value explain karo specifically\n4. Price objections confidently handle karo\n5. Jab customer BUY karna chahe — ORDER_READY likho\n\nPRICE NEGOTIATION — IRON RULE:\n- Discount KABHI NAHI — PKR 999 FINAL HAI\n- "Mehenga hai" -> "Ek theme 5000+ ki, 100+ sirf 999 — PKR 10 per theme!"\n- "Kam karo" -> "Bhai yeh already lowest — quality se compromise nahi hoga"\n\nSELLING:\n- Value: "Market mein ek theme 5000+ ki hai, 100+ sirf PKR 999"\n- Per unit: "Sirf PKR 10 per theme"\n- FOMO: "Competitors already use kar rahe hain"\n- ROI: "Ek sale se 999 wapas"\n\nRULES:\n- Short replies — 3-4 lines max\n- Friendly emojis\n- ORDER_READY bilkul start mein jab order ho`,
        broadcasts: [],
        orders: {},
        customers: {},
        orderCounter: 1000
    };
}

let botData = getDefaultData();

async function loadData() {
    try {
        const saved = await redisGet(DATA_KEY);
        if (saved) {
            botData = { ...getDefaultData(), ...saved };
            if (!botData.customers) botData.customers = {};
            if (!botData.broadcasts) botData.broadcasts = [];
            console.log('✅ Data loaded from Upstash!');
            return;
        }
        if (fs.existsSync(DATA_FILE)) {
            const saved2 = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            botData = { ...getDefaultData(), ...saved2 };
            if (!botData.customers) botData.customers = {};
            if (!botData.broadcasts) botData.broadcasts = [];
            console.log('✅ Data loaded from local file!');
        }
    } catch (e) { console.log('Load error:', e.message); }
}

async function saveData() {
    try {
        await redisSet(DATA_KEY, botData);
        fs.writeFileSync(DATA_FILE, JSON.stringify(botData, null, 2));
    } catch (e) { console.log('Save error:', e.message); }
}

// ─────────────────────────────────────────
// BOT STATE
// ─────────────────────────────────────────
let currentQR = null;
let botStatus = 'starting';
let sockGlobal = null;
const salesHistory = {};
const sessions = {};
let broadcastRunning = false;
let broadcastCancelled = false;
let existingChats = [];
let chatsLoaded = false;
let globalStore = null;
let botRestartCount = 0;
let lastQRTime = 0;  // Track last QR time to prevent excessive reloading
let qrRetryCount = 0;  // Track consecutive QR attempts

function isAuthenticated(req) {
    const cookies = req.headers.cookie || '';
    const sessionMatch = cookies.match(/session=([^;]+)/);
    if (!sessionMatch) return false;
    const session = sessions[sessionMatch[1]];
    if (!session) return false;
    if (Date.now() - session.created > 24 * 60 * 60 * 1000) {
        delete sessions[sessionMatch[1]];
        return false;
    }
    return true;
}

async function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        const maxSize = 1024 * 1024;
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > maxSize) { req.destroy(); resolve({}); }
        });
        req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
}

// ─────────────────────────────────────────
// CHATS — SIRF CUSTOMERS (MY CONTACTS NAHI)
// ─────────────────────────────────────────
function processChatsFromStore() {
    try {
        const newChats = [];
        const addedJids = new Set();
        const adminNumber = botData.settings?.adminNumber || process.env.ADMIN_NUMBER || '';
        const adminJid = adminNumber ? adminNumber + '@s.whatsapp.net' : '';

        if (globalStore) {
            const chats = globalStore.chats.all();
            for (const chat of chats) {
                if (!chat.id) continue;
                if (chat.id.endsWith('@g.us')) continue;
                if (chat.id.endsWith('@broadcast')) continue;
                if (chat.id === 'status@broadcast') continue;
                if (chat.id.includes('newsletter')) continue;
                if (adminJid && chat.id === adminJid) continue;

                if (!chat.messages || chat.messages.length === 0) continue;

                const number = chat.id.replace('@s.whatsapp.net', '');
                if (number.length < 10) continue;

                addedJids.add(chat.id);
                newChats.push({
                    jid: chat.id, number,
                    name: chat.name || chat.pushName || botData.customers?.[chat.id]?.name || number,
                    lastMessage: chat.conversationTimestamp || chat.messages?.[chat.messages.length - 1]?.messageTimestamp || 0
                });
            }
        }

        for (const [jid, customer] of Object.entries(botData.customers || {})) {
            if (addedJids.has(jid)) continue;
            if (adminJid && jid === adminJid) continue;
            const number = jid.replace('@s.whatsapp.net', '');
            if (number.length < 10) continue;
            newChats.push({
                jid, number,
                name: customer.name || number,
                lastMessage: customer.lastSeen || 0
            });
        }

        newChats.sort((a, b) => b.lastMessage - a.lastMessage);
        existingChats = newChats;
        chatsLoaded = true;
        logBot(LOG_LEVEL.DEBUG, `${newChats.length} customer chats loaded!`);
    } catch (e) {
        logBot(LOG_LEVEL.ERROR, `Chat process error: ${e.message}`);
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
        } catch (e) { }
    }
    return offerDetails;
}

async function runBroadcast(broadcast) {
    if (!sockGlobal) return;
    broadcastRunning = true;
    broadcastCancelled = false;
    const targets = broadcast.selectedContacts || [];
    let sent = 0, failed = 0;
    broadcast.status = 'running';
    broadcast.sentCount = 0;
    broadcast.failedCount = 0;
    await saveData();

    for (const contact of targets) {
        if (broadcastCancelled) {
            broadcast.status = 'cancelled';
            console.log('🛑 Broadcast cancelled!');
            break;
        }
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

    if (!broadcastCancelled) broadcast.status = 'completed';
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
    const details = `━━━━━━━━━━━━━━━━━━━━\n💳 *Payment — ${botData.settings.currency} ${product.price}*\n\n📱 *EasyPaisa:*\nNumber: ${p.easypaisa.number}\nName: ${p.easypaisa.name}\n\n📱 *JazzCash:*\nNumber: ${p.jazzcash.number}\nName: ${p.jazzcash.name}\n\n🏦 *Bank Transfer:*\nBank: ${p.bank.bankName}\nAccount: ${p.bank.accountNumber}\nName: ${p.bank.accountName}\nIBAN: ${p.bank.iban}\n━━━━━━━━━━━━━━━━━━━━`;
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
        }
    }

    if (salesHistory[userId].length > 0) salesHistory[userId].pop();
    const fb = { urdu: '⚠️ تکنیکی مسئلہ — 1 منٹ بعد کوشش کریں! 🙏', roman_urdu: '⚠️ Thodi technical difficulty. 1 min mein dobara try karo! 🙏', english: '⚠️ Technical issue. Try again in 1 minute! 🙏' };
    return { message: fb[lang] || fb.roman_urdu, shouldOrder: false, product: activeProduct };
}

// ─────────────────────────────────────────
// WEB SERVER
// ─────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    try {
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = parsedUrl.pathname;
        const publicPaths = ['/login', '/qr'];

        // LOGIN
        if (pathname === '/login') {
            if (req.method === 'POST') {
                const body = await parseBody(req);
                if (body.password === botData.settings.dashboardPassword) {
                    const sessionId = crypto.randomUUID();
                    sessions[sessionId] = { created: Date.now() };
                    res.writeHead(200, { 'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; SameSite=Strict`, 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Wrong password!' }));
                }
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Login</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#0f0f0f;color:white;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}.box{background:#1a1a1a;padding:40px;border-radius:16px;width:90%;max-width:380px;border:1px solid #333;text-align:center;}h1{color:#25D366;font-size:24px;margin-bottom:8px;}p{color:#aaa;font-size:13px;margin-bottom:25px;}input{width:100%;padding:12px 15px;background:#0f0f0f;border:1px solid #333;border-radius:8px;color:white;font-size:15px;margin-bottom:15px;outline:none;}input:focus{border-color:#25D366;}button{width:100%;padding:12px;background:#25D366;border:none;border-radius:8px;color:black;font-size:16px;font-weight:bold;cursor:pointer;}button:hover{background:#1ebe57;}.err{color:#e74c3c;font-size:13px;margin-top:10px;display:none;}</style></head><body><div class="box"><h1>🏪 Mega Agency</h1><p>Admin Dashboard Login</p><input type="password" id="pass" placeholder="Password" onkeypress="if(event.key==='Enter')login()"/><button onclick="login()">🔐 Login</button><div class="err" id="err">❌ Wrong password!</div></div><script>async function login(){const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pass').value})});const d=await r.json();if(d.success)window.location='/dashboard';else document.getElementById('err').style.display='block';}</script></body></html>`);
            return;
        }

        // RESET QR — PUBLIC ENDPOINT
        if (pathname === '/api/reset-qr' && req.method === 'POST') {
            console.log('🔄 QR Reset requested...');
            await clearAllAuth();
            currentQR = null;
            botStatus = 'starting';
            if (sockGlobal) {
                try { sockGlobal.end(); sockGlobal.ws?.close(); } catch (e) { }
                sockGlobal = null;
            }
            setTimeout(() => startBot(), 3000);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Auth cleared! Naya QR aa raha hai...' }));
            return;
        }

        // AUTH CHECK
        if (!publicPaths.includes(pathname) && !isAuthenticated(req)) {
            res.writeHead(302, { Location: '/login' });
            res.end();
            return;
        }

        // QR PAGE
        if (pathname === '/qr') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            const resetScript = `<script>async function resetQr(){if(!confirm('New QR generate karein? Session delete hoga!'))return;const r=await fetch('/api/reset-qr',{method:'POST'});const d=await r.json();if(d.success){alert('✅ Auth cleared! 3 sec mein naya QR...');setTimeout(()=>location.reload(),3500);}}</script>`;

            if (botStatus === 'connected') {
                res.end(`<!DOCTYPE html><html><head><style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;gap:12px;}h2{color:#25D366;}p{color:#aaa;}a{color:#25D366;font-size:16px;text-decoration:none;}.btn{padding:10px 22px;border:none;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;margin-top:4px;}</style></head><body><h2>✅ Bot Connected!</h2><p>Mega Agency Bot live hai! 🎉</p><a href="/dashboard">📊 Dashboard Kholo</a><button class="btn" style="background:#e74c3c;color:white;" onclick="resetQr()">🔄 Naya QR Generate Karo</button>${resetScript}</body></html>`);
                return;
            }
            if (!currentQR) {
                res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3"><style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;gap:12px;}h2{color:#f39c12;}p{color:#aaa;}.btn{padding:10px 22px;border:none;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;}</style></head><body><h2>⏳ QR Generate Ho Raha Hai...</h2><p>Status: <b style="color:white">${botStatus}</b></p><p style="color:#666;">Page auto-refresh ho raha hai har 3 sec...</p><button class="btn" style="background:#e74c3c;color:white;" onclick="resetQr()">🔄 Force New QR</button>${resetScript}</body></html>`);
                return;
            }
            try {
                const qrDataURL = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
                res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="25"><style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;padding:20px;gap:10px;}h2{color:#25D366;}img{border:8px solid white;border-radius:12px;width:280px;height:280px;}.steps{background:#222;padding:15px;border-radius:10px;text-align:left;max-width:320px;}p{color:#aaa;}.btn-row{display:flex;gap:10px;justify-content:center;margin-top:5px;}.btn{padding:10px 20px;border:none;border-radius:8px;font-size:13px;font-weight:bold;cursor:pointer;}</style></head><body><h2>📱 WhatsApp QR Code</h2><img src="${qrDataURL}"/><div class="steps"><p>1️⃣ WhatsApp kholo</p><p>2️⃣ 3 dots → Linked Devices</p><p>3️⃣ Link a Device</p><p>4️⃣ QR scan karo</p></div><p style="color:#f39c12;">⚠️ 25 sec mein expire — auto-refresh hoga</p><div class="btn-row"><button class="btn" style="background:#25D366;color:black;" onclick="location.reload()">🔄 Refresh</button><button class="btn" style="background:#e74c3c;color:white;" onclick="resetQr()">🗑️ Naya QR</button></div>${resetScript}</body></html>`);
            } catch (err) { res.end('<h1 style="color:red">QR Error: ' + err.message + '</h1>'); }
            return;
        }

        // CANCEL BROADCAST
        if (pathname === '/api/cancel-broadcast' && req.method === 'POST') {
            broadcastCancelled = true;
            const runningBc = botData.broadcasts?.find(b => b.status === 'running');
            if (runningBc) { runningBc.status = 'cancelled'; await saveData(); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
        }

        // API: GET DATA
        if (pathname === '/api/data' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            const ordersArr = Object.values(botData.orders || {});
            const safeProducts = Array.isArray(botData.products) ? botData.products : [botData.products || {}];
            res.end(JSON.stringify({
                ...botData, botStatus, chatsLoaded, broadcastRunning,
                stats: {
                    pending: ordersArr.filter(o => o.status === 'pending').length,
                    approved: ordersArr.filter(o => o.status === 'approved').length,
                    rejected: ordersArr.filter(o => o.status === 'rejected').length,
                    total: ordersArr.length,
                    customers: Object.keys(botData.customers || {}).length,
                    existingChats: existingChats.length,
                    revenue: ordersArr.filter(o => o.status === 'approved').reduce((s, o) => {
                        const pr = safeProducts.find(p => p.id === o.productId) || safeProducts[0];
                        return s + (pr?.price || 0);
                    }, 0)
                }
            }));
            return;
        }

        // API: GET CHATS
        if (pathname === '/api/chats' && req.method === 'GET') {
            if (existingChats.length === 0 && Object.keys(botData.customers || {}).length > 0) {
                processChatsFromStore();
            }
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
            const bc = {
                id: Date.now(), offerDetails: body.offerDetails || '', baseMessage: body.baseMessage || '',
                personalized: body.personalized || false, delaySeconds: body.delaySeconds || 5,
                selectedContacts: body.selectedContacts, status: 'pending', sentCount: 0, failedCount: 0,
                totalContacts: body.selectedContacts.length, createdAt: Date.now()
            };
            if (!botData.broadcasts) botData.broadcasts = [];
            botData.broadcasts.unshift(bc);
            if (botData.broadcasts.length > 20) botData.broadcasts = botData.broadcasts.slice(0, 20);
            await saveData();
            if (!broadcastRunning) runBroadcast(bc).catch(console.error);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, broadcast: bc }));
            return;
        }

        if (pathname === '/api/settings' && req.method === 'POST') {
            const b = await parseBody(req);
            if (!b || typeof b !== 'object' || Array.isArray(b)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Invalid data' })); return; }
            botData.settings = { ...botData.settings, businessName: b.businessName || botData.settings.businessName, adminNumber: b.adminNumber || botData.settings.adminNumber, dashboardPassword: b.dashboardPassword || botData.settings.dashboardPassword, currency: b.currency || botData.settings.currency };
            await saveData();
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); return;
        }
        if (pathname === '/api/payment' && req.method === 'POST') {
            const b = await parseBody(req);
            if (!b || typeof b !== 'object' || Array.isArray(b)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Invalid data' })); return; }
            botData.payment = b; await saveData();
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); return;
        }
        if (pathname === '/api/products' && req.method === 'POST') {
            const b = await parseBody(req);
            if (!b || !Array.isArray(b)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Invalid data' })); return; }
            botData.products = b; await saveData();
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); return;
        }
        if (pathname === '/api/prompt' && req.method === 'POST') {
            const b = await parseBody(req);
            if (!b || typeof b.prompt !== 'string') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Invalid data' })); return; }
            botData.aiPrompt = b.prompt; await saveData();
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); return;
        }

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
                } catch (e) { }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); return;
        }

        if (pathname === '/api/send-message' && req.method === 'POST') {
            const b = await parseBody(req);
            if (sockGlobal && b.jid && b.message) {
                try {
                    await sockGlobal.sendMessage(b.jid, { text: b.message });
                    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: e.message }));
                }
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false }));
            }
            return;
        }

        if (pathname === '/logout') {
            res.writeHead(302, { 'Set-Cookie': 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', Location: '/login' });
            res.end(); return;
        }

        // MAIN DASHBOARD
        if (pathname === '/dashboard' || pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(DASHBOARD_HTML());
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));

    } catch (err) {
        console.error('Server Internal Error on ' + req.url, err.message);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
        }
    }
});

server.listen(process.env.PORT || 3000, () => {
    console.log('🚀 Server ready! /dashboard | /qr');
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

        if (!botData.customers) botData.customers = {};
        botData.customers[senderId] = {
            jid: senderId,
            number: senderId.replace('@s.whatsapp.net', ''),
            name: senderName, lastSeen: Date.now(),
            language: botData.customers[senderId]?.language || 'roman_urdu'
        };

        // VOICE
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
                        botData.orders[orderId] = { orderId, customerJid: senderId, customerNumber: senderId.replace('@s.whatsapp.net', ''), customerName: senderName, productId: product?.id, language: lang, status: 'pending', hasScreenshot: false, timestamp: Date.now() };
                        await saveData();
                        await new Promise(r => setTimeout(r, 1500));
                        await sock.sendMessage(senderId, { text: getPaymentMessage(orderId, product, lang) });
                    }
                } else {
                    await sock.sendPresenceUpdate('paused', senderId);
                    await sock.sendMessage(senderId, { text: '🎤 Voice samajh nahi aaya. Text mein likhein please! 🙏' });
                }
            } catch (e) {
                await sock.sendPresenceUpdate('paused', senderId);
                await sock.sendMessage(senderId, { text: '⚠️ Voice error. Text likhein please!' });
            }
            return;
        }

        // IMAGE / SCREENSHOT
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
                } catch (e) { }
            } else {
                const lang = botData.customers[senderId]?.language || 'roman_urdu';
                const aiReply = await getAISalesResponse('[Customer ne image bheja bina order ke]', senderId, senderName, lang);
                await sock.sendMessage(senderId, { text: aiReply.message });
            }
            return;
        }

        // TEXT
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
            botData.orders[orderId] = { orderId, customerJid: senderId, customerNumber: senderId.replace('@s.whatsapp.net', ''), customerName: senderName, productId: product?.id, language: lang, status: 'pending', hasScreenshot: false, timestamp: Date.now() };
            await saveData();
            await saveToSheet({ orderId, customerName: senderName, customerNumber: senderId.replace('@s.whatsapp.net', ''), product: product?.name, amount: product?.price, status: 'pending', language: lang });
            if (aiReply.message) {
                await sock.sendMessage(senderId, { text: aiReply.message }, { quoted: message });
                await new Promise(r => setTimeout(r, 1500));
            }
            await sock.sendMessage(senderId, { text: getPaymentMessage(orderId, product, lang) });
        } else {
            await sock.sendMessage(senderId, { text: aiReply.message }, { quoted: message });
        }
    } catch (err) {
        console.error('Handle error:', err.message);
    }
}

// ─────────────────────────────────────────
// WHATSAPP BOT — STRONG QR + REDIS AUTH
// ─────────────────────────────────────────
async function startBot() {
    try {
        botRestartCount++;
        logBot(LOG_LEVEL.INFO, `Bot start attempt #${botRestartCount}`);

        if (sockGlobal) {
            sockGlobal.isReconnecting = false;
        }

        // Restore auth from Redis before anything
        const restored = await restoreAuthFromRedis();
        if (restored) logBot(LOG_LEVEL.INFO, 'Session restored from Redis!');

        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        globalStore = makeInMemoryStore({ logger: pino({ level: 'silent' }) });

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 120000,
            defaultQueryTimeoutMs: 120000,
            keepAliveIntervalMs: 30000,
            emitOwnEvents: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            retryRequestDelayMs: 3000,
            maxMsgRetryCount: 3,
            fireInitQueries: true,
            getMessage: async () => proto.Message.fromObject({})
        });

        globalStore.bind(sock.ev);
        sockGlobal = sock;

        // Save creds locally AND backup to Redis on every update
        sock.ev.on('creds.update', async () => {
            await saveCreds();
            await backupAuthToRedis();
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                const now = Date.now();
                if (now - lastQRTime < 5000) {
                    qrRetryCount++;
                } else {
                    qrRetryCount = 1;
                }
                lastQRTime = now;

                if (qrRetryCount > 3) {
                    logBot(LOG_LEVEL.WARN, `Multiple QR attempts (${qrRetryCount}) - Please scan the new QR`);
                } else {
                    currentQR = qr;
                    botStatus = 'qr_ready';
                    logBot(LOG_LEVEL.DEBUG, `QR Ready! (attempt #${botRestartCount})`);
                }
            }

            if (connection === 'close') {
                currentQR = null;
                const code = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.message || '';
                logBot(LOG_LEVEL.WARN, `Disconnected — code: ${code} | reason: ${reason}`);

                if (sock.isReconnecting) return;
                sock.isReconnecting = true;

                if (code === DisconnectReason.loggedOut || code === 401) {
                    botStatus = 'logged_out';
                    await clearAllAuth();
                    setTimeout(startBot, 3000);
                } else if (code === 408) {
                    botStatus = 'reconnecting';
                    setTimeout(startBot, 5000);
                } else if (code === 405 || code === 428) {
                    botStatus = 'reconnecting';
                    setTimeout(startBot, 20000);
                } else if (code === 440) {
                    botStatus = 'reconnecting';
                    const delay = Math.min(3000 * botRestartCount, 15000);
                    setTimeout(startBot, delay);
                } else {
                    botStatus = 'reconnecting';
                    const delay = Math.min(5000 * botRestartCount, 30000);
                    setTimeout(startBot, delay);
                }
            }

            if (connection === 'open') {
                currentQR = null;
                botStatus = 'connected';
                botRestartCount = 0;
                qrRetryCount = 0;
                lastQRTime = 0;
                logBot(LOG_LEVEL.INFO, '✅ WhatsApp Connected! Mega Agency LIVE! 🚀');
                await backupAuthToRedis();
                setTimeout(processChatsFromStore, 5000);
                await initSheet().catch(() => { });
            }
        });

        sock.ev.on('chats.upsert', () => processChatsFromStore());
        sock.ev.on('chats.set', () => setTimeout(processChatsFromStore, 2000));

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const message of messages) await handleMessage(sock, message);
        });

    } catch (err) {
        console.error(`Bot error (attempt #${botRestartCount}):`, err.message);
        botStatus = 'error';
        const delay = Math.min(10000 * botRestartCount, 60000);
        setTimeout(startBot, delay);
    }
}

// Cleanup old salesHistory entries every 30 minutes
setInterval(() => {
    const keys = Object.keys(salesHistory);
    if (keys.length > 200) {
        keys.slice(0, keys.length - 200).forEach(k => delete salesHistory[k]);
        console.log('🧹 Cleaned old sales histories');
    }
}, 30 * 60 * 1000);

(async () => {
    console.log('🚀 Mega Agency AI Sales Bot v6 — STARTING...');
    await loadData();
    startBot();
})();
