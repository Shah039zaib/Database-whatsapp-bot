require('dotenv').config();
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    Browsers,
    fetchLatestBaileysVersion,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const axios = require('axios');
const pino = require('pino');
const http = require('http');
const QRCode = require('qrcode');
const fs = require('fs');
const url = require('url');

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// UPSTASH REDIS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
    try {
        const r = await axios.get(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            timeout: 8000
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
        await axios.post(`${REDIS_URL}/set/${encodeURIComponent(key)}`,
            { value: JSON.stringify(value) },
            {
                headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
                timeout: 8000
            }
        );
        return true;
    } catch (e) {
        console.log('Redis SET error:', e.message);
        return false;
    }
}

async function redisDel(key) {
    try {
        await axios.delete(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            timeout: 8000
        });
        return true;
    } catch (e) {
        return false;
    }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// UPSTASH AUTH STATE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function useUpstashAuthState() {
    const CREDS_KEY = 'wa_creds_v3';
    const KEYS_KEY = 'wa_keys_v3';

    let creds = await redisGet(CREDS_KEY);
    let keys = await redisGet(KEYS_KEY) || {};

    if (!creds) {
        const { initAuthCreds } = require('@whiskeysockets/baileys');
        creds = initAuthCreds();
        await redisSet(CREDS_KEY, creds);
        console.log('ðŸ”‘ Fresh credentials created!');
    } else {
        console.log('âœ… Credentials loaded from Upstash!');
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
                        if (val) keys[`${category}-${id}`] = val;
                        else delete keys[`${category}-${id}`];
                    }
                }
                await redisSet(KEYS_KEY, keys);
            }
        }
    };

    const saveCreds = async () => {
        await redisSet(CREDS_KEY, state.creds);
    };

    return { state, saveCreds };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GOOGLE SHEETS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getGoogleToken() {
    try {
        const email = process.env.GOOGLE_CLIENT_EMAIL;
        const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
        const sheetId = process.env.GOOGLE_SHEET_ID;
        if (!email || !key || !sheetId) return null;
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({
            iss: email,
            scope: 'https://www.googleapis.com/auth/spreadsheets',
            aud: 'https://oauth2.googleapis.com/token',
            exp: now + 3600, iat: now
        })).toString('base64url');
        const crypto = require('crypto');
        const sign = crypto.createSign('RSA-SHA256');
        sign.update(`${header}.${payload}`);
        const sig = sign.sign(key, 'base64url');
        const jwt = `${header}.${payload}.${sig}`;
        const res = await axios.post('https://oauth2.googleapis.com/token', {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt
        });
        return res.data.access_token;
    } catch (e) {
        console.log('Google token error:', e.message);
        return null;
    }
}

async function saveToSheet(data) {
    try {
        const token = await getGoogleToken();
        if (!token) return;
        const sheetId = process.env.GOOGLE_SHEET_ID;
        const values = [[
            data.orderId || '', data.customerName || '', data.customerNumber || '',
            data.product || '', data.amount || '', data.status || '',
            data.language || '', new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })
        ]];
        await axios.post(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A:H:append?valueInputOption=USER_ENTERED`,
            { values }, { headers: { Authorization: `Bearer ${token}` } }
        );
        console.log('âœ… Google Sheet updated!');
    } catch (e) {
        console.log('Sheet error:', e.message);
    }
}

async function initSheet() {
    try {
        const token = await getGoogleToken();
        if (!token) return;
        const sheetId = process.env.GOOGLE_SHEET_ID;
        await axios.post(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED`,
            { values: [['Order ID', 'Customer', 'Phone', 'Product', 'Amount', 'Status', 'Language', 'Date']] },
            { headers: { Authorization: `Bearer ${token}` } }
        );
    } catch (e) {}
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// VOICE TO TEXT
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    } catch (e) {
        console.log('Voice error:', e.message);
        return null;
    }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// LANGUAGE DETECTION
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function detectLang(text) {
    if (/[\u0600-\u06FF]/.test(text)) return 'urdu';
    if (/\b(kya|hai|haan|nahi|bhai|yar|chahiye|theek|acha|karo|dedo|batao|kitna|lena|mujhe)\b/i.test(text)) return 'roman_urdu';
    return 'english';
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DEFAULT DATA
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const DATA_KEY = 'bot_data_v3';

function defaultData() {
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
            description: '100+ premium themes for all niches',
            features: ['100+ Premium Themes', 'All Niches Covered', 'Fashion, Electronics, Food & More', 'Regular Updates', '24/7 Support', 'Installation Guide', 'Mobile Optimized'],
            downloadLink: '', active: true
        }],
        aiPrompt: `Tum Mega Agency ke professional AI Sales Agent ho. Tumhara naam "Max" hai.

TUMHARI SERVICE:
- Product: 100+ Premium Shopify Themes Mega Bundle
- Price: PKR 999 ONLY â€” YEH FINAL PRICE HAI â€” KABHI KAM MAT KARO
- Delivery: Payment approve hone ke 1 hour baad
- Features: 100+ themes, all niches, regular updates, 24/7 support

LANGUAGE:
- Urdu mein baat kare â€” Urdu mein reply karo
- Roman Urdu mein â€” Roman Urdu mein reply karo
- English mein â€” English mein reply karo

KAAM:
1. Warmly greet karo
2. Niche ke baare mein poocho
3. Value explain karo
4. Price firm rakho
5. Jab customer ready ho â€” ORDER_READY likho

PRICE NEGOTIATION â€” IRON RULE:
- Discount KABHI NAHI â€” PKR 999 FINAL HAI
- "Mehenga hai" â†’ "Ek theme akeli 5000+ ki hai, 100+ sirf 999 mein â€” yeh deal nahi milegi kahin"
- "Thoda kam karo" â†’ "Bhai yeh already rock bottom price hai â€” quality se compromise nahi hoga"
- "500 mein dedo" â†’ "Impossible bhai â€” production cost hi zyada hai. 999 final hai"

SELLING:
- Value: "Market mein ek theme 5000+ ki hai, 100+ sirf PKR 999"
- Per unit: "Sirf PKR 10 per theme"
- Social proof: "1000+ Pakistani stores use kar rahe hain"
- FOMO: "Competitors already aage nikal gaye"
- ROI: "Ek sale se 999 wapas â€” theme free ho jata hai"

RULES:
- Short replies â€” 3-4 lines max
- Friendly emojis
- ORDER_READY bilkul start mein likho jab order hona ho`,
        broadcasts: [],
        orders: {},
        customers: {},
        orderCounter: 1000
    };
}

