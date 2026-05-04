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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// UPSTASH REDIS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

async function redisDel(key) {
    try {
        await axios.delete(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, timeout: 8000
        });
        return true;
    } catch (e) { return false; }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// UPSTASH AUTH STATE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function useUpstashAuthState() {
    const CREDS_KEY = 'wa_creds_v4';
    const KEYS_KEY = 'wa_keys_v4';
    let creds = await redisGet(CREDS_KEY);
    let keys = await redisGet(KEYS_KEY) || {};
    if (!creds) {
        const { initAuthCreds } = require('@whiskeysockets/baileys');
        creds = initAuthCreds();
        await redisSet(CREDS_KEY, creds);
        console.log('ðŸ”‘ Fresh credentials!');
    } else {
        console.log('âœ… Credentials loaded from Upstash!');
    }
    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) { const v = keys[`${type}-${id}`]; if (v) data[id] = v; }
                return data;
            },
            set: async (data) => {
                for (const cat of Object.keys(data)) {
                    for (const id of Object.keys(data[cat])) {
                        const v = data[cat][id];
                        if (v) keys[`${cat}-${id}`] = v;
                        else delete keys[`${cat}-${id}`];
                    }
                }
                await redisSet(KEYS_KEY, keys);
            }
        }
    };
    const saveCreds = async () => { await redisSet(CREDS_KEY, state.creds); };
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
    } catch (e) { return null; }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// LANGUAGE DETECTION
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function detectLang(text) {
    if (/[\u0600-\u06FF]/.test(text)) return 'urdu';
    if (/\b(kya|hai|haan|nahi|bhai|yar|chahiye|theek|acha|karo|dedo|batao|kitna|lena|mujhe|yrr|yaar)\b/i.test(text)) return 'roman_urdu';
    return 'english';
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DATA STORE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const DATA_KEY = 'bot_data_v4';

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
            features: ['100+ Premium Themes', 'All Niches', 'Regular Updates', '24/7 Support', 'Installation Guide'],
            downloadLink: '', active: true
        }],
        aiPrompt: `Tum Mega Agency ke professional AI Sales Agent ho. Tumhara naam "Max" hai.

TUMHARI SERVICE:
- Product: 100+ Premium Shopify Themes Bundle
- Price: PKR 999 ONLY â€” FINAL PRICE â€” KABHI KAM NAHI HOGI
- Delivery: 1 hour baad payment approve hone ke

LANGUAGE: Customer ki language follow karo (Urdu/Roman Urdu/English)

SELLING:
- Value: "Ek theme 5000+ ki, 100+ sirf 999 mein"
- Per unit: "PKR 10 per theme sirf"
- FOMO: "Competitors already use kar rahe hain"
- ROI: "Ek sale se 999 wapas"

PRICE NEGOTIATION:
- Discount KABHI NAHI â€” 999 IRON FINAL
- "Kam karo" â†’ "Already lowest â€” ek theme 5000+ ki, 100+ sirf 999"

RULES:
- Short 3-4 lines
- Friendly emojis
- ORDER_READY start mein jab order ho`,
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
        }
        console.log('âœ… Data loaded!');
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
let connectAttempts = 0;
let qrRetryCount = 0;
const salesHistory = {};
const sessions = {};
let broadcastRunning = false;
let existingChats = [];
let chatsLoaded = false;

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
// FETCH EXISTING CHATS FROM WHATSAPP
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Global store â€” startBot mein bind hoga
let globalStore = null;

function processChatsFromStore() {
    try {
        if (!globalStore) { chatsLoaded = true; return; }
        const chats = globalStore.chats.all();
        const newChats = [];
        let count = 0;

        for (const chat of chats) {
            if (!chat.id) continue;
            if (chat.id.endsWith('@g.us')) continue;
            if (chat.id.endsWith('@broadcast')) continue;
            if (chat.id === 'status@broadcast') continue;
            if (chat.id.includes('newsletter')) continue;
            const number = chat.id.replace('@s.whatsapp.net', '');
            if (number.length < 10) continue;

            newChats.push({
                jid: chat.id,
                number: number,
                name: chat.name || chat.pushName || number,
                lastMessage: chat.conversationTimestamp || 0
            });
            count++;
        }

        newChats.sort((a, b) => b.lastMessage - a.lastMessage);
        existingChats = newChats;
        chatsLoaded = true;
        console.log(`âœ… ${count} chats processed!`);
    } catch (e) {
        console.log('Chat process error:', e.message);
        chatsLoaded = true;
    }
}

