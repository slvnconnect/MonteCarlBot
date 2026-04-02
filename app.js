const {
    default: makeWaSocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const { Mistral } = require('@mistralai/mistralai');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const moment = require('moment-timezone');

// ================= CONFIG =================
const AUTH_DIR = './auth';
const PORT = process.env.PORT || 10000;

const LOCK_ID = "bot1";
const INSTANCE_ID = process.env.RENDER_SERVICE_ID || Math.random().toString(36);

let sock = null;
let qrCodeData = null;
let isStarting = false;
let cachedConfig = null;
let lastFetch = 0;
let blockedUsersCache = new Set();

const CACHE_DURATION = 2 * 60 * 1000;
const MAX_HISTORY = 200;

// ================= INIT =================
const app = express();
app.get('/', (req, res) => res.send('Bot Dèkoungbé en ligne ✅'));

app.get('/qr', (req, res) => {
    if (!qrCodeData) return res.send('QR non disponible');
    const base64 = qrCodeData.replace(/^data:image\/png;base64,/, '');
    const img = Buffer.from(base64, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(img);
});

app.listen(PORT, () => console.log(`Serveur écoute sur ${PORT}`));

// ================= SUPABASE =================
const supabase = createClient(
    'https://qzdalzdgwnundyafardl.supabase.co',
    'sb_publishable_o0UzZ3WiSqn-G9jN1IG_AA_Bk4nef6g'
);

// ================= IA =================
const ia = new Mistral({
    apiKey: 'O2zJ5zADkoYVagGOR52tkxXrQFZ9SqQw'
});

// ================= UTILS =================
const delay = ms => new Promise(r => setTimeout(r, ms));

function getBeninTime() {
    return moment().tz("Africa/Porto-Novo").format("dddd DD MMMM YYYY, HH:mm");
}

// ================= LOCK SYSTEM =================
async function tryAcquireLock() {
    try {
        const { data } = await supabase
            .from('bot_lock')
            .select('*')
            .eq('id', LOCK_ID)
            .maybeSingle();

        if (!data || !data.updated_at ||
            (Date.now() - new Date(data.updated_at).getTime() > 30000)) {

            await supabase.from('bot_lock').upsert({
                id: LOCK_ID,
                instance: INSTANCE_ID,
                updated_at: new Date().toISOString()
            });

            return true;
        }

        return data.instance === INSTANCE_ID;

    } catch (e) {
        console.error("Lock error:", e.message);
        return false;
    }
}

function keepLockAlive() {
    setInterval(async () => {
        try {
            await supabase
                .from('bot_lock')
                .update({ updated_at: new Date().toISOString() })
                .eq('id', LOCK_ID)
                .eq('instance', INSTANCE_ID);
        } catch {}
    }, 15000);
}

// ================= CONFIG =================
async function getBotConfig() {
    try {
        const { data, error } = await supabase
            .from('bot_config')
            .select('prompt, menu')
            .eq('key', 'bot1')
            .single();

        if (error) throw error;
        return data || {};
    } catch (e) {
        console.error("Erreur getBotConfig:", e.message);
        return {};
    }
}

async function getCachedConfig() {
    const now = Date.now();
    if (cachedConfig && (now - lastFetch < CACHE_DURATION)) return cachedConfig;

    cachedConfig = await getBotConfig();
    lastFetch = now;

    return cachedConfig;
}

async function getPrompt() {
    const config = await getCachedConfig();
    return (config?.prompt || "")
        .replaceAll('${menu}', config?.menu || "")
        .replaceAll('${tempsActuel}', getBeninTime());
}

// ================= BLOCK =================
async function loadBlockedUsers() {
    try {
        const { data } = await supabase
            .from('blocked_users')
            .select('user_id')
            .eq('blocked', true);

        blockedUsersCache.clear();
        data?.forEach(r => blockedUsersCache.add(r.user_id));

    } catch (e) {
        console.error("Erreur blocage:", e.message);
    }
}

function isBlocked(userId) {
    return blockedUsersCache.has(userId);
}

// ================= BOT =================
async function startBot() {
    if (isStarting) return;
    isStarting = true;

    const ok = await tryAcquireLock();
    if (!ok) {
        console.log("⛔ Instance déjà active");
        process.exit(0);
    }

    keepLockAlive();

    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    await loadBlockedUsers();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWaSocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) qrCodeData = await QRCode.toDataURL(qr);

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;

            if (code !== DisconnectReason.loggedOut) {
                setTimeout(startBot, 5000);
            }
        }

        if (connection === 'open') {
            qrCodeData = null;
            console.log("✅ Bot connecté");
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            processIncomingMessage(msg).catch(e => console.error(e));
        }
    });
}

// LOGIQUE DE TRAITEMENT DES MESSAGES
async function processIncomingMessage(msg) {
    if (!msg?.message) return;
    const chatId = msg.key.remoteJid;
    if (chatId === 'status@broadcast' || chatId.endsWith('@newsletter') || isBlocked(chatId)) return;

    let text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (msg.message.audioMessage) text = "Voice message";
    if (!text || msg.key.fromMe) return;

    // Commandes Admin
    if (text.startsWith('/stop_bot')) {
            await blockUser(chatId);
        return;
    }
    if (text.startsWith('/unlock_bot')) {
            await unblockUser(chatId);
        return;
    }

    const hasMedia = ['imageMessage', 'videoMessage', 'stickerMessage', 'documentMessage'].some(t => msg.message[t]);
    if (hasMedia) {
        await sock.sendMessage(chatId, { text: "⚠️ Désolé, je ne traite que le texte." });
        return;
    }

    await sock.readMessages([msg.key]);
    await sock.sendPresenceUpdate("composing", chatId);

    try {
        console.log(`📩 Message de ${chatId}: ${text}`);
        await insertRow({ chat_id: chatId, role: "user", content: text });

        const answer = await generate(chatId, text);

        console.log(answer)
        
        for (const item of answer) {
            if (item.type === "text") {
                await delay(1000);
                await sock.sendMessage(chatId, { text: item.text });
                await insertRow({ chat_id: chatId, role: "assistant", content: item.text });
            }
            if (item.type === "commande") {
                await insertRow({ chat_id: chatId, role: "assistant", content: '[COMMANDE]: ' + JSON.stringify(item) + 'Heure de lancement : ' + getBeninTime() });
                const rapport = `\n👨‍🍳 NOUVELLE COMMANDE\n📞 Tel : ${item.phone}\n📍 Adresse : ${item.address}\n🍽️ ${item.menu}\n🕒 Livraison : ${item.delivery_hour || 'maintenant'}\nHeure : ${getBeninTime()}\nNuméro WhatsApp : ${msg.key.remoteJidAlt.split('@')[0] || chatId}\n`;
                for (const num of admin) { await sock.sendMessage(num, { text: rapport }); }
            }
        }
    } catch (e) {
        console.error("⚠️ Erreur:", e.message);
        await sock.sendMessage(chatId, { text: "Désolé, pouvez-vous reformuler votre demande ?" });
    } finally {
        await sock.sendPresenceUpdate("paused", chatId);
    }
}

//================= CRASH PROTECTION =================
process.on('uncaughtException', err => {
    console.error("💥 Crash:", err);
    process.exit(1);
});

process.on('unhandledRejection', err => {
    console.error("💥 Rejection:", err);
    process.exit(1);
});

// ================= START =================
startBot();