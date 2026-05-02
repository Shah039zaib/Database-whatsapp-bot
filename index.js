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
        await axios.post(`${REDIS_URL}/set/${encodeURIComponent(key)}`,
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// UPSTASH AUTH STATE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function useUpstashAuthState() {
    const AUTH_KEY = 'wa_auth_state';
    const CREDS_KEY = 'wa_creds';

    let creds = await redisGet(CREDS_KEY);
    let keys = await redisGet(AUTH_KEY) || {};

    if (!creds) {
        const { initAuthCreds } = require('@whiskeysockets/baileys');
        creds = initAuthCreds();
        await redisSet(CREDS_KEY, creds);
        console.log('ðŸ”‘ Fresh credentials banaye gaye!');
    } else {
        console.log('âœ… Credentials Upstash se load ho gaye!');
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
        console.log('ðŸ’¾ Credentials Upstash mein save ho gaye!');
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
            exp: now + 3600,
            iat: now
        })).toString('base64url');

        const crypto = require('crypto');
        const sign = crypto.createSign('RSA-SHA256');
        sign.update(`${header}.${payload}`);
        const signature = sign.sign(key, 'base64url');
        const jwt = `${header}.${payload}.${signature}`;

        const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt
        });
        return tokenRes.data.access_token;
    } catch (e) {
        console.log('Google token error:', e.message);
        return null;
    }
}

