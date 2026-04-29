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

// Config Load
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

let currentQR = null;
let botStatus = 'starting';
let sockGlobal = null;

// Orders + State
const orders = {};
const salesHistory = {};
let orderCounter = 1000;

// Orders Load
function loadOrders() {
    try {
        if (fs.existsSync('/tmp/orders.json')) {
            const data = JSON.parse(fs.readFileSync('/tmp/orders.json', 'utf8'));
            Object.assign(orders, data.orders || {});
            orderCounter = data.orderCounter || 1000;
        }
    } catch (e) {
        console.log('Orders load error:', e.message);
    }
}

// Orders Save
function saveOrders() {
    try {
        fs.writeFileSync('/tmp/orders.json', JSON.stringify({ orders, orderCounter }));
    } catch (e) {
        console.log('Orders save error:', e.message);
    }
}

loadOrders();

// ─────────────────────────────────────────
// PAYMENT MESSAGE
// ─────────────────────────────────────────
function getPaymentMessage(orderId) {
    return `🛒 *Order Confirmed!*
Order ID: *#${orderId}*

━━━━━━━━━━━━━━━━━━━━
💳 *Payment Details — PKR ${config.business.price}*

📱 *EasyPaisa:*
Number: ${config.payment.easypaisa.number}
Name: ${config.payment.easypaisa.name}

📱 *JazzCash:*
Number: ${config.payment.jazzcash.number}
Name: ${config.payment.jazzcash.name}

🏦 *Bank Transfer:*
Bank: ${config.payment.bank.bankName}
Account: ${config.payment.bank.accountNumber}
Name: ${config.payment.bank.accountName}
IBAN: ${config.payment.bank.iban}

━━━━━━━━━━━━━━━━━━━━
✅ Payment karne ke baad *screenshot* bhejo
📦 1 hour mein delivery guaranteed!`;
}

// ─────────────────────────────────────────
// AI SALES SYSTEM PROMPT
// ─────────────────────────────────────────
const SALES_SYSTEM_PROMPT = `Tum Mega Agency ke professional AI Sales Agent ho. Tumhara naam "Max" hai.

TUMHARI SERVICE:
- Product: 100+ Premium Shopify Themes Mega Bundle
- Price: PKR 999 ONLY (yahi final price hai — koi aur price mat batana)
- Delivery: Payment approve hone ke 1 hour baad
- Features: 100+ themes, fashion/electronics/food/all niches, regular updates, installation guide, 24/7 support, mobile optimized, fast loading

TUMHARA KAAM:
1. Customer se warmly greet karo — unka naam lo
2. Pehle unke baare mein poocho — kaunsa niche, naya store ya existing
3. Unke niche ke hisaab se themes ki VALUE explain karo specifically
4. Price objections confidently handle karo
5. Trust build karo — social proof, results, value
6. Guidance do — kaise install karein, kaunsa theme best hai unke liye
7. Jab customer BUY karna chahe — ORDER_READY likho

SELLING TECHNIQUES:
- Value Stack: "Market mein ek theme 5000-50000 ki hai, 100+ sirf PKR 999 mein"
- Per Unit: "Sirf PKR 10 per theme — yeh deal kahan milegi?"
- Social Proof: "1000+ Pakistani store owners yeh use kar rahe hain"
- FOMO: "Tumhare competitors already yeh themes use kar rahe hain"
- Urgency: "Limited time offer — price kabhi bhi badh sakta hai"
- ROI: "Ek sale se 999 wapas aa jata hai — theme investment nahi, asset hai"
- Niche Specific: Fashion ke liye fashion themes, food ke liye food themes

OBJECTIONS HANDLE KARO:
- "Mehenga hai" → Value compare karo, per theme price batao
- "Sochna hai" → FOMO create karo, urgency add karo
- "Pehle dekh lein" → Trust build karo, guarantee batao
- "Kaam karega?" → Success stories batao, guarantee do
- "Baad mein" → Abhi lene ka reason do

SUPPORT AND GUIDANCE:
- Installation step by step explain karo agar poochein
- Theme selection guidance do niche ke hisaab se
- Shopify basics explain karo agar naya hai
- Customization tips do

STRICT RULES:
- PRICE SIRF PKR 999 — koi aur price KABHI mat batana
- SIRF Shopify themes sell karo — koi aur service nahi
- Agar koi aur service pooche — politely decline karo
- Customer ki language follow karo — Urdu/English/Roman Urdu
- Short replies — 3-4 lines max — zyada lamba mat likho
- Friendly emojis use karo
- Jab customer buy kare — ORDER_READY likho response ke bilkul start mein`;

