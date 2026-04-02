const { default: makeWaSocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Mistral } = require('@mistralai/mistralai');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const moment = require('moment-timezone');

const app = express();
const PORT = process.env.PORT || 10000;

let qrCodeData = null;
let sock = null;

// Cache des utilisateurs bloqués
let blockedUsersCache = new Set();

// --- CONFIGURATION CHEMINS ---
const AUTH_DIR = './auth';

app.get('/', (req, res) => res.send('Bot Dèkoungbé en ligne ✅'));

app.get('/qr', (req, res) => {
    if (!qrCodeData) return res.send('QR code non disponible (déjà connecté ou en cours)');
    const base64Data = qrCodeData.replace(/^data:image\/png;base64,/, '');
    const img = Buffer.from(base64Data, 'base64');
    res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': img.length
    });
    res.end(img);
});

app.listen(PORT, () => console.log(`Serveur écoute sur le port ${PORT}`));

function getBeninTime() {
    return moment().tz("Africa/Porto-Novo").format("dddd DD MMMM YYYY, HH:mm");
}

const ia = new Mistral({ apiKey: 'O2zJ5zADkoYVagGOR52tkxXrQFZ9SqQw' });

const supabase = createClient('https://qzdalzdgwnundyafardl.supabase.co', 'sb_publishable_o0UzZ3WiSqn-G9jN1IG_AA_Bk4nef6g');

const admin = ["22994847187@s.whatsapp.net"];

const MAX_HISTORY = 200;

const delay = ms => new Promise(res => setTimeout(res, ms));

let cachedConfig = null;
let lastFetch = 0;

const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes

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

const getCachedConfig = async () => {
    const now = Date.now();

    if (cachedConfig && (now - lastFetch < CACHE_DURATION)) {
        return cachedConfig;
    }

    cachedConfig = await getBotConfig();
    lastFetch = now;

    return cachedConfig;
};

const getPrompt = async () => {
    const tempsActuel = getBeninTime();
    const config = await getCachedConfig();

    const systemPrompt = config?.prompt || "";
    const menu = config?.menu || "";

    return systemPrompt
        .replaceAll('${menu}', menu)
        .replaceAll('${tempsActuel}', tempsActuel);
};


// ==================== GESTION DES BLOCAGES ====================
async function loadBlockedUsers() {
    try {
        const { data, error } = await supabase.from('blocked_users').select('user_id').eq('blocked', true);
        if (error) throw error;
        blockedUsersCache.clear();
        if (data) {
            data.forEach(row => blockedUsersCache.add(row.user_id));
        }
        console.log(`📋 ${blockedUsersCache.size} utilisateurs bloqués chargés`);
    } catch (e) { console.error("Erreur chargement blocages:", e.message); }
}

async function blockUser(userId) {
    try {
        const { data: existing } = await supabase.from('blocked_users').select('user_id').eq('user_id', userId).maybeSingle();
        if (existing) {
            await supabase.from('blocked_users').update({ blocked: true, blocked_at: new Date().toISOString() }).eq('user_id', userId);
        } else {
            await supabase.from('blocked_users').insert({ user_id: userId, blocked: true, blocked_at: new Date().toISOString() });
        }
        blockedUsersCache.add(userId);
        return true;
    } catch (e) { return false; }
}

async function unblockUser(userId) {
    try {
        await supabase.from('blocked_users').update({ blocked: false, unblocked_at: new Date().toISOString() }).eq('user_id', userId);
        blockedUsersCache.delete(userId);
        return true;
    } catch (e) { return false; }
}

function isBlocked(userId) { return blockedUsersCache.has(userId); }

// ==================== SYNCHRO SUPABASE ====================
async function downloadAuthFromSupabase() {
    try {
        const { data, error } = await supabase.from('whatsapp_auth').select('data').eq('id', 'bot1').single();
        if (error || !data?.data) return;
        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
        for (const [fileName, content] of Object.entries(data.data)) {
            fs.writeFileSync(path.join(AUTH_DIR, fileName), JSON.stringify(content));
        }
        console.log("📥 Authentification synchronisée.");
    } catch (e) { console.error("Erreur Sync Down:", e.message); }
}

async function uploadAuthToSupabase() {
    if (!fs.existsSync(AUTH_DIR)) return;
    try {
        const files = fs.readdirSync(AUTH_DIR);
        const bundle = {};
        for (const file of files) {
            const fullPath = path.join(AUTH_DIR, file);
            if (fs.lstatSync(fullPath).isFile()) {
                try { bundle[file] = JSON.parse(fs.readFileSync(fullPath, 'utf-8')); } catch { }
            }
        }
        await supabase.from('whatsapp_auth').upsert({ id: 'bot1', data: bundle, updated_at: new Date().toISOString() });
    } catch (e) { console.error("Erreur Sync Up:", e.message); }
}

async function insertRow(row) { await supabase.from('conversations').insert(row); }

async function loadHistory(chatId) {
    const { data, error } = await supabase.from('conversations').select('role, content').eq('chat_id', chatId).order('created_at', { ascending: false }).limit(MAX_HISTORY);
    return error ? [] : (data || []).reverse();
}

// ==================== GENERATION IA ====================
async function generate(chatId, userText) {
    const history = await loadHistory(chatId);
    const messages = [{ role: "system", content: await getPrompt() }, ...history, { role: "user", content: userText }];

    let res;
    try {
        res = await ia.chat.complete({ model: "mistral-large-latest", messages, responseFormat: { type: "json_object" }, temperature: 0.0, top_p: 0.9, presence_penalty: 0.6 });
    } catch {
        await delay(2000);
        res = await ia.chat.complete({ model: "mistral-large-latest", messages, responseFormat: { type: "json_object" }, temperature: 0.0, top_p: 0.9, presence_penalty: 0.6 });
    }

    try {
        const content = res.choices[0].message.content;
        const cleanJson = content.replace(/```json/g, "").replace(/```/g, "").replaceAll('*' , '').trim();
        console.log(cleanJson)
        const parsed = JSON.parse(cleanJson);
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch { throw new Error("JSON IA invalide"); }
}

// ==================== CORE BOT ====================
async function startBot() {
    // Création du dossier auth s'il n'existe pas
    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    // Anti-conflit Render
    const lockPath = path.join(AUTH_DIR, 'bot.lock');
    if (fs.existsSync(lockPath)) {
        const lockTime = fs.readFileSync(lockPath, 'utf8');
        if (Date.now() - parseInt(lockTime) < 60000) {
            console.log("⚠️ Conflit détecté. Arrêt pour laisser l'instance active.");
            process.exit(0);
        }
    }
    fs.writeFileSync(lockPath, Date.now().toString());

    await loadBlockedUsers();
    await downloadAuthFromSupabase();
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWaSocket({
        version,
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        connectTimeoutMs: 60000
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await uploadAuthToSupabase();
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrCodeData = await QRCode.toDataURL(qr);

        if (connection === 'close') {
            const isConflict = lastDisconnect?.error?.raw?.tag === 'conflict';
            if (isConflict) { process.exit(0); }
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(startBot, 5000);
            }
        }
        if (connection === 'open') {
            qrCodeData = null;
            console.log('✅ Bot Dèkoungbé opérationnel');
            // Update lock toutes les 30 secondes
            setInterval(() => { if(fs.existsSync(lockPath)) fs.writeFileSync(lockPath, Date.now().toString()); }, 30000);
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

setInterval(async () => {
    if (sock?.user) { try { await sock.sendPresenceUpdate('available'); } catch { } }
}, 45000);

startBot();