async function fetchExistingChats(sock) {
    console.log('ðŸ“± Chats sync ho rahi hain...');
    chatsLoaded = false;
    existingChats = [];
    processChatsFromStore();
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AI MESSAGE GENERATOR
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function generateBroadcastMessage(offerDetails, customerName, personalized) {
    const models = [
        { p: 'groq', m: 'llama-3.3-70b-versatile' },
        { p: 'groq', m: 'llama-3.1-8b-instant' },
        { p: 'openrouter', m: 'meta-llama/llama-3.1-8b-instruct:free' }
    ];

    const prompt = personalized
        ? `Tum ek WhatsApp marketing expert ho. "${customerName}" ke liye ek short, friendly aur compelling offer message likho.
Offer Details: ${offerDetails}
Rules:
- Customer ka naam use karo naturally
- Roman Urdu mein likho
- 3-5 lines max
- Compelling aur urgent tone
- Emojis use karo
- Price clearly mention karo
- Call to action add karo`
        : `Tum ek WhatsApp marketing expert ho. Ek short, friendly aur compelling offer message likho.
Offer Details: ${offerDetails}
Rules:
- Roman Urdu mein likho
- 3-5 lines max
- Compelling aur urgent tone
- Emojis use karo
- Price clearly mention karo
- Call to action add karo`;

    for (const { p, m } of models) {
        try {
            const apiUrl = p === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
            const headers = p === 'groq'
                ? { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }
                : { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://mega-agency.com', 'X-Title': 'Mega Agency' };

            const res = await axios.post(apiUrl, {
                model: m,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 200, temperature: 0.9
            }, { headers, timeout: 15000 });

            return res.data.choices[0].message.content.trim();
        } catch (e) { console.log(`âŒ AI gen fail: ${m}`); }
    }
    return offerDetails;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// SMART BROADCAST
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function runSmartBroadcast(broadcast) {
    if (!sockGlobal) return;
    broadcastRunning = true;

    const targets = broadcast.selectedContacts || [];
    let sent = 0, failed = 0;
    broadcast.status = 'running';
    broadcast.sentCount = 0;
    broadcast.failedCount = 0;
    await saveData();

    console.log(`ðŸ“¢ Smart Broadcast: ${targets.length} contacts | personalized:${broadcast.personalized}`);

    for (const contact of targets) {
        try {
            let message = broadcast.baseMessage;

            // Personalized message generate karo
            if (broadcast.personalized && broadcast.offerDetails) {
                message = await generateBroadcastMessage(broadcast.offerDetails, contact.name || 'Dost', true);
            }

            await sockGlobal.sendMessage(contact.jid, { text: message });
            sent++;
            broadcast.sentCount = sent;
            console.log(`ðŸ“¤ Sent ${sent}/${targets.length} â†’ ${contact.name || contact.number}`);

            // Delay
            await new Promise(r => setTimeout(r, (broadcast.delaySeconds || 5) * 1000));

        } catch (e) {
            failed++;
            broadcast.failedCount = failed;
            console.log(`âŒ Failed: ${contact.number} â€” ${e.message}`);
        }
    }

    broadcast.status = 'completed';
    broadcast.completedAt = Date.now();
    await saveData();
    broadcastRunning = false;
    console.log(`âœ… Broadcast complete! Sent:${sent} Failed:${failed}`);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// PAYMENT MESSAGE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function paymentMsg(orderId, product, lang) {
    const p = botData.payment;
    const det = `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”
ðŸ’³ *Payment â€” PKR ${product.price}*
ðŸ“± EasyPaisa: ${p.easypaisa.number} | ${p.easypaisa.name}
ðŸ“± JazzCash: ${p.jazzcash.number} | ${p.jazzcash.name}
ðŸ¦ Bank: ${p.bank.bankName} | ${p.bank.accountNumber}
${p.bank.accountName} | ${p.bank.iban}
â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”`;
    if (lang === 'urdu') return `ðŸ›’ *Ø¢Ø±ÚˆØ± #${orderId}*\n\n${det}\n\nâœ… Ø§Ø³Ú©Ø±ÛŒÙ† Ø´Ø§Ù¹ Ø¨Ú¾ÛŒØ¬ÛŒÚº\nâ³ 1 Ú¯Ú¾Ù†Ù¹Û’ Ù…ÛŒÚº ÚˆÙ„ÛŒÙˆØ±ÛŒ!`;
    if (lang === 'roman_urdu') return `ðŸ›’ *Order #${orderId}*\n\n${det}\n\nâœ… Screenshot bhejo\nâ³ 1 ghante mein delivery!`;
    return `ðŸ›’ *Order #${orderId}*\n\n${det}\n\nâœ… Send screenshot\nâ³ Delivery in 1 hour!`;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AI SALES
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getAI(userMessage, userId, customerName, lang) {
    if (!salesHistory[userId]) salesHistory[userId] = [];
    salesHistory[userId].push({ role: 'user', content: userMessage });
    if (salesHistory[userId].length > 30) salesHistory[userId] = salesHistory[userId].slice(-30);

    const product = botData.products.find(p => p.active) || botData.products[0];
    const langRule = lang === 'urdu' ? 'Sirf Urdu script.' : lang === 'roman_urdu' ? 'Roman Urdu mein.' : 'English mein.';
    const prompt = botData.aiPrompt + `\n\n${langRule}\nCustomer: ${customerName}\nProduct: ${product.name}\nPrice: PKR ${product.price}`;

    const models = [
        { p: 'groq', m: 'llama-3.3-70b-versatile' },
        { p: 'groq', m: 'llama-3.1-8b-instant' },
        { p: 'groq', m: 'gemma2-9b-it' },
        { p: 'groq', m: 'llama3-70b-8192' },
        { p: 'openrouter', m: 'meta-llama/llama-3.1-8b-instruct:free' },
        { p: 'openrouter', m: 'google/gemma-2-9b-it:free' }
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
            return { message: msg.replace(/ORDER_READY/gi, '').trim(), shouldOrder: msg.toUpperCase().includes('ORDER_READY'), product };
        } catch (e) {
            if (salesHistory[userId].length > 0) salesHistory[userId].pop();
        }
    }
    const fb = { urdu: 'âš ï¸ ØªÚ©Ù†ÛŒÚ©ÛŒ Ù…Ø³Ø¦Ù„Û â€” 1 Ù…Ù†Ù¹ Ø¨Ø¹Ø¯ Ú©ÙˆØ´Ø´ Ú©Ø±ÛŒÚº! ðŸ™', roman_urdu: 'âš ï¸ Thodi problem. 1 min baad try karo! ðŸ™', english: 'âš ï¸ Technical issue. Try in 1 min! ðŸ™' };
    return { message: fb[lang] || fb.roman_urdu, shouldOrder: false, product };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ORDER HANDLER
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function handleOrder(sock, senderId, senderName, aiReply, message, lang) {
    botData.orderCounter++;
    const orderId = botData.orderCounter;
    const product = aiReply.product || botData.products[0];
    botData.orders[senderId] = { orderId, customerJid: senderId, customerNumber: senderId.replace('@s.whatsapp.net', ''), customerName: senderName, productId: product?.id, language: lang, status: 'pending', hasScreenshot: false, timestamp: Date.now() };
    await saveData();
    await saveToSheet({ orderId, customerName: senderName, customerNumber: senderId.replace('@s.whatsapp.net', ''), product: product?.name, amount: product?.price, status: 'pending', language: lang });
    if (aiReply.message) { await sock.sendMessage(senderId, { text: aiReply.message }, { quoted: message }); await new Promise(r => setTimeout(r, 1500)); }
    await sock.sendMessage(senderId, { text: paymentMsg(orderId, product, lang) });
    console.log(`ðŸ›’ Order #${orderId} â€” ${senderName}`);
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
            } else { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false })); }
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>Login</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#0f0f0f;color:white;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}.box{background:#1a1a1a;padding:40px;border-radius:16px;width:90%;max-width:380px;border:1px solid #333;text-align:center;}h1{color:#25D366;font-size:24px;margin-bottom:8px;}p{color:#aaa;font-size:13px;margin-bottom:25px;}input{width:100%;padding:12px 15px;background:#0f0f0f;border:1px solid #333;border-radius:8px;color:white;font-size:15px;margin-bottom:15px;outline:none;}input:focus{border-color:#25D366;}button{width:100%;padding:12px;background:#25D366;border:none;border-radius:8px;color:black;font-size:16px;font-weight:bold;cursor:pointer;}.err{color:#e74c3c;font-size:13px;margin-top:10px;display:none;}</style></head><body><div class="box"><h1>ðŸª Mega Agency</h1><p>Admin Login</p><input type="password" id="p" placeholder="Password" onkeypress="if(event.key==='Enter')login()"/><button onclick="login()">ðŸ” Login</button><div class="err" id="e">âŒ Wrong password!</div></div><script>async function login(){const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});const d=await r.json();if(d.success)window.location='/dashboard';else document.getElementById('e').style.display='block';}</script></body></html>`);
        return;
    }

    if (pathname !== '/qr' && pathname !== '/login' && !isAuth(req)) { res.writeHead(302, { Location: '/login' }); res.end(); return; }

    if (pathname === '/qr') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (botStatus === 'connected') { res.end(`<html><head><style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;}h2{color:#25D366;}a{color:#25D366;font-size:18px;margin-top:20px;display:block;}p{color:#aaa;}</style></head><body><h2>âœ… Connected!</h2><p>Mega Agency Live!</p><a href="/dashboard">ðŸ“Š Dashboard</a></body></html>`); return; }
        if (!currentQR) { res.end(`<html><head><meta http-equiv="refresh" content="3"><style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;}h2{color:#f39c12;}p{color:#aaa;}</style></head><body><h2>â³ QR Ho Raha Hai...</h2><p>Status: ${botStatus}</p></body></html>`); return; }
        try {
            const qrDataURL = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
            res.end(`<html><head><meta http-equiv="refresh" content="25"><style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;padding:20px;}h2{color:#25D366;}img{border:8px solid white;border-radius:12px;width:280px;height:280px;}.s{background:#222;padding:15px;border-radius:10px;text-align:left;max-width:320px;margin-top:15px;}p{color:#aaa;}</style></head><body><h2>ðŸ“± WhatsApp QR</h2><img src="${qrDataURL}"/><div class="s"><p>1ï¸âƒ£ WhatsApp kholo</p><p>2ï¸âƒ£ 3 dots â†’ Linked Devices</p><p>3ï¸âƒ£ Link a Device</p><p>4ï¸âƒ£ Scan!</p></div><p style="color:#25D366;margin-top:10px">âœ… Ek baar scan â€” hamesha!</p><p style="color:#f39c12">âš ï¸ 25 sec mein expire!</p></body></html>`);
        } catch (e) { res.end('<h1>QR Error</h1>'); }
        return;
    }

    // API: GET DATA + CHATS
    if (pathname === '/api/data' && req.method === 'GET') {
        const ordersArr = Object.values(botData.orders || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ...botData, botStatus, chatsLoaded,
            existingChatsCount: existingChats.length,
            stats: {
                pending: ordersArr.filter(o => o.status === 'pending').length,
                approved: ordersArr.filter(o => o.status === 'approved').length,
                rejected: ordersArr.filter(o => o.status === 'rejected').length,
                total: ordersArr.length,
                customers: Object.keys(botData.customers || {}).length,
                existingChats: existingChats.length,
                revenue: ordersArr.filter(o => o.status === 'approved').reduce((s, o) => { const pr = botData.products.find(p => p.id === o.productId) || botData.products[0]; return s + (pr?.price || 0); }, 0)
            }
        }));
        return;
    }

    // API: GET EXISTING CHATS
    if (pathname === '/api/chats' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ chats: existingChats, loaded: chatsLoaded, count: existingChats.length }));
        return;
    }

    // API: GENERATE AI MESSAGE
    if (pathname === '/api/generate-message' && req.method === 'POST') {
        const body = await parseBody(req);
        try {
            const msg = await generateBroadcastMessage(body.offerDetails || 'Special offer', body.customerName || 'Dost', body.personalized || false);
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
            id: Date.now(),
            offerDetails: body.offerDetails || '',
            baseMessage: body.baseMessage || '',
            personalized: body.personalized || false,
            delaySeconds: body.delaySeconds || 5,
            selectedContacts: body.selectedContacts,
            status: 'pending',
            sentCount: 0, failedCount: 0,
            totalContacts: body.selectedContacts.length,
            createdAt: Date.now()
        };
        if (!botData.broadcasts) botData.broadcasts = [];
        botData.broadcasts.unshift(bc);
        if (botData.broadcasts.length > 20) botData.broadcasts = botData.broadcasts.slice(0, 20);
        await saveData();
        if (!broadcastRunning) runSmartBroadcast(bc).catch(console.error);
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
                let msg = `ðŸŽ‰ *Payment Approved!*\n\nOrder *#${order.orderId}*\nðŸ“¦ *${product.name}*\n\n`;
                if (product.downloadLink) msg += `â¬‡ï¸ *Download:*\n${product.downloadLink}\n\n`;
                msg += `Shukriya! ðŸ™`;
                await sockGlobal.sendMessage(order.customerJid, { text: msg });
                await saveToSheet({ ...order, product: product.name, amount: product.price, status: 'approved' });
            } catch (e) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); return;
    }

    if (pathname.startsWith('/api/reject/') && req.method === 'POST') {
        const orderId = parseInt(pathname.split('/api/reject/')[1]);
        const order = Object.values(botData.orders).find(o => o.orderId === orderId);
        if (order && sockGlobal) {
            order.status = 'rejected'; await saveData();
            try { await sockGlobal.sendMessage(order.customerJid, { text: `âŒ Payment verify nahi hui. Dobara screenshot bhejo! ðŸ’ª` }); await saveToSheet({ ...order, status: 'rejected' }); } catch (e) {}
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

    if (pathname === '/api/reset-session' && req.method === 'POST') {
        try { await redisDel('wa_creds_v4'); await redisDel('wa_keys_v4'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); setTimeout(() => process.exit(0), 1000); }
        catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false })); }
        return;
    }

    if (pathname === '/logout') { res.writeHead(302, { 'Set-Cookie': 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', Location: '/login' }); res.end(); return; }

    if (pathname === '/dashboard' || pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head>
<title>Mega Agency Admin</title>
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
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:20px;}
.stat-card{background:#111;border-radius:12px;padding:16px;text-align:center;border:1px solid #222;}
.stat-card h2{font-size:26px;font-weight:bold;margin-bottom:4px;}.stat-card p{color:#666;font-size:11px;}
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
.btn-green{background:#25D366;color:black;}.btn-red{background:#e74c3c;color:white;}.btn-blue{background:#3498db;color:white;}.btn-gray{background:#333;color:white;}.btn-purple{background:#9b59b6;color:white;}.btn-orange{background:#f39c12;color:black;}
.form-group{margin-bottom:15px;}.form-group label{display:block;color:#aaa;font-size:13px;margin-bottom:6px;}
.form-group input,.form-group textarea,.form-group select{width:100%;padding:10px 14px;background:#0f0f0f;border:1px solid #333;border-radius:8px;color:white;font-size:14px;outline:none;}
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
.chat-item{background:#0f0f0f;border-radius:8px;padding:10px 14px;margin-bottom:6px;border:1px solid #222;display:flex;align-items:center;gap:10px;cursor:pointer;}
.chat-item:hover{background:#1a1a1a;}.chat-item.selected{border-color:#25D366;background:#0d2b0d;}
.chat-avatar{width:36px;height:36px;border-radius:50%;background:#25D36633;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}
.chat-info{flex:1;min-width:0;}
.chat-name{font-weight:bold;color:white;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.chat-number{color:#aaa;font-size:12px;}
.chat-checkbox{flex-shrink:0;}
.bc-controls{background:#1a1a1a;border-radius:10px;padding:15px;margin-bottom:15px;border:1px solid #333;}
.msg-modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:#000000aa;z-index:200;align-items:center;justify-content:center;}
.msg-modal.show{display:flex;}
.msg-box{background:#1a1a1a;border-radius:16px;padding:25px;width:90%;max-width:420px;border:1px solid #333;}
.msg-box h3{margin-bottom:15px;color:white;}
.toast{position:fixed;bottom:20px;right:20px;background:#25D366;color:black;padding:12px 20px;border-radius:10px;font-weight:bold;font-size:14px;z-index:999;display:none;}
.loading{text-align:center;color:#25D366;padding:20px;font-size:14px;}
.progress-bar{background:#222;border-radius:10px;height:8px;margin-top:10px;overflow:hidden;}
.progress-fill{background:#25D366;height:100%;border-radius:10px;transition:width 0.3s;}
@media(max-width:768px){.sidebar{width:55px;}.sidebar-logo,.nt{display:none;}.nav-item{justify-content:center;padding:12px;}.main{margin-left:55px;padding:12px;}.stats-grid{grid-template-columns:repeat(2,1fr);}}
</style></head><body>
<div class="sidebar">
<div class="sidebar-logo"><h2>ðŸª Mega</h2><p>Admin v4</p></div>
<div class="nav-item active" id="nav-orders" onclick="showPage('orders')"><span>ðŸ“¦</span><span class="nt"> Orders</span></div>
<div class="nav-item" id="nav-broadcast" onclick="showPage('broadcast')"><span>ðŸ“¢</span><span class="nt"> Broadcast</span></div>
<div class="nav-item" id="nav-products" onclick="showPage('products')"><span>ðŸŽ¨</span><span class="nt"> Products</span></div>
<div class="nav-item" id="nav-payment" onclick="showPage('payment')"><span>ðŸ’³</span><span class="nt"> Payment</span></div>
<div class="nav-item" id="nav-prompt" onclick="showPage('prompt')"><span>ðŸ¤–</span><span class="nt"> AI Prompt</span></div>
<div class="nav-item" id="nav-settings" onclick="showPage('settings')"><span>âš™ï¸</span><span class="nt"> Settings</span></div>
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

<!-- ORDERS -->
<div class="page active" id="page-orders">
<div class="section"><div class="section-header"><h3>â³ Pending</h3></div><div class="section-body" id="pendingOrders"><div class="empty">Loading...</div></div></div>
<div class="section"><div class="section-header"><h3>âœ… Approved</h3></div><div class="section-body" id="approvedOrders"><div class="empty">Loading...</div></div></div>
<div class="section"><div class="section-header"><h3>âŒ Rejected</h3></div><div class="section-body" id="rejectedOrders"><div class="empty">Loading...</div></div></div>
</div>

<!-- BROADCAST -->
<div class="page" id="page-broadcast">
<div class="section"><div class="section-header"><h3>ðŸ¤– AI Message Generator</h3></div><div class="section-body">
<div class="info-box">âœ… AI tumhara offer message generate karega â€” personalized ya same sab ke liye</div>
<div class="form-group"><label>Offer Details (AI ko batao kya offer hai)</label>
<textarea id="offerDetails" rows="3" placeholder="e.g. 100+ Shopify themes bundle sirf PKR 999 mein â€” limited time offer â€” buy karo abhi!"></textarea></div>
<div class="form-group"><label>Message Type</label>
<select id="msgType">
<option value="personalized">ðŸŽ¯ Personalized (har customer ke naam se)</option>
<option value="same">ðŸ“‹ Same message sab ko</option>
</select></div>
<button class="btn btn-purple" onclick="generateMsg()" id="genBtn">ðŸ¤– AI Se Message Generate Karo</button>
<div id="generatedMsg" style="display:none;margin-top:15px;">
<div class="form-group"><label>Generated Message (edit kar sakte ho)</label>
<textarea id="msgPreview" rows="6"></textarea></div>
</div>
</div></div>

<div class="section"><div class="section-header">
<h3>ðŸ“± Contacts Select Karo</h3>
<div style="display:flex;gap:8px;flex-wrap:wrap;">
<button class="btn btn-green" onclick="selectAll()" id="selAllBtn">âœ… Select All</button>
<button class="btn btn-gray" onclick="deselectAll()">âŒ Deselect All</button>
<span id="selCount" style="color:#25D366;font-size:13px;align-self:center;"></span>
</div>
</div><div class="section-body">
<div class="bc-controls">
<div class="form-group" style="margin-bottom:10px;">
<label>Delay Between Messages (seconds)</label>
<input type="number" id="bc_delay" value="5" min="1" max="60"/>
</div>
<input type="text" id="chatSearch" placeholder="ðŸ” Contact search karo..." oninput="filterChats()" style="margin-bottom:10px;"/>
</div>
<div id="chatStatus" class="loading">â³ Bot connect hone ke baad contacts load honge...</div>
<div id="chatsList"></div>
</div></div>

<div class="section"><div class="section-header"><h3>ðŸš€ Send Broadcast</h3></div><div class="section-body">
<div id="bcPreview" style="color:#aaa;font-size:13px;margin-bottom:15px;"></div>
<button class="btn btn-green" onclick="sendBroadcast()" id="sendBcBtn" style="width:100%;padding:12px;font-size:16px;">ðŸ“¢ Broadcast Bhejo</button>
<div id="bcProgress" style="display:none;margin-top:15px;">
<p style="color:#25D366;font-size:14px;" id="bcProgressText">Sending...</p>
<div class="progress-bar"><div class="progress-fill" id="bcProgressFill" style="width:0%"></div></div>
</div>
</div></div>

<div class="section"><div class="section-header"><h3>ðŸ“‹ Broadcast History</h3></div><div class="section-body" id="bcHistory"><div class="empty">Loading...</div></div></div>
</div>

<!-- PRODUCTS -->
<div class="page" id="page-products">
<div class="section"><div class="section-header"><h3>ðŸŽ¨ Products</h3><button class="btn btn-green" onclick="addProduct()">+ Add</button></div>
<div class="section-body" id="prodList"></div></div></div>

<!-- PAYMENT -->
<div class="page" id="page-payment">
<div class="section"><div class="section-header"><h3>ðŸ’³ Payment</h3></div><div class="section-body">
<h4 style="color:#aaa;margin-bottom:12px">ðŸ“± EasyPaisa</h4>
<div class="form-group"><label>Number</label><input id="ep_n"/></div>
<div class="form-group"><label>Name</label><input id="ep_nm"/></div>
<h4 style="color:#aaa;margin:15px 0 12px">ðŸ“± JazzCash</h4>
<div class="form-group"><label>Number</label><input id="jc_n"/></div>
<div class="form-group"><label>Name</label><input id="jc_nm"/></div>
<h4 style="color:#aaa;margin:15px 0 12px">ðŸ¦ Bank</h4>
<div class="form-group"><label>Bank</label><input id="bk_n"/></div>
<div class="form-group"><label>Account No</label><input id="bk_a"/></div>
<div class="form-group"><label>Account Holder</label><input id="bk_h"/></div>
<div class="form-group"><label>IBAN</label><input id="bk_i"/></div>
<button class="save-btn" onclick="savePayment()">ðŸ’¾ Save</button>
</div></div></div>

<!-- AI PROMPT -->
<div class="page" id="page-prompt">
<div class="section"><div class="section-header"><h3>ðŸ¤– AI Prompt</h3></div><div class="section-body">
<div class="warn-box">âš ï¸ ORDER_READY word zaroor rakho! Price 999 final rakho!</div>
<div class="form-group"><textarea id="aiP" rows="25" style="min-height:450px;font-size:13px;"></textarea></div>
<button class="save-btn" onclick="savePrompt()">ðŸ’¾ Save</button>
</div></div></div>

<!-- SETTINGS -->
<div class="page" id="page-settings">
<div class="section"><div class="section-header"><h3>âš™ï¸ Settings</h3></div><div class="section-body">
<div class="form-group"><label>Business Name</label><input id="s_bn"/></div>
<div class="form-group"><label>Admin Number (92XXXXXXXXXX)</label><input id="s_an"/></div>
<div class="form-group"><label>New Password</label><input id="s_pw" type="password"/></div>
<button class="save-btn" onclick="saveSettings()">ðŸ’¾ Save</button>
</div></div>
<div class="section" style="margin-top:20px"><div class="section-header"><h3>ðŸ“± Session</h3></div><div class="section-body">
<div class="info-box">âœ… Session Upstash mein save!</div>
<p style="color:#aaa;font-size:13px;margin-bottom:15px">Problem ho toh reset karo.</p>
<button class="btn btn-red" onclick="resetSess()">ðŸ”„ Reset Session</button>
</div></div></div>
</div>

<!-- Message Modal -->
<div class="msg-modal" id="mm">
<div class="msg-box"><h3>ðŸ’¬ Message</h3><input type="hidden" id="mj"/>
<div class="form-group"><label>Message</label><textarea id="mt" rows="4" placeholder="Message..."></textarea></div>
<div class="btn-row"><button class="btn btn-green" onclick="sendMsg()">ðŸ“¤ Send</button><button class="btn btn-gray" onclick="closeM()">Cancel</button></div>
</div></div>
<div class="toast" id="toast"></div>

<script>
let D={};let products=[];let allChats=[];let selectedChats=new Set();let filteredChats=[];

async function loadData(){
    try{
        const r=await fetch('/api/data');
        D=await r.json();
        products=JSON.parse(JSON.stringify(D.products||[]));
        renderAll();
        // Load chats if connected
        if(D.botStatus==='connected'){loadChats();}
    }catch(e){console.error(e);}
}

async function loadChats(){
    try{
        const r=await fetch('/api/chats');
        const d=await r.json();
        allChats=d.chats||[];
        filteredChats=[...allChats];
        renderChats();
    }catch(e){}
}

function renderAll(){
    const b=document.getElementById('bb');
    b.className='bot-badge '+(D.botStatus==='connected'?'badge-live':'badge-off');
    b.textContent=D.botStatus==='connected'?'ðŸŸ¢ Live':'ðŸ”´ '+D.botStatus;
    const s=D.stats||{};
    document.getElementById('sg').innerHTML=\`
    <div class="stat-card" style="border-top:3px solid #f39c12"><h2 style="color:#f39c12">\${s.pending||0}</h2><p>â³ Pending</p></div>
    <div class="stat-card" style="border-top:3px solid #25D366"><h2 style="color:#25D366">\${s.approved||0}</h2><p>âœ… Approved</p></div>
    <div class="stat-card" style="border-top:3px solid #e74c3c"><h2 style="color:#e74c3c">\${s.rejected||0}</h2><p>âŒ Rejected</p></div>
    <div class="stat-card" style="border-top:3px solid #3498db"><h2 style="color:#3498db">\${s.existingChats||0}</h2><p>ðŸ“± Chats</p></div>\`;
    document.getElementById('rev').textContent='PKR '+(s.revenue||0).toLocaleString();
    document.getElementById('rd').textContent=(s.approved||0)+' approved';
    renderOrders();renderBcHistory();renderProd();renderPay();renderPrompt();renderSet();
}

function renderChats(){
    const cs=document.getElementById('chatStatus');
    const cl=document.getElementById('chatsList');
    if(allChats.length===0){
        cs.style.display='block';
        cs.textContent=D.botStatus==='connected'?'â³ Chats load ho rahi hain...':'âŒ Bot connect karo pehle!';
        cl.innerHTML='';
        return;
    }
    cs.style.display='none';
    updateSelCount();
    cl.innerHTML=filteredChats.map(c=>\`
    <div class="chat-item \${selectedChats.has(c.jid)?'selected':''}" onclick="toggleChat('\${c.jid}','\${(c.name||'').replace(/'/g,'\\\\'')}','\${c.number}')">
    <div class="chat-avatar">ðŸ‘¤</div>
    <div class="chat-info">
    <div class="chat-name">\${c.name||c.number}</div>
    <div class="chat-number">\${c.number}</div>
    </div>
    <input type="checkbox" class="chat-checkbox" \${selectedChats.has(c.jid)?'checked':''} onclick="event.stopPropagation()"/>
    </div>\`).join('');
    updateBcPreview();
}

function toggleChat(jid,name,number){
    if(selectedChats.has(jid))selectedChats.delete(jid);
    else selectedChats.add(jid);
    renderChats();
}

function selectAll(){
    filteredChats.forEach(c=>selectedChats.add(c.jid));
    renderChats();
    showT('âœ… '+selectedChats.size+' contacts selected!');
}

function deselectAll(){
    selectedChats.clear();
    renderChats();
    showT('âŒ Sab deselect ho gaye!');
}

function filterChats(){
    const q=document.getElementById('chatSearch').value.toLowerCase();
    filteredChats=allChats.filter(c=>(c.name||'').toLowerCase().includes(q)||c.number.includes(q));
    renderChats();
}

function updateSelCount(){
    const el=document.getElementById('selCount');
    if(el)el.textContent=selectedChats.size+' selected';
}

function updateBcPreview(){
    const el=document.getElementById('bcPreview');
    const msg=document.getElementById('msgPreview')?.value||'';
    const delay=document.getElementById('bc_delay')?.value||5;
    if(el)el.innerHTML=\`ðŸ“Š <b style="color:white">\${selectedChats.size}</b> contacts selected | Delay: <b style="color:white">\${delay}s</b> | Est. time: <b style="color:white">\${Math.ceil(selectedChats.size*parseInt(delay)/60)} min</b>\`;
}

async function generateMsg(){
    const offer=document.getElementById('offerDetails').value;
    if(!offer.trim()){showT('âŒ Offer details likho!');return;}
    const btn=document.getElementById('genBtn');
    btn.textContent='â³ Generating...';btn.disabled=true;
    const personalized=document.getElementById('msgType').value==='personalized';
    try{
        const r=await fetch('/api/generate-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({offerDetails:offer,customerName:'Dost',personalized})});
        const d=await r.json();
        if(d.success){
            document.getElementById('msgPreview').value=d.message;
            document.getElementById('generatedMsg').style.display='block';
            showT('âœ… Message generated!');
        }
    }catch(e){showT('âŒ Error!');}
    btn.textContent='ðŸ¤– AI Se Message Generate Karo';btn.disabled=false;
    updateBcPreview();
}

async function sendBroadcast(){
    const msg=document.getElementById('msgPreview')?.value||'';
    const offer=document.getElementById('offerDetails').value;
    const personalized=document.getElementById('msgType').value==='personalized';
    const delay=parseInt(document.getElementById('bc_delay').value)||5;

    if(!msg.trim()&&!offer.trim()){showT('âŒ Pehle message generate karo!');return;}
    if(selectedChats.size===0){showT('âŒ Contacts select karo!');return;}
    if(!confirm('ðŸ“¢ '+selectedChats.size+' contacts ko message bhejein?'))return;

    const contacts=allChats.filter(c=>selectedChats.has(c.jid)).map(c=>({jid:c.jid,name:c.name||c.number,number:c.number}));
    const btn=document.getElementById('sendBcBtn');
    btn.disabled=true;btn.textContent='â³ Sending...';
    document.getElementById('bcProgress').style.display='block';

    try{
        const r=await fetch('/api/smart-broadcast',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                offerDetails:offer,
                baseMessage:msg,
                personalized,
                delaySeconds:delay,
                selectedContacts:contacts
            })
        });
        const d=await r.json();
        if(d.success){
            showT('âœ… Broadcast shuru! '+contacts.length+' messages jaayenge.');
            // Progress track karo
            trackProgress(d.broadcast.id,contacts.length,delay);
        }else{showT('âŒ Error: '+(d.error||'Unknown'));}
    }catch(e){showT('âŒ Error: '+e.message);}
    btn.disabled=false;btn.textContent='ðŸ“¢ Broadcast Bhejo';
}

function trackProgress(bcId,total,delay){
    let sent=0;
    const interval=setInterval(()=>{
        sent+=1;
        const pct=Math.min((sent/total)*100,100);
        document.getElementById('bcProgressFill').style.width=pct+'%';
        document.getElementById('bcProgressText').textContent='Sending... '+sent+'/'+total;
        if(sent>=total){
            clearInterval(interval);
            document.getElementById('bcProgressText').textContent='âœ… Broadcast Complete! '+total+'/'+total;
            loadData();
        }
    },delay*1000);
}

function orderCard(o){
    const t=new Date(o.timestamp).toLocaleString('en-PK');
    const bc=o.status==='pending'?'bp':o.status==='approved'?'ba':'br';
    const lb=o.language?'<span style="background:#333;padding:2px 8px;border-radius:10px;font-size:11px;color:#aaa;">'+o.language+'</span>':'';
    const acts=o.status==='pending'?\`<button class="btn btn-green" onclick="approveO(\${o.orderId})">âœ… Approve</button><button class="btn btn-red" onclick="rejectO(\${o.orderId})">âŒ Reject</button><button class="btn btn-blue" onclick="openM('\${o.customerJid}')">ðŸ’¬</button>\`:\`<button class="btn btn-blue" onclick="openM('\${o.customerJid}')">ðŸ’¬</button>\`;
    return \`<div class="card \${o.status}"><div class="card-header"><span class="order-id">#\${o.orderId}</span><div style="display:flex;gap:6px;">\${lb}<span class="badge \${bc}">\${o.status.toUpperCase()}</span></div></div><div class="info">ðŸ“± <b>\${o.customerNumber}</b> | ðŸ‘¤ <b>\${o.customerName||'N/A'}</b><br>ðŸ“¸ <b>\${o.hasScreenshot?'âœ… Received':'âŒ Pending'}</b> | ðŸ“… <b>\${t}</b></div><div class="btn-row">\${acts}</div></div>\`;
}

function renderOrders(){
    const orders=Object.values(D.orders||{}).sort((a,b)=>b.timestamp-a.timestamp);
    const p=orders.filter(o=>o.status==='pending');
    const a=orders.filter(o=>o.status==='approved');
    const r=orders.filter(o=>o.status==='rejected');
    document.getElementById('pendingOrders').innerHTML=p.length===0?'<div class="empty">Koi pending nahi âœ…</div>':p.map(orderCard).join('');
    document.getElementById('approvedOrders').innerHTML=a.length===0?'<div class="empty">Koi approved nahi</div>':a.map(orderCard).join('');
    document.getElementById('rejectedOrders').innerHTML=r.length===0?'<div class="empty">Koi rejected nahi</div>':r.map(orderCard).join('');
}

async function approveO(id){if(!confirm('Approve?'))return;await fetch('/api/approve/'+id,{method:'POST'});showT('âœ… Approved!');loadData();}
async function rejectO(id){if(!confirm('Reject?'))return;await fetch('/api/reject/'+id,{method:'POST'});showT('âŒ Rejected!');loadData();}

function renderBcHistory(){
    const bcs=D.broadcasts||[];
    document.getElementById('bcHistory').innerHTML=bcs.length===0?'<div class="empty">Koi broadcast nahi</div>':bcs.map(b=>\`<div class="card \${b.status}"><div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="font-weight:bold;color:white;">\${b.status==='completed'?'âœ…':'â³'} \${b.status.toUpperCase()}</span><span style="color:#aaa;font-size:12px;">\${new Date(b.createdAt).toLocaleString('en-PK')}</span></div><p style="color:#ccc;font-size:13px;margin-bottom:8px;">\${(b.baseMessage||b.offerDetails||'').substring(0,80)}...</p><p style="color:#aaa;font-size:12px;">Sent:\${b.sentCount||0} | Failed:\${b.failedCount||0} | Total:\${b.totalContacts||0} | Delay:\${b.delaySeconds}s | \${b.personalized?'Personalized':'Same'}</p></div>\`).join('');
}

function renderProd(){
    const el=document.getElementById('prodList');
    if(!products.length){el.innerHTML='<div class="empty">Koi product nahi</div>';return;}
    el.innerHTML=products.map((p,i)=>\`<div class="product-card"><div class="product-header"><span style="font-size:15px;font-weight:bold;color:white;">\${p.name}</span><label class="toggle"><input type="checkbox" \${p.active?'checked':''} onchange="products[\${i}].active=this.checked"/><span class="slider"></span></label></div><div class="form-group"><label>Name</label><input value="\${p.name}" onchange="products[\${i}].name=this.value"/></div><div class="form-group"><label>Price</label><input type="number" value="\${p.price}" onchange="products[\${i}].price=parseInt(this.value)||0"/></div><div class="form-group"><label>Description</label><textarea onchange="products[\${i}].description=this.value">\${p.description||''}</textarea></div><div class="form-group"><label>Download Link</label><input value="\${p.downloadLink||''}" placeholder="https://drive.google.com/..." onchange="products[\${i}].downloadLink=this.value"/></div><div class="form-group"><label>Features</label><div class="feature-list">\${(p.features||[]).map((f,j)=>\`<div class="feature-tag">\${f}<button onclick="rmF(\${i},\${j})">Ã—</button></div>\`).join('')}</div><div class="feature-input"><input id="nf\${i}" placeholder="New feature..." onkeypress="if(event.key==='Enter')addF(\${i})"/><button onclick="addF(\${i})">+</button></div></div><div class="btn-row"><button class="btn btn-green" onclick="saveProd()">ðŸ’¾ Save</button><button class="btn btn-red" onclick="rmP(\${i})">ðŸ—‘ï¸ Delete</button></div></div>\`).join('');
}

function addF(i){const inp=document.getElementById('nf'+i);if(!inp.value.trim())return;if(!products[i].features)products[i].features=[];products[i].features.push(inp.value.trim());inp.value='';renderProd();}
function rmF(i,j){products[i].features.splice(j,1);renderProd();}
function addProduct(){products.push({id:Date.now(),name:'New Product',price:999,description:'',features:[],downloadLink:'',active:false});renderProd();}
function rmP(i){if(confirm('Delete?')){products.splice(i,1);renderProd();}}
async function saveProd(){const r=await fetch('/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(products)});const d=await r.json();showT(d.success?'âœ… Saved!':'âŒ Error!');loadData();}

function renderPay(){const p=D.payment||{};document.getElementById('ep_n').value=p.easypaisa?.number||'';document.getElementById('ep_nm').value=p.easypaisa?.name||'';document.getElementById('jc_n').value=p.jazzcash?.number||'';document.getElementById('jc_nm').value=p.jazzcash?.name||'';document.getElementById('bk_n').value=p.bank?.bankName||'';document.getElementById('bk_a').value=p.bank?.accountNumber||'';document.getElementById('bk_h').value=p.bank?.accountName||'';document.getElementById('bk_i').value=p.bank?.iban||'';}
async function savePayment(){const d={easypaisa:{number:document.getElementById('ep_n').value,name:document.getElementById('ep_nm').value},jazzcash:{number:document.getElementById('jc_n').value,name:document.getElementById('jc_nm').value},bank:{bankName:document.getElementById('bk_n').value,accountNumber:document.getElementById('bk_a').value,accountName:document.getElementById('bk_h').value,iban:document.getElementById('bk_i').value}};const r=await fetch('/api/payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const x=await r.json();showT(x.success?'âœ… Payment Saved!':'âŒ Error!');}

function renderPrompt(){document.getElementById('aiP').value=D.aiPrompt||'';}
async function savePrompt(){const r=await fetch('/api/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:document.getElementById('aiP').value})});const d=await r.json();showT(d.success?'âœ… Saved!':'âŒ Error!');}

function renderSet(){const s=D.settings||{};document.getElementById('s_bn').value=s.businessName||'';document.getElementById('s_an').value=s.adminNumber||'';}
async function saveSettings(){const pw=document.getElementById('s_pw').value;const d={businessName:document.getElementById('s_bn').value,adminNumber:document.getElementById('s_an').value};if(pw)d.dashboardPassword=pw;const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const x=await r.json();showT(x.success?'âœ… Saved!':'âŒ Error!');document.getElementById('s_pw').value='';}

async function resetSess(){if(!confirm('Reset? Naya QR scan karna hoga!'))return;await fetch('/api/reset-session',{method:'POST'});showT('ðŸ”„ Resetting...');setTimeout(()=>window.location='/qr',3000);}

function showPage(p){
document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));
const pageEl=document.getElementById('page-'+p);
if(pageEl)pageEl.classList.add('active');
const navEl=document.getElementById('nav-'+p);
if(navEl)navEl.classList.add('active');
const titles={orders:'ðŸ“¦ Orders',broadcast:'ðŸ“¢ Smart Broadcast',products:'ðŸŽ¨ Products',payment:'ðŸ’³ Payment',prompt:'ðŸ¤– AI Prompt',settings:'âš™ï¸ Settings'};
document.getElementById('pt').textContent=titles[p]||p;
const ss=['orders'].includes(p);
document.getElementById('sg').style.display=ss?'grid':'none';
document.getElementById('rc').style.display=ss?'block':'none';
if(p==='broadcast'&&D.botStatus==='connected'){loadChats();}
}

function openM(jid){document.getElementById('mj').value=jid;document.getElementById('mm').classList.add('show');}
function closeM(){document.getElementById('mm').classList.remove('show');}
async function sendMsg(){const jid=document.getElementById('mj').value;const msg=document.getElementById('mt').value;if(!msg.trim())return;const r=await fetch('/api/send-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid,message:msg})});const d=await r.json();showT(d.success?'âœ… Sent!':'âŒ Error!');if(d.success){closeM();document.getElementById('mt').value='';}}

function showT(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';setTimeout(()=>t.style.display='none',3000);}

loadData();
setInterval(loadData,15000);
setInterval(()=>{if(D.botStatus==='connected')loadChats();},30000);
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

        if (!botData.customers) botData.customers = {};
        botData.customers[senderId] = { jid: senderId, number: senderId.replace('@s.whatsapp.net', ''), name: senderName, lastSeen: Date.now(), language: botData.customers[senderId]?.language || 'roman_urdu' };

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
                    const pfx = { urdu: `ðŸŽ¤ Ø¢Ù¾: "${text}"\n\n`, roman_urdu: `ðŸŽ¤ Aap: "${text}"\n\n`, english: `ðŸŽ¤ You said: "${text}"\n\n` };
                    await sock.sendMessage(senderId, { text: (pfx[lang] || pfx.roman_urdu) + ai.message }, { quoted: message });
                    if (ai.shouldOrder) await handleOrder(sock, senderId, senderName, ai, message, lang);
                } else {
                    await sock.sendPresenceUpdate('paused', senderId);
                    await sock.sendMessage(senderId, { text: 'âš ï¸ Voice samajh nahi aaya. Text likhein! ðŸ™' });
                }
            } catch (e) {
                await sock.sendPresenceUpdate('paused', senderId);
                await sock.sendMessage(senderId, { text: 'âš ï¸ Voice error. Text likhein please!' });
            }
            return;
        }

        if (msgType === 'imageMessage') {
            const order = Object.values(botData.orders).find(o => o.customerJid === senderId && o.status === 'pending');
            if (order) {
                order.hasScreenshot = true; await saveData();
                const lang = botData.customers[senderId]?.language || 'roman_urdu';
                const msgs = { urdu: `ðŸ“¸ Ù…ÙˆØµÙˆÙ„!\nØ¢Ø±ÚˆØ± #${order.orderId}\nâœ… ØªØµØ¯ÛŒÙ‚ ÛÙˆ Ø±ÛÛŒ ÛÛ’\nâ³ 1 Ú¯Ú¾Ù†Ù¹Û’ Ù…ÛŒÚº!`, roman_urdu: `ðŸ“¸ Screenshot Received!\nOrder #${order.orderId}\nâœ… Verify ho raha hai\nâ³ 1 ghante mein!`, english: `ðŸ“¸ Received!\nOrder #${order.orderId}\nâœ… Verifying\nâ³ 1 hour!` };
                await sock.sendMessage(senderId, { text: msgs[lang] || msgs.roman_urdu });
                try { await sock.sendMessage(botData.settings.adminNumber + '@s.whatsapp.net', { text: `ðŸ”” Payment Screenshot!\nOrder #${order.orderId}\n${senderName} | ${order.customerNumber}\nDashboard pe approve karo! âš¡` }); } catch (e) {}
            } else {
                const lang = botData.customers[senderId]?.language || 'roman_urdu';
                const ai = await getAI('[image bheja bina order]', senderId, senderName, lang);
                await sock.sendMessage(senderId, { text: ai.message });
            }
            return;
        }

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
// WHATSAPP BOT
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function startBot() {
    try {
        console.log(`ðŸ”„ Start attempt #${++connectAttempts}`);
        await loadData();

        const { state, saveCreds } = await useUpstashAuthState();
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`ðŸ“± WA v${version.join('.')} Latest:${isLatest}`);

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

        // Store bind karo chats ke liye
        globalStore.bind(sock.ev);

        sockGlobal = sock;
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQR = qr;
                botStatus = 'qr_ready';
                qrRetryCount++;
                console.log(`ðŸ“± QR Ready #${qrRetryCount}! /qr pe jao!`);
            }

            if (connection === 'close') {
                currentQR = null;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log(`âŒ Disconnected code:${code}`);

                if (code === DisconnectReason.loggedOut) {
                    botStatus = 'logged_out';
                    try { await redisDel('wa_creds_v4'); await redisDel('wa_keys_v4'); } catch (e) {}
                    qrRetryCount = 0;
                    setTimeout(startBot, 5000);
                } else if (!code || code === undefined) {
                    // undefined = IP block ya network issue
                    // QR show karo fresh connection ke liye
                    botStatus = 'qr_needed';
                    currentQR = null;
                    const delay = Math.min(connectAttempts * 5000, 30000);
                    console.log(`âš ï¸ Unknown disconnect â€” ${delay/1000}s mein fresh QR lega...`);
                    // Credentials clear NAHI karo â€” sirf reconnect
                    setTimeout(startBot, delay);
                } else if (code === 405) {
                    botStatus = 'reconnecting';
                    console.log('âš ï¸ 405 â€” 30s retry...');
                    setTimeout(startBot, 30000);
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
                console.log('âœ… WhatsApp Connected! Mega Agency v4 LIVE!');

                // Existing chats fetch karo background mein
                setTimeout(() => fetchExistingChats(sock), 3000);
                await initSheet().catch(() => {});
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) await handleMessage(sock, msg);
        });

        // Chats update hone pe refresh karo
        sock.ev.on('chats.upsert', () => {
            processChatsFromStore();
        });
        
        sock.ev.on('chats.set', () => {
            setTimeout(processChatsFromStore, 2000);
        });

    } catch (err) {
        console.error('Bot error:', err.message);
        botStatus = 'error';
        setTimeout(startBot, 15000);
    }
}

console.log('ðŸš€ Mega Agency AI Sales Bot v4 â€” STARTING...');
startBot();