// ─────────────────────────────────────────
// AI SALES RESPONSE
// ─────────────────────────────────────────
async function getAISalesResponse(userMessage, userId, customerName) {
    if (!salesHistory[userId]) salesHistory[userId] = [];

    salesHistory[userId].push({ role: 'user', content: userMessage });
    if (salesHistory[userId].length > 30) {
        salesHistory[userId] = salesHistory[userId].slice(-30);
    }

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
            const url = provider === 'groq'
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
                    'HTTP-Referer': 'https://github.com/mega-agency-bot',
                    'X-Title': 'Mega Agency Bot'
                };

            const response = await axios.post(url, {
                model,
                messages: [
                    {
                        role: 'system',
                        content: SALES_SYSTEM_PROMPT + `\n\nCustomer ka naam: ${customerName}`
                    },
                    ...salesHistory[userId]
                ],
                max_tokens: 350,
                temperature: 0.85
            }, { headers, timeout: 15000 });

            const aiMessage = response.data.choices[0].message.content;
            salesHistory[userId].push({ role: 'assistant', content: aiMessage });

            const shouldOrder = aiMessage.toUpperCase().includes('ORDER_READY');
            const cleanMessage = aiMessage.replace(/ORDER_READY/gi, '').trim();

            console.log(`✅ AI Sales: ${provider}/${model}`);
            return { message: cleanMessage, shouldOrder };

        } catch (err) {
            console.log(`❌ ${provider}/${model} fail: ${err.message}`);
            if (salesHistory[userId].length > 0) {
                salesHistory[userId].pop();
            }
        }
    }

    return {
        message: '⚠️ Thodi technical difficulty aa gayi. 1 minute mein dobara message karo! 🙏',
        shouldOrder: false
    };
}