async function saveToGoogleSheet(data) {
    try {
        const token = await getGoogleToken();
        if (!token) return false;

        const sheetId = process.env.GOOGLE_SHEET_ID;
        const values = [[
            data.orderId || '',
            data.customerName || '',
            data.customerNumber || '',
            data.product || '',
            data.amount || '',
            data.status || '',
            data.language || '',
            new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })
        ]];

        await axios.post(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A:H:append?valueInputOption=USER_ENTERED`,
            { values },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        console.log('âœ… Google Sheet mein save ho gaya!');
        return true;
    } catch (e) {
        console.log('Google Sheet error:', e.message);
        return false;
    }
}

async function initGoogleSheet() {
    try {
        const token = await getGoogleToken();
        if (!token) return;
        const sheetId = process.env.GOOGLE_SHEET_ID;
        const headers = [['Order ID', 'Customer Name', 'Phone Number', 'Product', 'Amount (PKR)', 'Status', 'Language', 'Date & Time']];
        await axios.post(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED`,
            { values: headers },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        console.log('âœ… Google Sheet initialized!');
    } catch (e) {
        console.log('Sheet init error:', e.message);
    }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// VOICE TO TEXT â€” Groq Whisper
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function voiceToText(audioBuffer) {
    try {
        const FormData = require('form-data');
        const form = new FormData();
        form.append('file', audioBuffer, {
            filename: 'audio.ogg',
            contentType: 'audio/ogg'
        });
        form.append('model', 'whisper-large-v3');
        form.append('response_format', 'json');

        const response = await axios.post(
            'https://api.groq.com/openai/v1/audio/transcriptions',
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    Authorization: `Bearer ${process.env.GROQ_API_KEY}`
                },
                timeout: 30000
            }
        );
        return response.data.text || '';
    } catch (e) {
        console.log('Voice to text error:', e.message);
        return null;
    }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// LANGUAGE DETECTION
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function detectLanguage(text) {
    const urduChars = /[\u0600-\u06FF]/;
    const romanUrduWords = /\b(kya|hai|haan|nahi|karo|mujhe|chahiye|theek|acha|yar|bhai|ap|tum|aap|koi|kuch|sab|agar|toh|phir|lekin|aur|ya|mera|tumhara|price|kitna|lena|dena|batao|shukriya|jazakallah|inshallah)\b/i;

    if (urduChars.test(text)) return 'urdu';
    if (romanUrduWords.test(text)) return 'roman_urdu';
    return 'english';
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DATA STORE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const DATA_KEY = 'bot_data_v2';

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
- Price: PKR 999 ONLY â€” YEH FINAL PRICE HAI
- Delivery: Payment approve hone ke 1 hour baad
- Features: 100+ themes, all niches, regular updates, 24/7 support

LANGUAGE RULES:
- Agar customer Urdu mein baat kare â€” Urdu mein reply karo
- Agar Roman Urdu mein â€” Roman Urdu mein reply karo
- Agar English mein â€” English mein reply karo

TUMHARA KAAM:
1. Customer se warmly greet karo
2. Unke niche ke baare mein poocho
3. Value explain karo specifically
4. Price objections handle karo
5. Jab customer BUY karna chahe â€” ORDER_READY likho

PRICE NEGOTIATION â€” STRICT:
- PRICE KABHI KAM NAHI KARO â€” PKR 999 FINAL HAI
- Agar customer discount maange: "Bhai yeh already lowest price hai â€” ek theme akeli 5000+ ki hoti hai, 100+ sirf 999 mein!"
- Agar zyada pressure kare: "Hum quality pe compromise nahi karte â€” yeh price genuine hai"
- KABHI bhi 999 se kam price mat batao

SELLING TECHNIQUES:
- Value Stack: "Market mein ek theme 5000+ ki hai, 100+ sirf PKR 999 mein"
- Per Unit: "Sirf PKR 10 per theme"
- Social Proof: "1000+ Pakistani store owners use kar rahe hain"
- FOMO: "Competitors already yeh use kar rahe hain"
- ROI: "Ek sale se 999 wapas aa jata hai"

STRICT RULES:
- PRICE SIRF PKR 999 â€” koi discount nahi
- SIRF Shopify themes sell karo
- Short replies â€” 3-4 lines max
- Jab customer buy kare â€” ORDER_READY likho bilkul start mein`,
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
            console.log('âœ… Bot data Upstash se load ho gaya!');
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
    }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// BOT STATE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let currentQR = null;
let botStatus = 'starting';
let sockGlobal = null;
const salesHistory = {};
const sessions = {};
const broadcastQueue = [];
let broadcastRunning = false;

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
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { resolve({}); }
        });
    });
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// BROADCAST SYSTEM
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function runBroadcast(broadcast) {
    if (!sockGlobal || !broadcast) return;
    broadcastRunning = true;
    const customers = Object.values(botData.customers);
    let sent = 0;
    let failed = 0;

    console.log(`ðŸ“¢ Broadcast start: ${broadcast.message.substring(0, 50)}...`);
    broadcast.status = 'running';
    broadcast.sentCount = 0;
    broadcast.failedCount = 0;
    await saveData();

    for (const customer of customers) {
        try {
            await sockGlobal.sendMessage(customer.jid, { text: broadcast.message });
            sent++;
            broadcast.sentCount = sent;
            console.log(`ðŸ“¤ Broadcast sent to ${customer.name} (${sent}/${customers.length})`);
            // Delay between messages
            const delay = (broadcast.delaySeconds || 3) * 1000;
            await new Promise(r => setTimeout(r, delay));
        } catch (e) {
            failed++;
            broadcast.failedCount = failed;
            console.log(`âŒ Broadcast failed for ${customer.name}: ${e.message}`);
        }
    }

    broadcast.status = 'completed';
    broadcast.completedAt = Date.now();
    await saveData();
    broadcastRunning = false;
    console.log(`âœ… Broadcast complete! Sent: ${sent}, Failed: ${failed}`);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// PAYMENT MESSAGE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getPaymentMessage(orderId, product, lang) {
    const p = botData.payment;
    if (lang === 'urdu') {
        return `ðŸ›’ *Ø¢Ø±ÚˆØ± Ú©Ù†ÙØ±Ù…!*
Ø¢Ø±ÚˆØ± Ù†Ù…Ø¨Ø±: *#${orderId}*

â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”
ðŸ’³ *Ù¾ÛŒÙ…Ù†Ù¹ ÚˆÛŒÙ¹ÛŒÙ„Ø² â€” PKR ${product.price}*

ðŸ“± *EasyPaisa:*
Ù†Ù…Ø¨Ø±: ${p.easypaisa.number}
Ù†Ø§Ù…: ${p.easypaisa.name}

ðŸ“± *JazzCash:*
Ù†Ù…Ø¨Ø±: ${p.jazzcash.number}
Ù†Ø§Ù…: ${p.jazzcash.name}

ðŸ¦ *Ø¨ÛŒÙ†Ú© Ù¹Ø±Ø§Ù†Ø³ÙØ±:*
Ø¨ÛŒÙ†Ú©: ${p.bank.bankName}
Ø§Ú©Ø§Ø¤Ù†Ù¹: ${p.bank.accountNumber}
Ù†Ø§Ù…: ${p.bank.accountName}

â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”
âœ… Ù¾ÛŒÙ…Ù†Ù¹ Ú©Û’ Ø¨Ø¹Ø¯ Ø§Ø³Ú©Ø±ÛŒÙ† Ø´Ø§Ù¹ Ø¨Ú¾ÛŒØ¬ÛŒÚº
ðŸ“¦ 1 Ú¯Ú¾Ù†Ù¹Û’ Ù…ÛŒÚº ÚˆÙ„ÛŒÙˆØ±ÛŒ!`;
    }

    if (lang === 'roman_urdu') {
        return `ðŸ›’ *Order Confirm Ho Gaya!*
Order ID: *#${orderId}*

â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”
ðŸ’³ *Payment Details â€” PKR ${product.price}*

ðŸ“± *EasyPaisa:*
Number: ${p.easypaisa.number}
Naam: ${p.easypaisa.name}

ðŸ“± *JazzCash:*
Number: ${p.jazzcash.number}
Naam: ${p.jazzcash.name}

ðŸ¦ *Bank Transfer:*
Bank: ${p.bank.bankName}
Account: ${p.bank.accountNumber}
Naam: ${p.bank.accountName}
IBAN: ${p.bank.iban}

â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”
âœ… Payment ke baad screenshot bhejo
ðŸ“¦ 1 ghante mein delivery guaranteed!`;
    }

    return `ðŸ›’ *Order Confirmed!*
Order ID: *#${orderId}*
Product: *${product.name}*

â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”
ðŸ’³ *Payment Details â€” ${botData.settings.currency} ${product.price}*

ðŸ“± *EasyPaisa:*
Number: ${p.easypaisa.number}
Name: ${p.easypaisa.name}

ðŸ“± *JazzCash:*
Number: ${p.jazzcash.number}
Name: ${p.jazzcash.name}

ðŸ¦ *Bank Transfer:*
Bank: ${p.bank.bankName}
Account: ${p.bank.accountNumber}
Name: ${p.bank.accountName}
IBAN: ${p.bank.iban}

â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”
âœ… Send screenshot after payment
ðŸ“¦ Delivery within 1 hour!`;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AI SALES RESPONSE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getAISalesResponse(userMessage, userId, customerName, lang) {
    if (!salesHistory[userId]) salesHistory[userId] = [];

    salesHistory[userId].push({ role: 'user', content: userMessage });
    if (salesHistory[userId].length > 30) {
        salesHistory[userId] = salesHistory[userId].slice(-30);
    }

    const activeProduct = botData.products.find(p => p.active) || botData.products[0];

    let langInstruction = '';
    if (lang === 'urdu') langInstruction = 'IMPORTANT: Sirf Urdu script mein reply karo.';
    else if (lang === 'roman_urdu') langInstruction = 'IMPORTANT: Roman Urdu mein reply karo.';
    else langInstruction = 'IMPORTANT: English mein reply karo.';

    const systemPrompt = botData.aiPrompt +
        `\n\n${langInstruction}` +
        `\nCustomer naam: ${customerName}` +
        `\nActive Product: ${activeProduct.name}` +
        `\nPrice: ${botData.settings.currency} ${activeProduct.price}` +
        `\nYAD RAKHO: Price kabhi kam nahi karo — ${activeProduct.price} final hai`;

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
                ? { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }
                : { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://mega-agency.com', 'X-Title': 'Mega Agency' };

            const response = await axios.post(apiUrl, {
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...salesHistory[userId]
                ],
                max_tokens: 350,
                temperature: 0.8
            }, { headers, timeout: 15000 });

            const aiMessage = response.data.choices[0].message.content;
            salesHistory[userId].push({ role: 'assistant', content: aiMessage });

            const shouldOrder = aiMessage.toUpperCase().includes('ORDER_READY');
            const cleanMessage = aiMessage.replace(/ORDER_READY/gi, '').trim();

            console.log(`✅ AI: ${provider}/${model} | Lang: ${lang}`);
            return { message: cleanMessage, shouldOrder, product: activeProduct };

        } catch (err) {
            console.log(`❌ ${provider}/${model} fail`);
            if (salesHistory[userId].length > 0) salesHistory[userId].pop();
        }
    }

    const fallback = {
        urdu: '⚠️ تھوڑی تکنیکی دشواری ہے۔ 1 منٹ بعد دوبارہ کوشش کریں! 🙏',
        roman_urdu: '⚠️ Thodi technical difficulty hai. 1 min mein dobara try karo! 🙏',
        english: '⚠️ Minor technical issue. Please try again in 1 minute! 🙏'
    };
    return { message: fallback[lang] || fallback.roman_urdu, shouldOrder: false };
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
                const sessionId = Math.random().toString(36).substring(2) + Date.now().toString(36);
                sessions[sessionId] = true;
                res.writeHead(200, { 'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly`, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } else {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false }));
            }
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>Login</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0;box-sizing:border-box;}
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
.err{color:#e74c3c;font-size:13px;margin-top:10px;display:none;}</style></head>
<body><div class="box">
<h1>🏪 Mega Agency</h1><p>Admin Dashboard Login</p>
<input type="password" id="pass" placeholder="Password" onkeypress="if(event.key==='Enter')login()"/>
<button onclick="login()">🔐 Login</button>
<div class="err" id="err">❌ Wrong password!</div></div>
<script>async function login(){
const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({password:document.getElementById('pass').value})});
const d=await r.json();
if(d.success)window.location='/dashboard';
else document.getElementById('err').style.display='block';
}</script></body></html>`);
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
            res.end(`<html><head><style>body{background:#111;color:white;display:flex;flex-direction:column;
align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;}
h2{color:#25D366;}a{color:#25D366;font-size:18px;margin-top:20px;display:block;}
p{color:#aaa;}</style></head><body>
<h2>✅ Bot Connected!</h2><p>Mega Agency Bot live hai!</p>
<p style="color:#25D366">✅ Session Upstash mein save — auto connect!</p>
<a href="/dashboard">📊 Dashboard</a></body></html>`);
            return;
        }
        if (!currentQR) {
            res.end(`<html><head><meta http-equiv="refresh" content="3">
<style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;
justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;}
h2{color:#f39c12;}p{color:#aaa;}</style></head>
<body><h2>⏳ QR Generate Ho Raha Hai...</h2><p>Status: ${botStatus}</p></body></html>`);
            return;
        }
        try {
            const qrDataURL = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
            res.end(`<html><head><meta http-equiv="refresh" content="25">
<style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;
justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;padding:20px;}
h2{color:#25D366;}img{border:8px solid white;border-radius:12px;width:280px;height:280px;}
.steps{background:#222;padding:15px;border-radius:10px;text-align:left;max-width:320px;margin-top:15px;}
p{color:#aaa;}</style></head><body>
<h2>📱 WhatsApp QR Code</h2><img src="${qrDataURL}"/>
<div class="steps"><p>1️⃣ WhatsApp kholo</p><p>2️⃣ 3 dots → Linked Devices</p>
<p>3️⃣ Link a Device</p><p>4️⃣ QR scan karo</p></div>
<p style="color:#25D366;margin-top:10px">✅ Ek baar scan — hamesha ke liye!</p>
<p style="color:#f39c12">⚠️ 25 sec mein expire!</p></body></html>`);
        } catch (err) {
            res.end('<h1 style="color:red">QR Error: ' + err.message + '</h1>');
        }
        return;
    }

    // API: GET DATA
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
                customers: Object.keys(botData.customers).length,
                revenue: ordersArr.filter(o => o.status === 'approved').reduce((s, o) => {
                    const p = botData.products.find(pr => pr.id === o.productId) || botData.products[0];
                    return s + (p?.price || 0);
                }, 0)
            }
        }));
        return;
    }

    // API: SETTINGS
    if (pathname === '/api/settings' && req.method === 'POST') {
        const body = await parseBody(req);
        botData.settings = { ...botData.settings, ...body };
        await saveData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // API: PAYMENT
    if (pathname === '/api/payment' && req.method === 'POST') {
        const body = await parseBody(req);
        botData.payment = body;
        await saveData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // API: PRODUCTS
    if (pathname === '/api/products' && req.method === 'POST') {
        const body = await parseBody(req);
        botData.products = body;
        await saveData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // API: PROMPT
    if (pathname === '/api/prompt' && req.method === 'POST') {
        const body = await parseBody(req);
        botData.aiPrompt = body.prompt;
        await saveData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // API: APPROVE ORDER
    if (pathname.startsWith('/api/approve/') && req.method === 'POST') {
        const orderId = parseInt(pathname.split('/api/approve/')[1]);
        const order = Object.values(botData.orders).find(o => o.orderId === orderId);
        if (order && sockGlobal) {
            order.status = 'approved';
            await saveData();
            const product = botData.products.find(p => p.id === order.productId) || botData.products[0];
            try {
                let msg = `🎉 *Payment Approved!*\n\nOrder *#${order.orderId}* confirm!\n\n📦 *${product.name}*\n\n`;
                if (product.downloadLink) msg += `⬇️ *Download Link:*\n${product.downloadLink}\n\n`;
                msg += `Shukriya ${botData.settings.businessName}! 🙏`;
                await sockGlobal.sendMessage(order.customerJid, { text: msg });
                // Google Sheet update
                await saveToGoogleSheet({ ...order, product: product.name, amount: product.price, status: 'approved' });
            } catch (e) { console.log('Approve err:', e.message); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // API: REJECT ORDER
    if (pathname.startsWith('/api/reject/') && req.method === 'POST') {
        const orderId = parseInt(pathname.split('/api/reject/')[1]);
        const order = Object.values(botData.orders).find(o => o.orderId === orderId);
        if (order && sockGlobal) {
            order.status = 'rejected';
            await saveData();
            try {
                await sockGlobal.sendMessage(order.customerJid, {
                    text: `❌ *Payment Verify Nahi Ho Saki*\n\nOrder *#${order.orderId}*\n\nDobara screenshot bhejo ya admin se contact karo. 💪`
                });
                await saveToGoogleSheet({ ...order, product: '', amount: 0, status: 'rejected' });
            } catch (e) { console.log('Reject err:', e.message); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // API: SEND MESSAGE
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
            res.end(JSON.stringify({ success: false }));
        }
        return;
    }

    // API: CREATE BROADCAST
    if (pathname === '/api/broadcast' && req.method === 'POST') {
        const body = await parseBody(req);
        if (!body.message) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Message required' }));
            return;
        }
        const broadcast = {
            id: Date.now(),
            message: body.message,
            delaySeconds: body.delaySeconds || 3,
            status: 'pending',
            sentCount: 0,
            failedCount: 0,
            totalCustomers: Object.keys(botData.customers).length,
            createdAt: Date.now()
        };
        if (!botData.broadcasts) botData.broadcasts = [];
        botData.broadcasts.unshift(broadcast);
        if (botData.broadcasts.length > 20) botData.broadcasts = botData.broadcasts.slice(0, 20);
        await saveData();

        // Run broadcast in background
        if (!broadcastRunning) {
            runBroadcast(broadcast).catch(console.error);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, broadcast }));
        return;
    }

    // API: RESET SESSION
    if (pathname === '/api/reset-session' && req.method === 'POST') {
        try {
            await redisSet('wa_auth_state', {});
            await redisSet('wa_creds', null);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            setTimeout(() => process.exit(0), 1000);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // LOGOUT
    if (pathname === '/logout') {
        res.writeHead(302, { 'Set-Cookie': 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', Location: '/login' });
        res.end();
        return;
    }

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
.sidebar-logo h2{color:#25D366;font-size:18px;}
.sidebar-logo p{color:#666;font-size:11px;margin-top:3px;}
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
.stat-card h2{font-size:28px;font-weight:bold;margin-bottom:4px;}
.stat-card p{color:#666;font-size:11px;}
.section{background:#111;border-radius:12px;border:1px solid #222;margin-bottom:20px;overflow:hidden;}
.section-header{padding:15px 20px;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:center;}
.section-header h3{font-size:15px;color:white;}
.section-body{padding:18px;}
.order-card{background:#0f0f0f;border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid #222;}
.order-card.pending{border-left:4px solid #f39c12;}
.order-card.approved{border-left:4px solid #25D366;}
.order-card.rejected{border-left:4px solid #e74c3c;}
.order-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.order-id{font-weight:bold;color:#25D366;}
.badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:bold;}
.bp{background:#f39c12;color:black;}.ba{background:#25D366;color:black;}.br{background:#e74c3c;color:white;}
.order-info{font-size:13px;color:#aaa;line-height:1.9;}.order-info b{color:white;}
.btn-row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
.btn{padding:7px 14px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:bold;text-decoration:none;display:inline-block;}
.btn-green{background:#25D366;color:black;}.btn-red{background:#e74c3c;color:white;}
.btn-blue{background:#3498db;color:white;}.btn-gray{background:#333;color:white;}
.btn-orange{background:#f39c12;color:black;}
.form-group{margin-bottom:15px;}
.form-group label{display:block;color:#aaa;font-size:13px;margin-bottom:6px;}
.form-group input,.form-group textarea,.form-group select{width:100%;padding:10px 14px;background:#0f0f0f;border:1px solid #333;border-radius:8px;color:white;font-size:14px;outline:none;}
.form-group input:focus,.form-group textarea:focus{border-color:#25D366;}
.form-group textarea{resize:vertical;min-height:100px;font-family:'Segoe UI',sans-serif;}
.save-btn{background:#25D366;color:black;border:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;}
.product-card{background:#0f0f0f;border-radius:10px;padding:16px;margin-bottom:12px;border:1px solid #222;}
.product-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
.toggle{position:relative;width:44px;height:24px;}
.toggle input{opacity:0;width:0;height:0;}
.slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#333;border-radius:24px;transition:.4s;}
.slider:before{position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;background:white;border-radius:50%;transition:.4s;}
input:checked+.slider{background:#25D366;}
input:checked+.slider:before{transform:translateX(20px);}
.feature-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
.feature-tag{background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:4px 10px;font-size:12px;color:#aaa;display:flex;align-items:center;gap:5px;}
.feature-tag button{background:none;border:none;color:#e74c3c;cursor:pointer;font-size:14px;}
.feature-input{display:flex;gap:8px;margin-top:8px;}
.feature-input input{flex:1;}
.feature-input button{background:#25D366;color:black;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:bold;}
.page{display:none;}.page.active{display:block;}
.empty{text-align:center;color:#444;padding:30px;font-size:14px;}
.revenue-card{background:linear-gradient(135deg,#1a2e1a,#1a1a2e);border-radius:12px;padding:18px;text-align:center;border:1px solid #25D36640;margin-bottom:20px;}
.revenue-card h2{color:#f39c12;font-size:32px;font-weight:bold;}
.info-box{background:#1a2b1a;border:1px solid #25D36640;border-radius:8px;padding:12px 15px;margin-bottom:15px;font-size:13px;color:#25D366;}
.warn-box{background:#2b1a0d;border:1px solid #f39c1240;border-radius:8px;padding:12px 15px;margin-bottom:15px;font-size:13px;color:#f39c12;}
.customer-card{background:#0f0f0f;border-radius:10px;padding:12px;margin-bottom:8px;border:1px solid #222;display:flex;justify-content:space-between;align-items:center;}
.broadcast-card{background:#0f0f0f;border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid #222;}
.broadcast-card.running{border-left:4px solid #f39c12;}
.broadcast-card.completed{border-left:4px solid #25D366;}
.broadcast-card.pending{border-left:4px solid #3498db;}
.msg-modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:#000000aa;z-index:200;align-items:center;justify-content:center;}
.msg-modal.show{display:flex;}
.msg-box{background:#1a1a1a;border-radius:16px;padding:25px;width:90%;max-width:420px;border:1px solid #333;}
.toast{position:fixed;bottom:20px;right:20px;background:#25D366;color:black;padding:12px 20px;border-radius:10px;font-weight:bold;font-size:14px;z-index:999;display:none;}
@media(max-width:768px){
.sidebar{width:55px;}.sidebar-logo,.nav-item .nt{display:none;}
.nav-item{justify-content:center;padding:12px;}.main{margin-left:55px;padding:12px;}
.stats-grid{grid-template-columns:repeat(2,1fr);}
}
</style></head>
<body>
<div class="sidebar">
<div class="sidebar-logo"><h2>🏪 Mega</h2><p>Admin Panel v2</p></div>
<div class="nav-item active" onclick="showPage('orders',this)"><span>📦</span><span class="nt"> Orders</span></div>
<div class="nav-item" onclick="showPage('broadcast',this)"><span>📢</span><span class="nt"> Broadcast</span></div>
<div class="nav-item" onclick="showPage('customers',this)"><span>👥</span><span class="nt"> Customers</span></div>
<div class="nav-item" onclick="showPage('products',this)"><span>🎨</span><span class="nt"> Products</span></div>
<div class="nav-item" onclick="showPage('payment',this)"><span>💳</span><span class="nt"> Payment</span></div>
<div class="nav-item" onclick="showPage('prompt',this)"><span>🤖</span><span class="nt"> AI Prompt</span></div>
<div class="nav-item" onclick="showPage('settings',this)"><span>⚙️</span><span class="nt"> Settings</span></div>
<div class="nav-item" onclick="window.open('/qr','_blank')"><span>📱</span><span class="nt"> QR Code</span></div>
<div class="nav-item" onclick="window.location='/logout'"><span>🚪</span><span class="nt"> Logout</span></div>
</div>

<div class="main">
<div class="topbar">
<h1 id="pageTitle">📦 Orders</h1>
<div style="display:flex;gap:10px;align-items:center;">
<span class="bot-badge" id="botBadge">⏳ Loading...</span>
<button class="btn btn-gray" onclick="loadData()" style="padding:6px 12px;font-size:12px;">🔄</button>
</div>
</div>

<div class="stats-grid" id="statsGrid"></div>
<div class="revenue-card" id="revenueCard">
<p>💰 Total Revenue</p><h2 id="revenue">PKR 0</h2>
<p id="revenueDetail">Loading...</p></div>

<!-- ORDERS PAGE -->
<div class="page active" id="page-orders">
<div class="section"><div class="section-header"><h3>⏳ Pending Orders</h3></div>
<div class="section-body" id="pendingOrders"><div class="empty">Loading...</div></div></div>
<div class="section"><div class="section-header"><h3>✅ Approved</h3></div>
<div class="section-body" id="approvedOrders"><div class="empty">Loading...</div></div></div>
<div class="section"><div class="section-header"><h3>❌ Rejected</h3></div>
<div class="section-body" id="rejectedOrders"><div class="empty">Loading...</div></div></div>
</div>

<!-- BROADCAST PAGE -->
<div class="page" id="page-broadcast">
<div class="section"><div class="section-header"><h3>📢 New Broadcast</h3></div>
<div class="section-body">
<div class="info-box">✅ Sab registered customers ko message jayega</div>
<div class="form-group"><label>Message</label>
<textarea id="bc_message" rows="6" placeholder="Broadcast message likho..."></textarea></div>
<div class="form-group"><label>Delay Between Messages (seconds)</label>
<input type="number" id="bc_delay" value="3" min="1" max="30"/></div>
<button class="save-btn" onclick="sendBroadcast()">📢 Send Broadcast</button>
</div></div>
<div class="section"><div class="section-header"><h3>📋 Broadcast History</h3></div>
<div class="section-body" id="broadcastHistory"><div class="empty">Loading...</div></div>
</div></div>

<!-- CUSTOMERS PAGE -->
<div class="page" id="page-customers">
<div class="section">
<div class="section-header"><h3>👥 Customers</h3><span id="customerCount" style="color:#aaa;font-size:13px"></span></div>
<div class="section-body" id="customersList"><div class="empty">Loading...</div></div>
</div></div>

<!-- PRODUCTS PAGE -->
<div class="page" id="page-products">
<div class="section">
<div class="section-header"><h3>🎨 Products</h3>
<button class="btn btn-green" onclick="addProduct()">+ Add</button></div>
<div class="section-body" id="productsList"></div>
</div></div>

<!-- PAYMENT PAGE -->
<div class="page" id="page-payment">
<div class="section"><div class="section-header"><h3>💳 Payment Details</h3></div>
<div class="section-body">
<h4 style="color:#aaa;margin-bottom:12px">📱 EasyPaisa</h4>
<div class="form-group"><label>Number</label><input id="ep_number"/></div>
<div class="form-group"><label>Account Name</label><input id="ep_name"/></div>
<h4 style="color:#aaa;margin:15px 0 12px">📱 JazzCash</h4>
<div class="form-group"><label>Number</label><input id="jc_number"/></div>
<div class="form-group"><label>Account Name</label><input id="jc_name"/></div>
<h4 style="color:#aaa;margin:15px 0 12px">🏦 Bank</h4>
<div class="form-group"><label>Bank Name</label><input id="bank_name"/></div>
<div class="form-group"><label>Account Number</label><input id="bank_acc"/></div>
<div class="form-group"><label>Account Holder</label><input id="bank_holder"/></div>
<div class="form-group"><label>IBAN</label><input id="bank_iban"/></div>
<button class="save-btn" onclick="savePayment()">💾 Save</button>
</div></div></div>

<!-- AI PROMPT PAGE -->
<div class="page" id="page-prompt">
<div class="section"><div class="section-header"><h3>🤖 AI Prompt</h3></div>
<div class="section-body">
<div class="warn-box">⚠️ ORDER_READY word zaroor rakho! Price negotiation rules bhi rakho!</div>
<div class="form-group"><textarea id="aiPrompt" rows="25" style="min-height:450px;font-size:13px;"></textarea></div>
<button class="save-btn" onclick="savePrompt()">💾 Save Prompt</button>
</div></div></div>

<!-- SETTINGS PAGE -->
<div class="page" id="page-settings">
<div class="section"><div class="section-header"><h3>⚙️ Settings</h3></div>
<div class="section-body">
<div class="form-group"><label>Business Name</label><input id="s_bizName"/></div>
<div class="form-group"><label>Admin WhatsApp (92XXXXXXXXXX)</label><input id="s_adminNum"/></div>
<div class="form-group"><label>New Password (khali chhodo agar same rakho)</label>
<input id="s_password" type="password"/></div>
<button class="save-btn" onclick="saveSettings()">💾 Save</button>
</div></div>
<div class="section" style="margin-top:20px">
<div class="section-header"><h3>📱 WhatsApp Session</h3></div>
<div class="section-body">
<div class="info-box">✅ Session Upstash mein save!</div>
<p style="color:#aaa;font-size:13px;margin-bottom:15px">Problem ho toh reset karo — naya QR scan karna hoga.</p>
<button class="btn btn-red" onclick="resetSession()">🔄 Reset Session</button>
</div></div></div>
</div>

<!-- Message Modal -->
<div class="msg-modal" id="msgModal">
<div class="msg-box">
<h3 style="margin-bottom:15px;color:white;">💬 Message Bhejo</h3>
<input type="hidden" id="msgJid"/>
<div class="form-group"><label>Message</label>
<textarea id="msgText" rows="4" placeholder="Message likho..."></textarea></div>
<div class="btn-row">
<button class="btn btn-green" onclick="sendCustomMsg()">📤 Send</button>
<button class="btn btn-gray" onclick="closeModal()">Cancel</button>
</div></div></div>

<div class="toast" id="toast"></div>

<script>
let allData={};let products=[];

async function loadData(){
try{const r=await fetch('/api/data');allData=await r.json();
products=JSON.parse(JSON.stringify(allData.products||[]));renderAll();}
catch(e){console.error(e);}
}

function renderAll(){
const b=document.getElementById('botBadge');
b.className='bot-badge '+(allData.botStatus==='connected'?'badge-live':'badge-off');
b.textContent=allData.botStatus==='connected'?'🟢 Bot Live':'🔴 '+allData.botStatus;
const s=allData.stats||{};
document.getElementById('statsGrid').innerHTML=\`
<div class="stat-card" style="border-top:3px solid #f39c12"><h2 style="color:#f39c12">\${s.pending||0}</h2><p>⏳ Pending</p></div>
<div class="stat-card" style="border-top:3px solid #25D366"><h2 style="color:#25D366">\${s.approved||0}</h2><p>✅ Approved</p></div>
<div class="stat-card" style="border-top:3px solid #e74c3c"><h2 style="color:#e74c3c">\${s.rejected||0}</h2><p>❌ Rejected</p></div>
<div class="stat-card" style="border-top:3px solid #3498db"><h2 style="color:#3498db">\${s.customers||0}</h2><p>👥 Customers</p></div>\`;
document.getElementById('revenue').textContent='PKR '+(s.revenue||0).toLocaleString();
document.getElementById('revenueDetail').textContent=(s.approved||0)+' approved orders';
renderOrders();renderBroadcast();renderCustomers();renderProducts();renderPayment();renderPrompt();renderSettings();
}

function renderOrders(){
const orders=Object.values(allData.orders||{}).sort((a,b)=>b.timestamp-a.timestamp);
const pending=orders.filter(o=>o.status==='pending');
const approved=orders.filter(o=>o.status==='approved');
const rejected=orders.filter(o=>o.status==='rejected');
document.getElementById('pendingOrders').innerHTML=pending.length===0?'<div class="empty">Koi pending order nahi ✅</div>':pending.map(orderCard).join('');
document.getElementById('approvedOrders').innerHTML=approved.length===0?'<div class="empty">Koi approved order nahi</div>':approved.map(orderCard).join('');
document.getElementById('rejectedOrders').innerHTML=rejected.length===0?'<div class="empty">Koi rejected order nahi</div>':rejected.map(orderCard).join('');
}

function orderCard(o){
const time=new Date(o.timestamp).toLocaleString('en-PK');
const bc=o.status==='pending'?'bp':o.status==='approved'?'ba':'br';
const langBadge=o.language?'<span style="background:#333;padding:2px 8px;border-radius:10px;font-size:11px;color:#aaa;">'+o.language+'</span>':'';
const actions=o.status==='pending'
?\`<button class="btn btn-green" onclick="approveOrder(\${o.orderId})">✅ Approve</button>
<button class="btn btn-red" onclick="rejectOrder(\${o.orderId})">❌ Reject</button>
<button class="btn btn-blue" onclick="openMsg('\${o.customerJid}')">💬 Message</button>\`
:\`<button class="btn btn-blue" onclick="openMsg('\${o.customerJid}')">💬 Message</button>\`;
return \`<div class="order-card \${o.status}">
<div class="order-header"><span class="order-id">#\${o.orderId}</span>
<div style="display:flex;gap:6px;align-items:center;">\${langBadge}<span class="badge \${bc}">\${o.status.toUpperCase()}</span></div>
</div><div class="order-info">
📱 Number: <b>\${o.customerNumber}</b><br>
👤 Name: <b>\${o.customerName||'N/A'}</b><br>
📸 Screenshot: <b>\${o.hasScreenshot?'✅ Received':'❌ Pending'}</b><br>
📅 Time: <b>\${time}</b></div>
<div class="btn-row">\${actions}</div></div>\`;
}

async function approveOrder(id){if(!confirm('Approve?'))return;await fetch('/api/approve/'+id,{method:'POST'});showToast('✅ Approved!');loadData();}
async function rejectOrder(id){if(!confirm('Reject?'))return;await fetch('/api/reject/'+id,{method:'POST'});showToast('❌ Rejected!');loadData();}

function renderBroadcast(){
const broadcasts=allData.broadcasts||[];
document.getElementById('broadcastHistory').innerHTML=broadcasts.length===0
?'<div class="empty">Koi broadcast nahi</div>'
:broadcasts.map(b=>\`<div class="broadcast-card \${b.status}">
<div style="display:flex;justify-content:space-between;margin-bottom:8px;">
<span style="font-weight:bold;color:white;">\${b.status==='completed'?'✅':'b.status==='running'?'⏳':'🕐'} \${b.status.toUpperCase()}</span>
<span style="color:#aaa;font-size:12px;">\${new Date(b.createdAt).toLocaleString('en-PK')}</span></div>
<p style="color:#ccc;font-size:13px;margin-bottom:8px;">\${b.message.substring(0,100)}\${b.message.length>100?'...':''}</p>
<p style="color:#aaa;font-size:12px;">Sent: \${b.sentCount||0} | Failed: \${b.failedCount||0} | Total: \${b.totalCustomers||0} | Delay: \${b.delaySeconds}s</p>
</div>\`).join('');
}

async function sendBroadcast(){
const message=document.getElementById('bc_message').value;
const delay=parseInt(document.getElementById('bc_delay').value)||3;
if(!message.trim()){showToast('❌ Message likho!');return;}
if(!confirm('Broadcast bhejein '+Object.keys(allData.customers||{}).length+' customers ko?'))return;
const r=await fetch('/api/broadcast',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message,delaySeconds:delay})});
const d=await r.json();
if(d.success){showToast('✅ Broadcast shuru!');document.getElementById('bc_message').value='';loadData();}
else showToast('❌ Error!');
}

function renderCustomers(){
const customers=Object.values(allData.customers||{}).sort((a,b)=>b.lastSeen-a.lastSeen);
const cc=document.getElementById('customerCount');
if(cc)cc.textContent=customers.length+' total';
document.getElementById('customersList').innerHTML=customers.length===0
?'<div class="empty">Koi customer nahi abhi</div>'
:customers.map(c=>\`<div class="customer-card">
<div><p style="font-weight:bold;color:white;">\${c.name||'Unknown'}</p>
<p style="color:#aaa;font-size:12px;">\${c.number} • \${c.language||'unknown'} • \${new Date(c.lastSeen).toLocaleDateString('en-PK')}</p></div>
<button class="btn btn-blue" onclick="openMsg('\${c.jid}')">💬</button>
</div>\`).join('');
}

function renderProducts(){
const el=document.getElementById('productsList');
if(!products.length){el.innerHTML='<div class="empty">Koi product nahi</div>';return;}
el.innerHTML=products.map((p,i)=>\`<div class="product-card">
<div class="product-header"><span style="font-size:16px;font-weight:bold;color:white;">\${p.name}</span>
<label class="toggle"><input type="checkbox" \${p.active?'checked':''} onchange="products[\${i}].active=this.checked"/>
<span class="slider"></span></label></div>
<div class="form-group"><label>Name</label><input value="\${p.name}" onchange="products[\${i}].name=this.value"/></div>
<div class="form-group"><label>Price (PKR)</label><input type="number" value="\${p.price}" onchange="products[\${i}].price=parseInt(this.value)||0"/></div>
<div class="form-group"><label>Description</label><textarea onchange="products[\${i}].description=this.value">\${p.description||''}</textarea></div>
<div class="form-group"><label>⬇️ Download Link</label><input value="\${p.downloadLink||''}" placeholder="https://drive.google.com/..." onchange="products[\${i}].downloadLink=this.value"/></div>
<div class="form-group"><label>Features</label>
<div class="feature-list">\${(p.features||[]).map((f,j)=>\`<div class="feature-tag">\${f}<button onclick="removeFeature(\${i},\${j})">×</button></div>\`).join('')}</div>
<div class="feature-input"><input id="nf_\${i}" placeholder="New feature..." onkeypress="if(event.key==='Enter')addFeature(\${i})"/>
<button onclick="addFeature(\${i})">+</button></div></div>
<div class="btn-row">
<button class="btn btn-green" onclick="saveProducts()">💾 Save</button>
<button class="btn btn-red" onclick="removeProduct(\${i})">🗑️ Delete</button>
</div></div>\`).join('');
}

function addFeature(i){const inp=document.getElementById('nf_'+i);if(!inp.value.trim())return;if(!products[i].features)products[i].features=[];products[i].features.push(inp.value.trim());inp.value='';renderProducts();}
function removeFeature(i,j){products[i].features.splice(j,1);renderProducts();}
function addProduct(){products.push({id:Date.now(),name:'New Product',price:999,description:'',features:[],downloadLink:'',active:false});renderProducts();}
function removeProduct(i){if(confirm('Delete?')){products.splice(i,1);renderProducts();}}
async function saveProducts(){const r=await fetch('/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(products)});const d=await r.json();showToast(d.success?'✅ Saved!':'❌ Error!');loadData();}

function renderPayment(){const p=allData.payment||{};
document.getElementById('ep_number').value=p.easypaisa?.number||'';
document.getElementById('ep_name').value=p.easypaisa?.name||'';
document.getElementById('jc_number').value=p.jazzcash?.number||'';
document.getElementById('jc_name').value=p.jazzcash?.name||'';
document.getElementById('bank_name').value=p.bank?.bankName||'';
document.getElementById('bank_acc').value=p.bank?.accountNumber||'';
document.getElementById('bank_holder').value=p.bank?.accountName||'';
document.getElementById('bank_iban').value=p.bank?.iban||'';}

async function savePayment(){
const data={easypaisa:{number:document.getElementById('ep_number').value,name:document.getElementById('ep_name').value},
jazzcash:{number:document.getElementById('jc_number').value,name:document.getElementById('jc_name').value},
bank:{bankName:document.getElementById('bank_name').value,accountNumber:document.getElementById('bank_acc').value,
accountName:document.getElementById('bank_holder').value,iban:document.getElementById('bank_iban').value}};
const r=await fetch('/api/payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const d=await r.json();showToast(d.success?'✅ Payment Saved!':'❌ Error!');}

function renderPrompt(){document.getElementById('aiPrompt').value=allData.aiPrompt||'';}
async function savePrompt(){const r=await fetch('/api/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:document.getElementById('aiPrompt').value})});const d=await r.json();showToast(d.success?'✅ Prompt Saved!':'❌ Error!');}

function renderSettings(){const s=allData.settings||{};document.getElementById('s_bizName').value=s.businessName||'';document.getElementById('s_adminNum').value=s.adminNumber||'';}
async function saveSettings(){const pass=document.getElementById('s_password').value;const data={businessName:document.getElementById('s_bizName').value,adminNumber:document.getElementById('s_adminNum').value};if(pass)data.dashboardPassword=pass;const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const d=await r.json();showToast(d.success?'✅ Saved!':'❌ Error!');document.getElementById('s_password').value='';}

async function resetSession(){if(!confirm('Session reset? Naya QR scan karna hoga!'))return;await fetch('/api/reset-session',{method:'POST'});showToast('🔄 Resetting...');setTimeout(()=>window.location='/qr',3000);}

function showPage(page,el){
document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
document.getElementById('page-'+page).classList.add('active');
if(el)el.classList.add('active');
const titles={orders:'📦 Orders',broadcast:'📢 Broadcast',customers:'👥 Customers',products:'🎨 Products',payment:'💳 Payment',prompt:'🤖 AI Prompt',settings:'⚙️ Settings'};
document.getElementById('pageTitle').textContent=titles[page]||page;
const showStats=['orders'].includes(page);
document.getElementById('statsGrid').style.display=showStats?'grid':'none';
document.getElementById('revenueCard').style.display=showStats?'block':'none';
}

function openMsg(jid){document.getElementById('msgJid').value=jid;document.getElementById('msgModal').classList.add('show');}
function closeModal(){document.getElementById('msgModal').classList.remove('show');}
async function sendCustomMsg(){const jid=document.getElementById('msgJid').value;const message=document.getElementById('msgText').value;if(!message.trim())return;const r=await fetch('/api/send-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid,message})});const d=await r.json();showToast(d.success?'✅ Sent!':'❌ Error!');if(d.success){closeModal();document.getElementById('msgText').value='';}}

function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';setTimeout(()=>t.style.display='none',3000);}

loadData();setInterval(loadData,15000);
</script>
</body></html>`);
        return;
    }

    res.writeHead(302, { Location: '/dashboard' });
    res.end();
});

server.listen(process.env.PORT || 3000, () => {
    console.log('🌐 Server ready! Dashboard: /dashboard | QR: /qr');
});

// ─────────────────────────────────────────
// MESSAGE HANDLER
// ─────────────────────────────────────────
async function handleMessage(sock, message) {
    try {
        if (message.key.fromMe) return;

        const senderId = message.key?.remoteJid;
        if (!senderId) return;

        // Ignore broadcasts/newsletters/groups
        if (senderId === 'status@broadcast') return;
        if (senderId.endsWith('@broadcast')) return;
        if (senderId.includes('newsletter')) return;
        if (senderId.endsWith('@g.us')) return;

        const senderName = message.pushName || 'Customer';
        const msgType = Object.keys(message.message || {})[0];

        // Save customer to database
        if (!botData.customers) botData.customers = {};
        botData.customers[senderId] = {
            jid: senderId,
            number: senderId.replace('@s.whatsapp.net', ''),
            name: senderName,
            lastSeen: Date.now(),
            language: botData.customers[senderId]?.language || 'unknown'
        };

        // VOICE MESSAGE
        if (msgType === 'audioMessage' || msgType === 'pttMessage') {
            console.log(`🎤 Voice message from ${senderName}`);
            try {
                await sock.sendPresenceUpdate('composing', senderId);
                const buffer = await downloadMediaMessage(message, 'buffer', {});
                const transcribed = await voiceToText(buffer);

                if (transcribed && transcribed.trim()) {
                    console.log(`📝 Transcribed: ${transcribed}`);
                    const lang = detectLanguage(transcribed);
                    botData.customers[senderId].language = lang;
                    await saveData();

                    const aiReply = await getAISalesResponse(transcribed, senderId, senderName, lang);
                    await sock.sendPresenceUpdate('paused', senderId);

                    const voicePrefix = {
                        urdu: `🎤 آپ نے کہا: "${transcribed}"\n\n`,
                        roman_urdu: `🎤 Aap ne kaha: "${transcribed}"\n\n`,
                        english: `🎤 You said: "${transcribed}"\n\n`
                    };

                    await sock.sendMessage(senderId, {
                        text: (voicePrefix[lang] || voicePrefix.roman_urdu) + aiReply.message
                    }, { quoted: message });

                    if (aiReply.shouldOrder) {
                        await handleOrder(sock, senderId, senderName, aiReply, message, lang);
                    }
                } else {
                    await sock.sendPresenceUpdate('paused', senderId);
                    await sock.sendMessage(senderId, {
                        text: '⚠️ Voice message samajh nahi aaya. Please text mein likhein! 🙏'
                    });
                }
            } catch (e) {
                console.log('Voice error:', e.message);
                await sock.sendMessage(senderId, {
                    text: '⚠️ Voice message process nahi ho saka. Text mein likhein please!'
                });
            }
            return;
        }

        // SCREENSHOT/IMAGE
        if (msgType === 'imageMessage') {
            const existingOrder = Object.values(botData.orders).find(
                o => o.customerJid === senderId && o.status === 'pending'
            );
            if (existingOrder) {
                existingOrder.hasScreenshot = true;
                await saveData();
                const lang = botData.customers[senderId]?.language || 'roman_urdu';
                const msgs = {
                    urdu: `📸 *اسکرین شاٹ موصول ہو گیا!*\n\nآرڈر *#${existingOrder.orderId}*\n\n✅ ایڈمن تصدیق کر رہا ہے\n⏳ 1 گھنٹے میں ڈلیوری!\n\nشکریہ! 🙏`,
                    roman_urdu: `📸 *Screenshot Receive Ho Gaya!*\n\nOrder *#${existingOrder.orderId}*\n\n✅ Admin verify kar raha hai\n⏳ 1 ghante mein delivery!\n\nShukriya! 🙏`,
                    english: `📸 *Screenshot Received!*\n\nOrder *#${existingOrder.orderId}*\n\n✅ Admin is verifying\n⏳ Delivery within 1 hour!\n\nThank you! 🙏`
                };
                await sock.sendMessage(senderId, { text: msgs[lang] || msgs.roman_urdu });

                const adminJid = botData.settings.adminNumber + '@s.whatsapp.net';
                try {
                    await sock.sendMessage(adminJid, {
                        text: `🔔 *New Payment Screenshot!*\n\nOrder: *#${existingOrder.orderId}*\nCustomer: ${senderName}\nNumber: ${existingOrder.customerNumber}\nLanguage: ${lang}\n\nDashboard pe approve/reject karo! ⚡`
                    });
                } catch (e) {}
            } else {
                const lang = botData.customers[senderId]?.language || 'roman_urdu';
                const aiReply = await getAISalesResponse('[Customer ne image bheja bina order ke]', senderId, senderName, lang);
                await sock.sendMessage(senderId, { text: aiReply.message });
            }
            return;
        }

        // TEXT MESSAGE
        const userMessage =
            message.message?.conversation ||
            message.message?.extendedTextMessage?.text || '';

        if (!userMessage.trim()) return;

        const lang = detectLanguage(userMessage);
        botData.customers[senderId].language = lang;
        await saveData();

        console.log(`📩 ${senderName} [${lang}]: ${userMessage}`);
        await sock.sendPresenceUpdate('composing', senderId);

        const aiReply = await getAISalesResponse(userMessage, senderId, senderName, lang);
        await sock.sendPresenceUpdate('paused', senderId);

        if (aiReply.shouldOrder) {
            await handleOrder(sock, senderId, senderName, aiReply, message, lang);
        } else {
            await sock.sendMessage(senderId, { text: aiReply.message }, { quoted: message });
        }

    } catch (err) {
        console.error('Handle error:', err.message);
    }
}

// Handle order creation
async function handleOrder(sock, senderId, senderName, aiReply, message, lang) {
    botData.orderCounter++;
    const orderId = botData.orderCounter;
    const product = aiReply.product || botData.products[0];

    botData.orders[senderId] = {
        orderId,
        customerJid: senderId,
        customerNumber: senderId.replace('@s.whatsapp.net', ''),
        customerName: senderName,
        productId: product?.id,
        language: lang,
        status: 'pending',
        hasScreenshot: false,
        timestamp: Date.now()
    };
    await saveData();

    // Save to Google Sheets
    await saveToGoogleSheet({
        orderId,
        customerName: senderName,
        customerNumber: senderId.replace('@s.whatsapp.net', ''),
        product: product?.name,
        amount: product?.price,
        status: 'pending',
        language: lang
    });

    if (aiReply.message) {
        await sock.sendMessage(senderId, { text: aiReply.message }, { quoted: message });
        await new Promise(r => setTimeout(r, 1500));
    }
    await sock.sendMessage(senderId, { text: getPaymentMessage(orderId, product, lang) });
    console.log(`🛒 New Order: #${orderId} for ${senderName} [${lang}]`);
}

// ─────────────────────────────────────────
// WHATSAPP BOT
// ─────────────────────────────────────────
async function startBot() {
    try {
        console.log('🔄 Bot start ho raha hai...');
        await loadData();

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
                console.log('📱 QR Ready! /qr pe jao!');
            }

            if (connection === 'close') {
                currentQR = null;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log('❌ Disconnected, code:', code);

                if (code === DisconnectReason.loggedOut) {
                    botStatus = 'logged_out';
                    try {
                        await redisSet('wa_auth_state', {});
                        await redisSet('wa_creds', null);
                    } catch (e) {}
                    setTimeout(startBot, 5000);

                } else if (!code || code === undefined) {
                    botStatus = 'reconnecting';
                    console.log('⚠️ Undefined code — credentials clear karke fresh QR...');
                    try {
                        await redisSet('wa_auth_state', {});
                        await redisSet('wa_creds', null);
                    } catch (e) {}
                    setTimeout(startBot, 5000);

                } else if (code === 405) {
                    botStatus = 'reconnecting';
                    console.log('⚠️ 405 — 20sec mein retry...');
                    setTimeout(startBot, 20000);

                } else {
                    botStatus = 'reconnecting';
                    setTimeout(startBot, 10000);
                }
            }

            if (connection === 'open') {
                currentQR = null;
                botStatus = 'connected';
                console.log('✅ WhatsApp Connected! Mega Agency LIVE!');
                // Init Google Sheet headers
                await initGoogleSheet();
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const message of messages) {
                await handleMessage(sock, message);
            }
        });

    } catch (err) {
        console.error('Bot error:', err.message);
        botStatus = 'error';
        setTimeout(startBot, 15000);
    }
}

console.log('🚀 Mega Agency AI Sales Bot v2 start ho raha hai...');
startBot();