let botData = defaultData();

async function loadData() {
    try {
        const saved = await redisGet(DATA_KEY);
        if (saved) {
            botData = { ...defaultData(), ...saved };
            if (!botData.customers) botData.customers = {};
            if (!botData.broadcasts) botData.broadcasts = [];
            console.log('âœ… Bot data loaded!');
        }
    } catch (e) { console.log('Load error:', e.message); }
}

async function saveData() {
    try { await redisSet(DATA_KEY, botData); }
    catch (e) { console.log('Save error:', e.message); }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// BOT STATE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let currentQR = null;
let botStatus = 'starting';
let sockGlobal = null;
let qrRetryCount = 0;
let connectAttempts = 0;
const salesHistory = {};
const sessions = {};
let broadcastRunning = false;

function isAuth(req) {
    const cookies = req.headers.cookie || '';
    const m = cookies.match(/session=([^;]+)/);
    return m ? sessions[m[1]] === true : false;
}

async function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', c => body += c.toString());
        req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// BROADCAST
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function runBroadcast(broadcast) {
    if (!sockGlobal) return;
    broadcastRunning = true;
    const customers = Object.values(botData.customers || {});
    let sent = 0, failed = 0;
    broadcast.status = 'running';
    await saveData();

    for (const c of customers) {
        try {
            await sockGlobal.sendMessage(c.jid, { text: broadcast.message });
            sent++;
            broadcast.sentCount = sent;
            await new Promise(r => setTimeout(r, (broadcast.delaySeconds || 3) * 1000));
        } catch (e) {
            failed++;
            broadcast.failedCount = failed;
        }
    }
    broadcast.status = 'completed';
    broadcast.completedAt = Date.now();
    await saveData();
    broadcastRunning = false;
    console.log(`âœ… Broadcast done! Sent:${sent} Failed:${failed}`);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// PAYMENT MESSAGE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function paymentMsg(orderId, product, lang) {
    const p = botData.payment;
    const details = `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”
ðŸ’³ *Payment â€” PKR ${product.price}*

ðŸ“± *EasyPaisa:*
${p.easypaisa.number} | ${p.easypaisa.name}

ðŸ“± *JazzCash:*
${p.jazzcash.number} | ${p.jazzcash.name}

ðŸ¦ *Bank:*
${p.bank.bankName} | ${p.bank.accountNumber}
${p.bank.accountName} | ${p.bank.iban}
â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”`;

    if (lang === 'urdu') return `ðŸ›’ *Ø¢Ø±ÚˆØ± Ú©Ù†ÙØ±Ù…! #${orderId}*\n\n${details}\n\nâœ… Ù¾ÛŒÙ…Ù†Ù¹ Ú©Û’ Ø¨Ø¹Ø¯ Ø§Ø³Ú©Ø±ÛŒÙ† Ø´Ø§Ù¹ Ø¨Ú¾ÛŒØ¬ÛŒÚº\nâ³ 1 Ú¯Ú¾Ù†Ù¹Û’ Ù…ÛŒÚº ÚˆÙ„ÛŒÙˆØ±ÛŒ!`;
    if (lang === 'roman_urdu') return `ðŸ›’ *Order Confirm! #${orderId}*\n\n${details}\n\nâœ… Payment ke baad screenshot bhejo\nâ³ 1 ghante mein delivery!`;
    return `ðŸ›’ *Order Confirmed! #${orderId}*\n\n${details}\n\nâœ… Send screenshot after payment\nâ³ Delivery within 1 hour!`;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AI SALES RESPONSE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getAI(userMessage, userId, customerName, lang) {
    if (!salesHistory[userId]) salesHistory[userId] = [];
    salesHistory[userId].push({ role: 'user', content: userMessage });
    if (salesHistory[userId].length > 30) salesHistory[userId] = salesHistory[userId].slice(-30);

    const product = botData.products.find(p => p.active) || botData.products[0];
    const langRule = lang === 'urdu' ? 'Sirf Urdu script mein reply karo.' : lang === 'roman_urdu' ? 'Roman Urdu mein reply karo.' : 'English mein reply karo.';
    const prompt = botData.aiPrompt + `\n\n${langRule}\nCustomer: ${customerName}\nProduct: ${product.name}\nPrice: PKR ${product.price}\nYAD: Price kabhi kam nahi karo!`;

    const models = [
        { p: 'groq', m: 'llama-3.3-70b-versatile' },
        { p: 'groq', m: 'llama-3.1-8b-instant' },
        { p: 'groq', m: 'gemma2-9b-it' },
        { p: 'groq', m: 'llama3-70b-8192' },
        { p: 'openrouter', m: 'meta-llama/llama-3.1-8b-instruct:free' },
        { p: 'openrouter', m: 'google/gemma-2-9b-it:free' },
        { p: 'openrouter', m: 'mistralai/mistral-7b-instruct:free' }
    ];

    for (const { p, m } of models) {
        try {
            const apiUrl = p === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
            const headers = p === 'groq'
                ? { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }
                : { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://mega-agency.com', 'X-Title': 'Mega Agency' };

            const res = await axios.post(apiUrl, {
                model: m,
                messages: [{ role: 'system', content: prompt }, ...salesHistory[userId]],
                max_tokens: 350, temperature: 0.8
            }, { headers, timeout: 15000 });

            const msg = res.data.choices[0].message.content;
            salesHistory[userId].push({ role: 'assistant', content: msg });
            const shouldOrder = msg.toUpperCase().includes('ORDER_READY');
            console.log(`âœ… AI: ${p}/${m} | ${lang}`);
            return { message: msg.replace(/ORDER_READY/gi, '').trim(), shouldOrder, product };
        } catch (e) {
            console.log(`âŒ ${p}/${m} fail`);
            if (salesHistory[userId].length > 0) salesHistory[userId].pop();
        }
    }

    const fb = { urdu: 'âš ï¸ ØªÚ©Ù†ÛŒÚ©ÛŒ Ù…Ø³Ø¦Ù„Û ÛÛ’Û” 1 Ù…Ù†Ù¹ Ø¨Ø¹Ø¯ Ú©ÙˆØ´Ø´ Ú©Ø±ÛŒÚº! ðŸ™', roman_urdu: 'âš ï¸ Thodi problem hai. 1 min baad try karo! ðŸ™', english: 'âš ï¸ Technical issue. Try again in 1 min! ðŸ™' };
    return { message: fb[lang] || fb.roman_urdu, shouldOrder: false, product };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ORDER HANDLER
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function handleOrder(sock, senderId, senderName, aiReply, message, lang) {
    botData.orderCounter++;
    const orderId = botData.orderCounter;
    const product = aiReply.product || botData.products[0];
    botData.orders[senderId] = {
        orderId, customerJid: senderId,
        customerNumber: senderId.replace('@s.whatsapp.net', ''),
        customerName: senderName, productId: product?.id,
        language: lang, status: 'pending',
        hasScreenshot: false, timestamp: Date.now()
    };
    await saveData();
    await saveToSheet({ orderId, customerName: senderName, customerNumber: senderId.replace('@s.whatsapp.net', ''), product: product?.name, amount: product?.price, status: 'pending', language: lang });
    if (aiReply.message) {
        await sock.sendMessage(senderId, { text: aiReply.message }, { quoted: message });
        await new Promise(r => setTimeout(r, 1500));
    }
    await sock.sendMessage(senderId, { text: paymentMsg(orderId, product, lang) });
    console.log(`ðŸ›’ Order #${orderId} â€” ${senderName} [${lang}]`);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// WEB SERVER
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    if (pathname === '/login') {
        if (req.method === 'POST') {
            const body = await parseBody(req);
            if (body.password === botData.settings.dashboardPassword) {
                const sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
                sessions[sid] = true;
                res.writeHead(200, { 'Set-Cookie': `session=${sid}; Path=/; HttpOnly`, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } else {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false }));
            }
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>Login</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#0f0f0f;color:white;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}
.box{background:#1a1a1a;padding:40px;border-radius:16px;width:90%;max-width:380px;border:1px solid #333;text-align:center;}
h1{color:#25D366;font-size:24px;margin-bottom:8px;}p{color:#aaa;font-size:13px;margin-bottom:25px;}
input{width:100%;padding:12px 15px;background:#0f0f0f;border:1px solid #333;border-radius:8px;color:white;font-size:15px;margin-bottom:15px;outline:none;}
input:focus{border-color:#25D366;}button{width:100%;padding:12px;background:#25D366;border:none;border-radius:8px;color:black;font-size:16px;font-weight:bold;cursor:pointer;}
.err{color:#e74c3c;font-size:13px;margin-top:10px;display:none;}</style></head>
<body><div class="box"><h1>ðŸª Mega Agency</h1><p>Admin Login</p>
<input type="password" id="p" placeholder="Password" onkeypress="if(event.key==='Enter')login()"/>
<button onclick="login()">ðŸ” Login</button><div class="err" id="e">âŒ Wrong password!</div></div>
<script>async function login(){const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});const d=await r.json();if(d.success)window.location='/dashboard';else document.getElementById('e').style.display='block';}</script>
</body></html>`);
        return;
    }

    if (pathname !== '/qr' && pathname !== '/login' && !isAuth(req)) {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
    }

    if (pathname === '/qr') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (botStatus === 'connected') {
            res.end(`<html><head><style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;}h2{color:#25D366;}a{color:#25D366;font-size:18px;margin-top:20px;display:block;}p{color:#aaa;}</style></head>
<body><h2>âœ… Bot Connected!</h2><p>Mega Agency Live!</p><p style="color:#25D366">âœ… Session Upstash mein save!</p><a href="/dashboard">ðŸ“Š Dashboard</a></body></html>`);
            return;
        }
        if (!currentQR) {
            res.end(`<html><head><meta http-equiv="refresh" content="3"><style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;}h2{color:#f39c12;}p{color:#aaa;}</style></head>
<body><h2>â³ QR Generate Ho Raha Hai...</h2><p>Status: ${botStatus}</p><p>Auto refresh ho raha hai...</p></body></html>`);
            return;
        }
        try {
            const qrDataURL = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
            res.end(`<html><head><meta http-equiv="refresh" content="25"><style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;padding:20px;}h2{color:#25D366;}img{border:8px solid white;border-radius:12px;width:280px;height:280px;}.s{background:#222;padding:15px;border-radius:10px;text-align:left;max-width:320px;margin-top:15px;}p{color:#aaa;}</style></head>
<body><h2>ðŸ“± WhatsApp QR</h2><img src="${qrDataURL}"/><div class="s"><p>1ï¸âƒ£ WhatsApp kholo</p><p>2ï¸âƒ£ 3 dots â†’ Linked Devices</p><p>3ï¸âƒ£ Link a Device</p><p>4ï¸âƒ£ Scan karo</p></div>
<p style="color:#25D366;margin-top:10px">âœ… Ek baar scan â€” hamesha ke liye!</p><p style="color:#f39c12">âš ï¸ 25 sec mein expire!</p></body></html>`);
        } catch (e) { res.end('<h1 style="color:red">QR Error</h1>'); }
        return;
    }

    if (pathname === '/api/data' && req.method === 'GET') {
        const ordersArr = Object.values(botData.orders || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ...botData, botStatus,
            stats: {
                pending: ordersArr.filter(o => o.status === 'pending').length,
                approved: ordersArr.filter(o => o.status === 'approved').length,
                rejected: ordersArr.filter(o => o.status === 'rejected').length,
                total: ordersArr.length,
                customers: Object.keys(botData.customers || {}).length,
                revenue: ordersArr.filter(o => o.status === 'approved').reduce((s, o) => {
                    const pr = botData.products.find(p => p.id === o.productId) || botData.products[0];
                    return s + (pr?.price || 0);
                }, 0)
            }
        }));
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
                let msg = `ðŸŽ‰ *Payment Approved!*\n\nOrder *#${order.orderId}*\nðŸ“¦ *${product.name}*\n\n`;
                if (product.downloadLink) msg += `â¬‡ï¸ *Download:*\n${product.downloadLink}\n\n`;
                msg += `Shukriya ${botData.settings.businessName}! ðŸ™`;
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
                await sockGlobal.sendMessage(order.customerJid, { text: `âŒ *Payment Verify Nahi Hui*\n\nOrder *#${order.orderId}*\nDobara screenshot bhejo ya admin se contact karo. ðŸ’ª` });
                await saveToSheet({ ...order, product: '', amount: 0, status: 'rejected' });
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

    if (pathname === '/api/broadcast' && req.method === 'POST') {
        const b = await parseBody(req);
        if (!b.message) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false })); return; }
        const bc = { id: Date.now(), message: b.message, delaySeconds: b.delaySeconds || 3, status: 'pending', sentCount: 0, failedCount: 0, totalCustomers: Object.keys(botData.customers || {}).length, createdAt: Date.now() };
        if (!botData.broadcasts) botData.broadcasts = [];
        botData.broadcasts.unshift(bc);
        if (botData.broadcasts.length > 20) botData.broadcasts = botData.broadcasts.slice(0, 20);
        await saveData();
        if (!broadcastRunning) runBroadcast(bc).catch(console.error);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, broadcast: bc })); return;
    }

    if (pathname === '/api/reset-session' && req.method === 'POST') {
        try {
            await redisDel('wa_creds_v3'); await redisDel('wa_keys_v3');
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
            setTimeout(() => process.exit(0), 1000);
        } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false })); }
        return;
    }

    if (pathname === '/logout') { res.writeHead(302, { 'Set-Cookie': 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', Location: '/login' }); res.end(); return; }

    if (pathname === '/dashboard' || pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head>
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
.card{background:#0f0f0f;border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid #222;}
.card.pending{border-left:4px solid #f39c12;}.card.approved{border-left:4px solid #25D366;}.card.rejected{border-left:4px solid #e74c3c;}
.card.running{border-left:4px solid #f39c12;}.card.completed{border-left:4px solid #25D366;}
.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.order-id{font-weight:bold;color:#25D366;}
.badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:bold;}
.bp{background:#f39c12;color:black;}.ba{background:#25D366;color:black;}.br{background:#e74c3c;color:white;}
.info{font-size:13px;color:#aaa;line-height:1.9;}.info b{color:white;}
.btn-row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
.btn{padding:7px 14px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:bold;text-decoration:none;display:inline-block;}
.btn-green{background:#25D366;color:black;}.btn-red{background:#e74c3c;color:white;}.btn-blue{background:#3498db;color:white;}.btn-gray{background:#333;color:white;}
.form-group{margin-bottom:15px;}.form-group label{display:block;color:#aaa;font-size:13px;margin-bottom:6px;}
.form-group input,.form-group textarea{width:100%;padding:10px 14px;background:#0f0f0f;border:1px solid #333;border-radius:8px;color:white;font-size:14px;outline:none;}
.form-group input:focus,.form-group textarea:focus{border-color:#25D366;}
.form-group textarea{resize:vertical;min-height:100px;font-family:'Segoe UI',sans-serif;}
.save-btn{background:#25D366;color:black;border:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;}
.product-card{background:#0f0f0f;border-radius:10px;padding:16px;margin-bottom:12px;border:1px solid #222;}
.product-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
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
.rev-card{background:linear-gradient(135deg,#1a2e1a,#1a1a2e);border-radius:12px;padding:18px;text-align:center;border:1px solid #25D36640;margin-bottom:20px;}
.rev-card h2{color:#f39c12;font-size:32px;font-weight:bold;}
.info-box{background:#1a2b1a;border:1px solid #25D36640;border-radius:8px;padding:12px 15px;margin-bottom:15px;font-size:13px;color:#25D366;}
.warn-box{background:#2b1a0d;border:1px solid #f39c1240;border-radius:8px;padding:12px 15px;margin-bottom:15px;font-size:13px;color:#f39c12;}
.cust-card{background:#0f0f0f;border-radius:10px;padding:12px;margin-bottom:8px;border:1px solid #222;display:flex;justify-content:space-between;align-items:center;}
.msg-modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:#000000aa;z-index:200;align-items:center;justify-content:center;}
.msg-modal.show{display:flex;}
.msg-box{background:#1a1a1a;border-radius:16px;padding:25px;width:90%;max-width:420px;border:1px solid #333;}
.msg-box h3{margin-bottom:15px;color:white;}
.toast{position:fixed;bottom:20px;right:20px;background:#25D366;color:black;padding:12px 20px;border-radius:10px;font-weight:bold;font-size:14px;z-index:999;display:none;}
@media(max-width:768px){.sidebar{width:55px;}.sidebar-logo,.nt{display:none;}.nav-item{justify-content:center;padding:12px;}.main{margin-left:55px;padding:12px;}.stats-grid{grid-template-columns:repeat(2,1fr);}}
</style></head><body>
<div class="sidebar">
<div class="sidebar-logo"><h2>ðŸª Mega</h2><p>Admin v3</p></div>
<div class="nav-item active" onclick="showPage('orders',this)"><span>ðŸ“¦</span><span class="nt"> Orders</span></div>
<div class="nav-item" onclick="showPage('broadcast',this)"><span>ðŸ“¢</span><span class="nt"> Broadcast</span></div>
<div class="nav-item" onclick="showPage('customers',this)"><span>ðŸ‘¥</span><span class="nt"> Customers</span></div>
<div class="nav-item" onclick="showPage('products',this)"><span>ðŸŽ¨</span><span class="nt"> Products</span></div>
<div class="nav-item" onclick="showPage('payment',this)"><span>ðŸ’³</span><span class="nt"> Payment</span></div>
<div class="nav-item" onclick="showPage('prompt',this)"><span>ðŸ¤–</span><span class="nt"> AI Prompt</span></div>
<div class="nav-item" onclick="showPage('settings',this)"><span>âš™ï¸</span><span class="nt"> Settings</span></div>
<div class="nav-item" onclick="window.open('/qr','_blank')"><span>ðŸ“±</span><span class="nt"> QR</span></div>
<div class="nav-item" onclick="window.location='/logout'"><span>ðŸšª</span><span class="nt"> Logout</span></div>
</div>
<div class="main">
<div class="topbar"><h1 id="pt">ðŸ“¦ Orders</h1>
<div style="display:flex;gap:10px;align-items:center;">
<span class="bot-badge" id="bb">â³ Loading...</span>
<button class="btn btn-gray" onclick="loadData()" style="padding:6px 12px;font-size:12px;">ðŸ”„</button>
</div></div>
<div class="stats-grid" id="sg"></div>
<div class="rev-card" id="rc"><p>ðŸ’° Total Revenue</p><h2 id="rev">PKR 0</h2><p id="rd">Loading...</p></div>

<div class="page active" id="page-orders">
<div class="section"><div class="section-header"><h3>â³ Pending</h3></div><div class="section-body" id="pendingOrders"><div class="empty">Loading...</div></div></div>
<div class="section"><div class="section-header"><h3>âœ… Approved</h3></div><div class="section-body" id="approvedOrders"><div class="empty">Loading...</div></div></div>
<div class="section"><div class="section-header"><h3>âŒ Rejected</h3></div><div class="section-body" id="rejectedOrders"><div class="empty">Loading...</div></div></div>
</div>

<div class="page" id="page-broadcast">
<div class="section"><div class="section-header"><h3>ðŸ“¢ New Broadcast</h3></div><div class="section-body">
<div class="info-box">âœ… Sab registered customers ko message jayega</div>
<div class="form-group"><label>Message</label><textarea id="bc_msg" rows="6" placeholder="Broadcast message..."></textarea></div>
<div class="form-group"><label>Delay Between Messages (seconds)</label><input type="number" id="bc_delay" value="3" min="1" max="30"/></div>
<button class="save-btn" onclick="sendBroadcast()">ðŸ“¢ Send Broadcast</button>
</div></div>
<div class="section"><div class="section-header"><h3>ðŸ“‹ History</h3></div><div class="section-body" id="bcHistory"><div class="empty">Loading...</div></div></div>
</div>

<div class="page" id="page-customers">
<div class="section"><div class="section-header"><h3>ðŸ‘¥ Customers</h3><span id="cc" style="color:#aaa;font-size:13px"></span></div>
<div class="section-body" id="custList"><div class="empty">Loading...</div></div></div>
</div>

<div class="page" id="page-products">
<div class="section"><div class="section-header"><h3>ðŸŽ¨ Products</h3><button class="btn btn-green" onclick="addProduct()">+ Add</button></div>
<div class="section-body" id="prodList"></div></div>
</div>

<div class="page" id="page-payment">
<div class="section"><div class="section-header"><h3>ðŸ’³ Payment Details</h3></div><div class="section-body">
<h4 style="color:#aaa;margin-bottom:12px">ðŸ“± EasyPaisa</h4>
<div class="form-group"><label>Number</label><input id="ep_n"/></div>
<div class="form-group"><label>Name</label><input id="ep_nm"/></div>
<h4 style="color:#aaa;margin:15px 0 12px">ðŸ“± JazzCash</h4>
<div class="form-group"><label>Number</label><input id="jc_n"/></div>
<div class="form-group"><label>Name</label><input id="jc_nm"/></div>
<h4 style="color:#aaa;margin:15px 0 12px">ðŸ¦ Bank</h4>
<div class="form-group"><label>Bank Name</label><input id="bk_n"/></div>
<div class="form-group"><label>Account Number</label><input id="bk_a"/></div>
<div class="form-group"><label>Account Holder</label><input id="bk_h"/></div>
<div class="form-group"><label>IBAN</label><input id="bk_i"/></div>
<button class="save-btn" onclick="savePayment()">ðŸ’¾ Save</button>
</div></div>
</div>

<div class="page" id="page-prompt">
<div class="section"><div class="section-header"><h3>ðŸ¤– AI Prompt</h3></div><div class="section-body">
<div class="warn-box">âš ï¸ ORDER_READY zaroor rakho! Price negotiation rules strong rakho!</div>
<div class="form-group"><textarea id="aiP" rows="25" style="min-height:450px;font-size:13px;"></textarea></div>
<button class="save-btn" onclick="savePrompt()">ðŸ’¾ Save</button>
</div></div>
</div>

<div class="page" id="page-settings">
<div class="section"><div class="section-header"><h3>âš™ï¸ Settings</h3></div><div class="section-body">
<div class="form-group"><label>Business Name</label><input id="s_bn"/></div>
<div class="form-group"><label>Admin Number (92XXXXXXXXXX)</label><input id="s_an"/></div>
<div class="form-group"><label>New Password</label><input id="s_pw" type="password"/></div>
<button class="save-btn" onclick="saveSettings()">ðŸ’¾ Save</button>
</div></div>
<div class="section" style="margin-top:20px"><div class="section-header"><h3>ðŸ“± WhatsApp Session</h3></div><div class="section-body">
<div class="info-box">âœ… Session Upstash mein save â€” auto reconnect!</div>
<p style="color:#aaa;font-size:13px;margin-bottom:15px">Problem ho toh reset karo.</p>
<button class="btn btn-red" onclick="resetSess()">ðŸ”„ Reset Session</button>
</div></div>
</div>
</div>

<div class="msg-modal" id="mm">
<div class="msg-box"><h3>ðŸ’¬ Message</h3><input type="hidden" id="mj"/>
<div class="form-group"><label>Message</label><textarea id="mt" rows="4" placeholder="Message likho..."></textarea></div>
<div class="btn-row"><button class="btn btn-green" onclick="sendMsg()">ðŸ“¤ Send</button><button class="btn btn-gray" onclick="closeM()">Cancel</button></div>
</div></div>
<div class="toast" id="toast"></div>

<script>
let D={};let products=[];
async function loadData(){try{const r=await fetch('/api/data');D=await r.json();products=JSON.parse(JSON.stringify(D.products||[]));renderAll();}catch(e){console.error(e);}}
function renderAll(){
const b=document.getElementById('bb');b.className='bot-badge '+(D.botStatus==='connected'?'badge-live':'badge-off');b.textContent=D.botStatus==='connected'?'ðŸŸ¢ Live':'ðŸ”´ '+D.botStatus;
const s=D.stats||{};
document.getElementById('sg').innerHTML=\`<div class="stat-card" style="border-top:3px solid #f39c12"><h2 style="color:#f39c12">\${s.pending||0}</h2><p>â³ Pending</p></div><div class="stat-card" style="border-top:3px solid #25D366"><h2 style="color:#25D366">\${s.approved||0}</h2><p>âœ… Approved</p></div><div class="stat-card" style="border-top:3px solid #e74c3c"><h2 style="color:#e74c3c">\${s.rejected||0}</h2><p>âŒ Rejected</p></div><div class="stat-card" style="border-top:3px solid #3498db"><h2 style="color:#3498db">\${s.customers||0}</h2><p>ðŸ‘¥ Customers</p></div>\`;
document.getElementById('rev').textContent='PKR '+(s.revenue||0).toLocaleString();
document.getElementById('rd').textContent=(s.approved||0)+' approved';
renderOrders();renderBC();renderCust();renderProd();renderPay();renderPrompt();renderSet();
}
function orderCard(o){const t=new Date(o.timestamp).toLocaleString('en-PK');const bc=o.status==='pending'?'bp':o.status==='approved'?'ba':'br';const lb=o.language?'<span style="background:#333;padding:2px 8px;border-radius:10px;font-size:11px;color:#aaa;">'+o.language+'</span>':'';const acts=o.status==='pending'?\`<button class="btn btn-green" onclick="approveO(\${o.orderId})">âœ… Approve</button><button class="btn btn-red" onclick="rejectO(\${o.orderId})">âŒ Reject</button><button class="btn btn-blue" onclick="openM('\${o.customerJid}')">ðŸ’¬</button>\`:\`<button class="btn btn-blue" onclick="openM('\${o.customerJid}')">ðŸ’¬ Message</button>\`;return \`<div class="card \${o.status}"><div class="card-header"><span class="order-id">#\${o.orderId}</span><div style="display:flex;gap:6px;">\${lb}<span class="badge \${bc}">\${o.status.toUpperCase()}</span></div></div><div class="info">ðŸ“± <b>\${o.customerNumber}</b> | ðŸ‘¤ <b>\${o.customerName||'N/A'}</b><br>ðŸ“¸ <b>\${o.hasScreenshot?'âœ… Received':'âŒ Pending'}</b> | ðŸ“… <b>\${t}</b></div><div class="btn-row">\${acts}</div></div>\`;}
function renderOrders(){const orders=Object.values(D.orders||{}).sort((a,b)=>b.timestamp-a.timestamp);const p=orders.filter(o=>o.status==='pending');const a=orders.filter(o=>o.status==='approved');const r=orders.filter(o=>o.status==='rejected');document.getElementById('pendingOrders').innerHTML=p.length===0?'<div class="empty">Koi pending order nahi âœ…</div>':p.map(orderCard).join('');document.getElementById('approvedOrders').innerHTML=a.length===0?'<div class="empty">Koi approved order nahi</div>':a.map(orderCard).join('');document.getElementById('rejectedOrders').innerHTML=r.length===0?'<div class="empty">Koi rejected order nahi</div>':r.map(orderCard).join('');}
async function approveO(id){if(!confirm('Approve?'))return;await fetch('/api/approve/'+id,{method:'POST'});showT('âœ… Approved!');loadData();}
async function rejectO(id){if(!confirm('Reject?'))return;await fetch('/api/reject/'+id,{method:'POST'});showT('âŒ Rejected!');loadData();}
function renderBC(){const bcs=D.broadcasts||[];document.getElementById('bcHistory').innerHTML=bcs.length===0?'<div class="empty">Koi broadcast nahi</div>':bcs.map(b=>\`<div class="card \${b.status}"><div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="font-weight:bold;color:white;">\${b.status==='completed'?'âœ…':'â³'} \${b.status.toUpperCase()}</span><span style="color:#aaa;font-size:12px;">\${new Date(b.createdAt).toLocaleString('en-PK')}</span></div><p style="color:#ccc;font-size:13px;margin-bottom:8px;">\${b.message.substring(0,100)}\${b.message.length>100?'...':''}</p><p style="color:#aaa;font-size:12px;">Sent:\${b.sentCount||0} Failed:\${b.failedCount||0} Total:\${b.totalCustomers||0} Delay:\${b.delaySeconds}s</p></div>\`).join('');}
async function sendBroadcast(){const msg=document.getElementById('bc_msg').value;const delay=parseInt(document.getElementById('bc_delay').value)||3;if(!msg.trim()){showT('âŒ Message likho!');return;}if(!confirm('Broadcast bhejein '+Object.keys(D.customers||{}).length+' customers ko?'))return;const r=await fetch('/api/broadcast',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg,delaySeconds:delay})});const d=await r.json();if(d.success){showT('âœ… Broadcast shuru!');document.getElementById('bc_msg').value='';loadData();}else showT('âŒ Error!');}
function renderCust(){const cs=Object.values(D.customers||{}).sort((a,b)=>b.lastSeen-a.lastSeen);const cc=document.getElementById('cc');if(cc)cc.textContent=cs.length+' total';document.getElementById('custList').innerHTML=cs.length===0?'<div class="empty">Koi customer nahi</div>':cs.map(c=>\`<div class="cust-card"><div><p style="font-weight:bold;color:white;">\${c.name||'Unknown'}</p><p style="color:#aaa;font-size:12px;">\${c.number} â€¢ \${c.language||'?'} â€¢ \${new Date(c.lastSeen).toLocaleDateString('en-PK')}</p></div><button class="btn btn-blue" onclick="openM('\${c.jid}')">ðŸ’¬</button></div>\`).join('');}
function renderProd(){const el=document.getElementById('prodList');if(!products.length){el.innerHTML='<div class="empty">Koi product nahi</div>';return;}el.innerHTML=products.map((p,i)=>\`<div class="product-card"><div class="product-header"><span style="font-size:15px;font-weight:bold;color:white;">\${p.name}</span><label class="toggle"><input type="checkbox" \${p.active?'checked':''} onchange="products[\${i}].active=this.checked"/><span class="slider"></span></label></div><div class="form-group"><label>Name</label><input value="\${p.name}" onchange="products[\${i}].name=this.value"/></div><div class="form-group"><label>Price (PKR)</label><input type="number" value="\${p.price}" onchange="products[\${i}].price=parseInt(this.value)||0"/></div><div class="form-group"><label>Description</label><textarea onchange="products[\${i}].description=this.value">\${p.description||''}</textarea></div><div class="form-group"><label>â¬‡ï¸ Download Link</label><input value="\${p.downloadLink||''}" placeholder="https://drive.google.com/..." onchange="products[\${i}].downloadLink=this.value"/></div><div class="form-group"><label>Features</label><div class="feature-list">\${(p.features||[]).map((f,j)=>\`<div class="feature-tag">\${f}<button onclick="rmF(\${i},\${j})">Ã—</button></div>\`).join('')}</div><div class="feature-input"><input id="nf\${i}" placeholder="New feature..." onkeypress="if(event.key==='Enter')addF(\${i})"/><button onclick="addF(\${i})">+</button></div></div><div class="btn-row"><button class="btn btn-green" onclick="saveProd()">ðŸ’¾ Save</button><button class="btn btn-red" onclick="rmP(\${i})">ðŸ—‘ï¸ Delete</button></div></div>\`).join('');}
function addF(i){const inp=document.getElementById('nf'+i);if(!inp.value.trim())return;if(!products[i].features)products[i].features=[];products[i].features.push(inp.value.trim());inp.value='';renderProd();}
function rmF(i,j){products[i].features.splice(j,1);renderProd();}
function addProduct(){products.push({id:Date.now(),name:'New Product',price:999,description:'',features:[],downloadLink:'',active:false});renderProd();}
function rmP(i){if(confirm('Delete?')){products.splice(i,1);renderProd();}}
async function saveProd(){const r=await fetch('/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(products)});const d=await r.json();showT(d.success?'âœ… Saved!':'âŒ Error!');loadData();}
function renderPay(){const p=D.payment||{};document.getElementById('ep_n').value=p.easypaisa?.number||'';document.getElementById('ep_nm').value=p.easypaisa?.name||'';document.getElementById('jc_n').value=p.jazzcash?.number||'';document.getElementById('jc_nm').value=p.jazzcash?.name||'';document.getElementById('bk_n').value=p.bank?.bankName||'';document.getElementById('bk_a').value=p.bank?.accountNumber||'';document.getElementById('bk_h').value=p.bank?.accountName||'';document.getElementById('bk_i').value=p.bank?.iban||'';}
async function savePayment(){const d={easypaisa:{number:document.getElementById('ep_n').value,name:document.getElementById('ep_nm').value},jazzcash:{number:document.getElementById('jc_n').value,name:document.getElementById('jc_nm').value},bank:{bankName:document.getElementById('bk_n').value,accountNumber:document.getElementById('bk_a').value,accountName:document.getElementById('bk_h').value,iban:document.getElementById('bk_i').value}};const r=await fetch('/api/payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const x=await r.json();showT(x.success?'âœ… Payment Saved!':'âŒ Error!');}
function renderPrompt(){document.getElementById('aiP').value=D.aiPrompt||'';}
async function savePrompt(){const r=await fetch('/api/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:document.getElementById('aiP').value})});const d=await r.json();showT(d.success?'âœ… Prompt Saved!':'âŒ Error!');}
function renderSet(){const s=D.settings||{};document.getElementById('s_bn').value=s.businessName||'';document.getElementById('s_an').value=s.adminNumber||'';}
async function saveSettings(){const pw=document.getElementById('s_pw').value;const d={businessName:document.getElementById('s_bn').value,adminNumber:document.getElementById('s_an').value};if(pw)d.dashboardPassword=pw;const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const x=await r.json();showT(x.success?'âœ… Saved!':'âŒ Error!');document.getElementById('s_pw').value='';}
async function resetSess(){if(!confirm('Session reset? Naya QR scan karna hoga!'))return;await fetch('/api/reset-session',{method:'POST'});showT('ðŸ”„ Resetting...');setTimeout(()=>window.location='/qr',3000);}
function showPage(p,el){document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));document.getElementById('page-'+p).classList.add('active');if(el)el.classList.add('active');const titles={orders:'ðŸ“¦ Orders',broadcast:'ðŸ“¢ Broadcast',customers:'ðŸ‘¥ Customers',products:'ðŸŽ¨ Products',payment:'ðŸ’³ Payment',prompt:'ðŸ¤– AI Prompt',settings:'âš™ï¸ Settings'};document.getElementById('pt').textContent=titles[p]||p;const ss=['orders'].includes(p);document.getElementById('sg').style.display=ss?'grid':'none';document.getElementById('rc').style.display=ss?'block':'none';}
function openM(jid){document.getElementById('mj').value=jid;document.getElementById('mm').classList.add('show');}
function closeM(){document.getElementById('mm').classList.remove('show');}
async function sendMsg(){const jid=document.getElementById('mj').value;const msg=document.getElementById('mt').value;if(!msg.trim())return;const r=await fetch('/api/send-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid,message:msg})});const d=await r.json();showT(d.success?'âœ… Sent!':'âŒ Error!');if(d.success){closeM();document.getElementById('mt').value='';}}
function showT(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';setTimeout(()=>t.style.display='none',3000);}
loadData();setInterval(loadData,15000);
</script></body></html>`);
        return;
    }

    res.writeHead(302, { Location: '/dashboard' });
    res.end();
});

server.listen(process.env.PORT || 3000, () => {
    console.log('ðŸŒ Server ready! /dashboard | /qr');
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// MESSAGE HANDLER
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
            jid: senderId, number: senderId.replace('@s.whatsapp.net', ''),
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
                    const ai = await getAI(text, senderId, senderName, lang);
                    await sock.sendPresenceUpdate('paused', senderId);
                    const prefix = { urdu: `ðŸŽ¤ Ø¢Ù¾ Ù†Û’ Ú©ÛØ§: "${text}"\n\n`, roman_urdu: `ðŸŽ¤ Aap ne kaha: "${text}"\n\n`, english: `ðŸŽ¤ You said: "${text}"\n\n` };
                    await sock.sendMessage(senderId, { text: (prefix[lang] || prefix.roman_urdu) + ai.message }, { quoted: message });
                    if (ai.shouldOrder) await handleOrder(sock, senderId, senderName, ai, message, lang);
                } else {
                    await sock.sendPresenceUpdate('paused', senderId);
                    await sock.sendMessage(senderId, { text: 'âš ï¸ Voice samajh nahi aaya. Text mein likhein please! ðŸ™' });
                }
            } catch (e) {
                await sock.sendPresenceUpdate('paused', senderId);
                await sock.sendMessage(senderId, { text: 'âš ï¸ Voice error. Text mein likhein please!' });
            }
            return;
        }

        // IMAGE/SCREENSHOT
        if (msgType === 'imageMessage') {
            const order = Object.values(botData.orders).find(o => o.customerJid === senderId && o.status === 'pending');
            if (order) {
                order.hasScreenshot = true; await saveData();
                const lang = botData.customers[senderId]?.language || 'roman_urdu';
                const msgs = { urdu: `ðŸ“¸ Ø§Ø³Ú©Ø±ÛŒÙ† Ø´Ø§Ù¹ Ù…ÙˆØµÙˆÙ„!\nØ¢Ø±ÚˆØ± #${order.orderId}\nâœ… Ø§ÛŒÚˆÙ…Ù† ØªØµØ¯ÛŒÙ‚ Ú©Ø± Ø±ÛØ§ ÛÛ’\nâ³ 1 Ú¯Ú¾Ù†Ù¹Û’ Ù…ÛŒÚº ÚˆÙ„ÛŒÙˆØ±ÛŒ! ðŸ™`, roman_urdu: `ðŸ“¸ Screenshot Receive!\nOrder #${order.orderId}\nâœ… Admin verify kar raha hai\nâ³ 1 ghante mein delivery! ðŸ™`, english: `ðŸ“¸ Screenshot Received!\nOrder #${order.orderId}\nâœ… Admin verifying\nâ³ Delivery in 1 hour! ðŸ™` };
                await sock.sendMessage(senderId, { text: msgs[lang] || msgs.roman_urdu });
                try { await sock.sendMessage(botData.settings.adminNumber + '@s.whatsapp.net', { text: `ðŸ”” New Screenshot!\nOrder #${order.orderId}\n${senderName} | ${order.customerNumber}\nDashboard pe approve karo! âš¡` }); } catch (e) {}
            } else {
                const lang = botData.customers[senderId]?.language || 'roman_urdu';
                const ai = await getAI('[image bheja bina order ke]', senderId, senderName, lang);
                await sock.sendMessage(senderId, { text: ai.message });
            }
            return;
        }

        // TEXT
        const userMessage = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
        if (!userMessage.trim()) return;

        const lang = detectLang(userMessage);
        botData.customers[senderId].language = lang;
        await saveData();

        console.log(`ðŸ“© ${senderName}[${lang}]: ${userMessage}`);
        await sock.sendPresenceUpdate('composing', senderId);
        const ai = await getAI(userMessage, senderId, senderName, lang);
        await sock.sendPresenceUpdate('paused', senderId);

        if (ai.shouldOrder) await handleOrder(sock, senderId, senderName, ai, message, lang);
        else await sock.sendMessage(senderId, { text: ai.message }, { quoted: message });

    } catch (e) { console.error('Handle error:', e.message); }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// WHATSAPP BOT â€” STRONG LOGIC
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function startBot() {
    try {
        console.log(`ðŸ”„ Start attempt #${++connectAttempts}`);
        await loadData();

        const { state, saveCreds } = await useUpstashAuthState();
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`ðŸ“± WA v${version.join('.')} Latest:${isLatest}`);

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

        sockGlobal = sock;
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQR = qr;
                botStatus = 'qr_ready';
                qrRetryCount++;
                console.log(`ðŸ“± QR Ready! (Attempt #${qrRetryCount}) /qr pe jao!`);
            }

            if (connection === 'close') {
                currentQR = null;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log(`âŒ Disconnected code:${code} attempt:${connectAttempts}`);

                if (code === DisconnectReason.loggedOut) {
                    // Permanently logged out â€” clear everything
                    botStatus = 'logged_out';
                    console.log('ðŸšª Logged out â€” clearing session...');
                    try { await redisDel('wa_creds_v3'); await redisDel('wa_keys_v3'); } catch (e) {}
                    qrRetryCount = 0;
                    setTimeout(startBot, 5000);

                } else if (!code || code === undefined) {
                    // Unknown disconnect â€” DO NOT clear credentials
                    // Just reconnect and show QR if needed
                    botStatus = 'reconnecting';
                    const delay = Math.min(connectAttempts * 3000, 15000);
                    console.log(`âš ï¸ Unknown disconnect â€” retry in ${delay/1000}s`);
                    setTimeout(startBot, delay);

                } else if (code === 405) {
                    // IP block â€” wait longer
                    botStatus = 'reconnecting';
                    console.log('âš ï¸ 405 IP block â€” 30s mein retry...');
                    setTimeout(startBot, 30000);

                } else if (code === 408 || code === 503) {
                    // Timeout/Service unavailable
                    botStatus = 'reconnecting';
                    setTimeout(startBot, 10000);

                } else {
                    botStatus = 'reconnecting';
                    setTimeout(startBot, 8000);
                }
            }

            if (connection === 'open') {
                currentQR = null;
                botStatus = 'connected';
                connectAttempts = 0;
                qrRetryCount = 0;
                console.log('âœ… WhatsApp Connected! Mega Agency LIVE!');
                console.log('ðŸ’¾ Session Upstash mein save â€” next restart pe auto connect!');
                await initSheet().catch(() => {});
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) await handleMessage(sock, msg);
        });

    } catch (err) {
        console.error('Bot error:', err.message);
        botStatus = 'error';
        setTimeout(startBot, 15000);
    }
}

console.log('ðŸš€ Mega Agency AI Sales Bot v3 â€” STARTING...');
startBot();