// ─────────────────────────────────────────
// WEB SERVER — QR + DASHBOARD
// ─────────────────────────────────────────
const server = http.createServer(async (req, res) => {

    // QR Page
    if (req.url === '/qr') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (botStatus === 'connected') {
            res.end(`<html><head><style>
                body{background:#111;color:white;display:flex;flex-direction:column;
                align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;}
                h2{color:#25D366;}a{color:#25D366;font-size:18px;margin-top:20px;display:block;}
                </style></head><body>
                <h2>✅ Bot Connected!</h2>
                <p>Mega Agency Bot live hai!</p>
                <a href="/dashboard">📊 Dashboard Kholo</a>
                </body></html>`);
            return;
        }
        if (!currentQR) {
            res.end(`<html><head><meta http-equiv="refresh" content="3">
                <style>body{background:#111;color:white;display:flex;flex-direction:column;
                align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;}
                h2{color:#f39c12;}</style></head>
                <body><h2>⏳ QR Generate Ho Raha Hai...</h2>
                <p>Status: ${botStatus}</p><p>3 sec mein refresh</p></body></html>`);
            return;
        }
        try {
            const qrDataURL = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
            res.end(`<html><head><meta http-equiv="refresh" content="25">
                <style>body{background:#111;color:white;display:flex;flex-direction:column;
                align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;
                text-align:center;padding:20px;}h2{color:#25D366;}
                img{border:8px solid white;border-radius:12px;width:280px;height:280px;}
                .steps{background:#222;padding:15px;border-radius:10px;text-align:left;
                max-width:320px;margin-top:15px;}p{color:#aaa;}</style></head>
                <body><h2>📱 WhatsApp QR Code</h2>
                <img src="${qrDataURL}"/>
                <div class="steps">
                <p>1️⃣ WhatsApp kholo</p>
                <p>2️⃣ 3 dots → Linked Devices</p>
                <p>3️⃣ Link a Device</p>
                <p>4️⃣ QR scan karo</p></div>
                <p style="color:#f39c12;margin-top:15px">⚠️ 25 sec mein expire!</p>
                </body></html>`);
        } catch (err) {
            res.end('<h1 style="color:red">QR Error: ' + err.message + '</h1>');
        }
        return;
    }

    // Admin Dashboard
    if (req.url === '/dashboard') {
        const pendingOrders = Object.values(orders).filter(o => o.status === 'pending');
        const approvedOrders = Object.values(orders).filter(o => o.status === 'approved');
        const rejectedOrders = Object.values(orders).filter(o => o.status === 'rejected');
        const totalRevenue = approvedOrders.length * config.business.price;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head>
<title>${config.business.name} - Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#0f0f0f;color:white;font-family:'Segoe UI',sans-serif;}
.header{background:linear-gradient(135deg,#1a1a2e,#16213e);padding:25px;text-align:center;border-bottom:3px solid #25D366;}
.header h1{color:#25D366;font-size:26px;}
.header p{color:#aaa;font-size:13px;margin-top:5px;}
.bot-status{text-align:center;padding:10px;font-size:14px;
background:${botStatus === 'connected' ? '#0d2b0d' : '#2b0d0d'};
color:${botStatus === 'connected' ? '#25D366' : '#e74c3c'};}
.stats{display:flex;gap:12px;padding:20px;flex-wrap:wrap;justify-content:center;}
.stat{background:#1a1a1a;border-radius:12px;padding:18px;text-align:center;flex:1;min-width:100px;}
.stat h2{font-size:30px;font-weight:bold;}
.stat p{color:#aaa;font-size:11px;margin-top:4px;}
.revenue{background:linear-gradient(135deg,#1a1a2e,#1a2e1a);border-radius:12px;
margin:0 20px 20px;padding:18px;text-align:center;}
.revenue h2{color:#f39c12;font-size:30px;}
.revenue p{color:#aaa;font-size:12px;}
.section{padding:0 15px 20px;}
.section h3{font-size:17px;margin-bottom:12px;padding:10px 0;border-bottom:1px solid #333;}
.card{background:#1a1a1a;border-radius:12px;padding:15px;margin-bottom:10px;}
.card.pending{border-left:4px solid #f39c12;}
.card.approved{border-left:4px solid #25D366;}
.card.rejected{border-left:4px solid #e74c3c;}
.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.order-id{font-weight:bold;color:#25D366;}
.badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:bold;}
.badge-pending{background:#f39c12;color:black;}
.badge-approved{background:#25D366;color:black;}
.badge-rejected{background:#e74c3c;color:white;}
.info{color:#ccc;font-size:13px;line-height:1.8;}
.info span{color:white;font-weight:bold;}
.btns{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
.btn{padding:8px 18px;border:none;border-radius:8px;cursor:pointer;
font-size:13px;font-weight:bold;text-decoration:none;display:inline-block;}
.btn-approve{background:#25D366;color:black;}
.btn-reject{background:#e74c3c;color:white;}
.empty{text-align:center;color:#444;padding:25px;font-size:14px;}
</style></head>
<body>
<div class="header">
<h1>🏪 ${config.business.name}</h1>
<p>Admin Dashboard — Orders Management</p>
</div>
<div class="bot-status">
Bot: ${botStatus === 'connected' ? '✅ Connected & Running' : '❌ ' + botStatus}
</div>
<div class="stats">
<div class="stat" style="border-top:3px solid #f39c12">
<h2 style="color:#f39c12">${pendingOrders.length}</h2><p>⏳ Pending</p></div>
<div class="stat" style="border-top:3px solid #25D366">
<h2 style="color:#25D366">${approvedOrders.length}</h2><p>✅ Approved</p></div>
<div class="stat" style="border-top:3px solid #e74c3c">
<h2 style="color:#e74c3c">${rejectedOrders.length}</h2><p>❌ Rejected</p></div>
<div class="stat" style="border-top:3px solid #9b59b6">
<h2 style="color:#9b59b6">${Object.values(orders).length}</h2><p>📦 Total</p></div>
</div>
<div class="revenue">
<p>💰 Total Revenue</p>
<h2>PKR ${totalRevenue.toLocaleString()}</h2>
<p>${approvedOrders.length} orders x PKR ${config.business.price}</p>
</div>
<div class="section">
<h3 style="color:#f39c12">⏳ Pending Orders (${pendingOrders.length})</h3>
${pendingOrders.length === 0
    ? '<div class="empty">Koi pending order nahi</div>'
    : pendingOrders.map(o => `
<div class="card pending">
<div class="card-header">
<span class="order-id">#${o.orderId}</span>
<span class="badge badge-pending">PENDING</span>
</div>
<div class="info">
📱 Number: <span>${o.customerNumber}</span><br>
👤 Name: <span>${o.customerName || 'N/A'}</span><br>
💰 Amount: <span>PKR ${config.business.price}</span><br>
📸 Screenshot: <span>${o.hasScreenshot ? '✅ Received' : '❌ Nahi aaya'}</span><br>
📅 Time: <span>${new Date(o.timestamp).toLocaleString('en-PK')}</span>
</div>
<div class="btns">
<a href="/approve/${o.orderId}" class="btn btn-approve">✅ Approve</a>
<a href="/reject/${o.orderId}" class="btn btn-reject">❌ Reject</a>
</div>
</div>`).join('')}
</div>
<div class="section">
<h3 style="color:#25D366">✅ Approved Orders (${approvedOrders.length})</h3>
${approvedOrders.length === 0
    ? '<div class="empty">Koi approved order nahi</div>'
    : approvedOrders.map(o => `
<div class="card approved">
<div class="card-header">
<span class="order-id">#${o.orderId}</span>
<span class="badge badge-approved">APPROVED</span>
</div>
<div class="info">
📱 Number: <span>${o.customerNumber}</span><br>
👤 Name: <span>${o.customerName || 'N/A'}</span><br>
💰 Amount: <span>PKR ${config.business.price}</span><br>
📅 Time: <span>${new Date(o.timestamp).toLocaleString('en-PK')}</span>
</div>
</div>`).join('')}
</div>
<div class="section">
<h3 style="color:#e74c3c">❌ Rejected Orders (${rejectedOrders.length})</h3>
${rejectedOrders.length === 0
    ? '<div class="empty">Koi rejected order nahi</div>'
    : rejectedOrders.map(o => `
<div class="card rejected">
<div class="card-header">
<span class="order-id">#${o.orderId}</span>
<span class="badge badge-rejected">REJECTED</span>
</div>
<div class="info">
📱 Number: <span>${o.customerNumber}</span><br>
📅 Time: <span>${new Date(o.timestamp).toLocaleString('en-PK')}</span>
</div>
</div>`).join('')}
</div>
<script>setTimeout(()=>location.reload(),30000);</script>
</body></html>`);
        return;
    }

    // Approve Order
    if (req.url.startsWith('/approve/')) {
        const orderId = parseInt(req.url.split('/approve/')[1]);
        const order = Object.values(orders).find(o => o.orderId === orderId);
        if (order && sockGlobal) {
            order.status = 'approved';
            saveOrders();
            try {
                await sockGlobal.sendMessage(order.customerJid, {
                    text: `🎉 *Payment Approved!*\n\n` +
                          `Order *#${order.orderId}* confirm ho gaya!\n\n` +
                          `📦 Tumhara 100+ Shopify Themes Bundle\n` +
                          `⏳ 1 hour mein delivery link bheja jayega\n\n` +
                          `Koi bhi help chahiye toh message karo!\n` +
                          `Shukriya ${config.business.name} ko choose karne ka! 🙏`
                });
            } catch (e) {
                console.log('Approve msg error:', e.message);
            }
        }
        res.writeHead(302, { Location: '/dashboard' });
        res.end();
        return;
    }

    // Reject Order
    if (req.url.startsWith('/reject/')) {
        const orderId = parseInt(req.url.split('/reject/')[1]);
        const order = Object.values(orders).find(o => o.orderId === orderId);
        if (order && sockGlobal) {
            order.status = 'rejected';
            saveOrders();
            try {
                await sockGlobal.sendMessage(order.customerJid, {
                    text: `❌ *Payment Verify Nahi Ho Saki*\n\n` +
                          `Order *#${order.orderId}*\n\n` +
                          `Screenshot sahi nahi tha ya amount mismatch tha.\n` +
                          `Dobara sahi screenshot bhejo ya admin se contact karo.\n\n` +
                          `"buy" likhkar dobara try kar sakte ho! 💪`
                });
            } catch (e) {
                console.log('Reject msg error:', e.message);
            }
        }
        res.writeHead(302, { Location: '/dashboard' });
        res.end();
        return;
    }

    // Default
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: botStatus, dashboard: '/dashboard', qr: '/qr' }));
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

        const senderId = message.key.remoteJid;
        const senderName = message.pushName || 'Customer';
        const msgType = Object.keys(message.message || {})[0];

        // Screenshot Handle
        if (msgType === 'imageMessage') {
            const existingOrder = Object.values(orders).find(
                o => o.customerJid === senderId && o.status === 'pending'
            );
            if (existingOrder) {
                existingOrder.hasScreenshot = true;
                saveOrders();
                await sock.sendMessage(senderId, {
                    text: `📸 *Screenshot Receive Ho Gaya!*\n\n` +
                          `Order *#${existingOrder.orderId}*\n\n` +
                          `✅ Admin verify kar raha hai\n` +
                          `⏳ 1 hour mein themes deliver honge!\n\n` +
                          `Shukriya! 🙏`
                });
                const adminJid = config.business.adminNumber + '@s.whatsapp.net';
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
            orderCounter++;
            const orderId = orderCounter;
            orders[senderId] = {
                orderId,
                customerJid: senderId,
                customerNumber: senderId.replace('@s.whatsapp.net', ''),
                customerName: senderName,
                status: 'pending',
                hasScreenshot: false,
                timestamp: Date.now()
            };
            saveOrders();

            if (aiReply.message) {
                await sock.sendMessage(senderId, { text: aiReply.message }, { quoted: message });
                await new Promise(r => setTimeout(r, 1500));
            }
            await sock.sendMessage(senderId, { text: getPaymentMessage(orderId) });
            console.log(`🛒 New Order: #${orderId} for ${senderName}`);
        } else {
            await sock.sendMessage(senderId, { text: aiReply.message }, { quoted: message });
        }

    } catch (err) {
        console.error('Handle message error:', err.message);
    }
}

// ─────────────────────────────────────────
// WHATSAPP BOT START
// ─────────────────────────────────────────
async function startBot() {
    try {
        try {
            fs.rmSync('/tmp/auth_info', { recursive: true, force: true });
        } catch (e) {}

        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`📱 WA Version: ${version.join('.')} — Latest: ${isLatest}`);

        const { state, saveCreds } = await useMultiFileAuthState('/tmp/auth_info');

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
                console.log('✅ QR Ready! /qr pe jao!');
            }

            if (connection === 'close') {
                currentQR = null;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log('❌ Disconnected, code:', code);
                if (code === DisconnectReason.loggedOut) {
                    botStatus = 'logged_out';
                    try {
                        fs.rmSync('/tmp/auth_info', { recursive: true, force: true });
                    } catch (e) {}
                    setTimeout(startBot, 5000);
                } else {
                    botStatus = 'reconnecting';
                    setTimeout(startBot, code === 405 ? 15000 : 10000);
                }
            }

            if (connection === 'open') {
                currentQR = null;
                botStatus = 'connected';
                console.log('✅ WhatsApp Connected!');
                console.log('🏪 Mega Agency AI Sales Bot LIVE!');
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
        setTimeout(startBot, 15000);
    }
}

console.log('🚀 Mega Agency AI Sales Bot start ho raha hai...');
startBot();
