const { default: makeWaSocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Mistral } = require('@mistralai/mistralai');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const moment = require('moment-timezone');

// ==================== CONFIGURATION & SETTINGS ====================
const app = express();
const PORT = process.env.PORT || 10000;
const AUTH_DIR = './auth';

let qrCodeData = null;
let sock = null;
let blockedUsersCache = new Set();
let cachedConfig = null;
let lastFetch = 0;

const CACHE_DURATION = 2 * 60 * 1000;
const MAX_HISTORY = 200; 

// ==================== INITIALISATION SERVEUR ====================
app.get('/', (req, res) => res.send('Bot Dèkoungbé Immortel ✅ en ligne'));

app.get('/qr', (req, res) => {
    if (!qrCodeData) return res.send('QR code non disponible (déjà connecté ou en cours)');
    const base64Data = qrCodeData.replace(/^data:image\/png;base64,/, '');
    const img = Buffer.from(base64Data, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length });
    res.end(img);
});

app.listen(PORT, () => console.log(`🚀 Serveur actif sur le port ${PORT}`));

// ==================== PROTECTIONS ANTI-CRASH ====================
process.on('uncaughtException', (err) => console.error('💥 Erreur critique interceptée:', err));
process.on('unhandledRejection', (reason) => console.error('💥 Promesse rejetée non gérée:', reason));

// ==================== SERVICES EXTERNES ====================
const ia = new Mistral({ apiKey: 'O2zJ5zADkoYVagGOR52tkxXrQFZ9SqQw' });
const supabase = createClient('https://qzdalzdgwnundyafardl.supabase.co', 'sb_publishable_o0UzZ3WiSqn-G9jN1IG_AA_Bk4nef6g');
const admin = ["22994847187@s.whatsapp.net"];

// ==================== UTILS ====================
const delay = ms => new Promise(res => setTimeout(res, ms));

function getBeninTime() { return moment().tz("Africa/Porto-Novo").format("dddd DD MMMM YYYY, HH:mm"); }

async function insertRow(row) { 
    await supabase.from('conversations').insert(row); 
}

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

// ==================== GESTION CONFIG ====================
async function getBotConfig() {
    const now = Date.now();
    if (cachedConfig && (now - lastFetch < CACHE_DURATION)) return cachedConfig;
    try {
        const { data, error } = await supabase.from('bot_config').select('prompt, menu').eq('key', 'bot1').single();
        if (error) throw error;
        cachedConfig = data || {};
        lastFetch = now;
        return cachedConfig;
    } catch (e) { return cachedConfig || {}; }
}

const getPrompt = async () => {
    const config = await getBotConfig();
    return (config?.prompt || "")
        .replaceAll('${menu}', config?.menu || "")
        .replaceAll('${tempsActuel}', getBeninTime());
};

// ==================== SYNCHRO AUTH SUPABASE ====================
async function downloadAuth() {
    try {
        const { data } = await supabase.from('whatsapp_auth').select('data').eq('id', 'bot1').single();
        if (!data?.data) return;
        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
        for (const [file, content] of Object.entries(data.data)) {
            fs.writeFileSync(path.join(AUTH_DIR, file), JSON.stringify(content));
        }
        console.log("📥 Session récupérée de Supabase");
    } catch (e) { console.error("Erreur Sync Down:", e.message); }
}

async function uploadAuth() {
    if (!fs.existsSync(AUTH_DIR)) return;
    try {
        const bundle = {};
        const files = fs.readdirSync(AUTH_DIR);
        for (const file of files) {
            const p = path.join(AUTH_DIR, file);
            if (fs.lstatSync(p).isFile()) {
                try { bundle[file] = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch {}
            }
        }
        await supabase.from('whatsapp_auth').upsert({ id: 'bot1', data: bundle, updated_at: new Date().toISOString() });
    } catch (e) { console.error("Erreur Sync Up:", e.message); }
}

// ==================== CORE BOT ====================
async function startBot() {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    const lockPath = path.join(AUTH_DIR, 'bot.lock');
    if (fs.existsSync(lockPath)) {
        const lockTime = fs.readFileSync(lockPath, 'utf8');
        if (Date.now() - parseInt(lockTime) < 30000) {
            console.log("⚠️ Instance déjà active. Attente...");
            return setTimeout(startBot, 40000);
        }
    }
    fs.writeFileSync(lockPath, Date.now().toString());

    await loadBlockedUsers();
    await downloadAuth();
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWaSocket({
        version,
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await uploadAuth();
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrCodeData = await QRCode.toDataURL(qr);

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(startBot, 5000);
            }
        }
        
        if (connection === 'open') {
            qrCodeData = null;
            console.log('✅ Bot Dèkoungbé connecté');
            setInterval(() => {
                if(fs.existsSync(lockPath)) fs.writeFileSync(lockPath, Date.now().toString());
            }, 30000);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        for (const msg of messages) {
            processIncomingMessage(msg).catch(e => console.error(e));
        }
    });
}

// ==================== LOGIQUE IA & TRAITEMENT ====================
async function processIncomingMessage(msg) {
    if (!msg?.message || msg.key.fromMe) return;
    const chatId = msg.key.remoteJid;
    if (chatId.includes('@broadcast'))return;
    if(chatId.includes('@newsletter')) return
    
    let text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (msg.message.audioMessage) text = "Voice message";
    
    if (!text) return;

    // ========== COMMANDES ADMIN (toujours exécutées même si bloqué) ==========
    if (text === '/stop_bot') {
        await blockUser(chatId);
        return;
    }
    if (text === '/unlock_bot') {
        await unblockUser(chatId);
        return;
    }

    // ========== VÉRIFICATION BLOCAGE (après les commandes admin) ==========
    if (isBlocked(chatId)) {
        console.log(`🚫 Message ignoré de ${chatId} (bloqué)`);
        return;
    }

    // ========== SUITE DU TRAITEMENT NORMAL ==========
    await sock.readMessages([msg.key]);
    await sock.sendPresenceUpdate("composing", chatId);
    
    console.log(`Message reçu de ${chatId} : ${text || "Indisponible"}`)

    try {
        const history = await loadHistory(chatId);
        const prompt = await getPrompt();
        
        // Paramètres IA Naturels
        const aiOptions = {
            messages: [{ role: "system", content: prompt }, ...history, { role: "user", content: text }],
            responseFormat: { type: "json_object" },
            temperature: 0.0,
            top_p : 0.1 ,
            presence_penalty : 0.4
        };

        let res;
        try {
            res = await ia.chat.complete({ model: "mistral-small-2603", ...aiOptions });
        } catch (err) {
            console.error("Repli sur mistral-small...", err.message);
            res = await ia.chat.complete({ model: "mistral-large-2411", ...aiOptions });
        }
        
        const content = res.choices[0].message.content;
        const cleanJson = content.replace(/```json/g, "").replace(/```/g, "").trim();
        console.log(cleanJson)
        const answer = JSON.parse(cleanJson);
        const finalArray = Array.isArray(answer) ? answer : [answer];

        await insertRow({ chat_id: chatId, role: "user", content: text });

        for (const item of finalArray) {
            if (item.type === "text") {
                await delay(1000);
                await sock.sendMessage(chatId, { text: item.text });
                await insertRow({ chat_id: chatId, role: "assistant", content: item.text });
            } 
            else if (item.type === "commande" || item.type === "modif") {
                const isModif = item.type === "modif";
                const label = isModif ? "MODIFICATION" : "COMMANDE";
                
                await insertRow({ chat_id: chatId, role: "assistant", content: `[${label}]: ${JSON.stringify(item)} | ${getBeninTime()}` });
                
                let rapport = `\n👨‍🍳 *${isModif ? "MODIFICATION DE COMMANDE" : "NOUVELLE COMMANDE"}*\n📞 Tel : ${item.phone}\n📍 Adresse : ${item.address}\n`;
                
                if (isModif) {
                    rapport += `❌ Ancien : ${item.old_menu}\n✅ Nouveau : ${item.new_menu}\n`;
                } else {
                    rapport += `🍽️ ${item.menu}\n`;
                }
                
                rapport += `🕒 Livraison voulue : ${item.delivery_hour}\nHeure de lancement: ${getBeninTime()}\nNuméro WhatsApp : ${msg.key.remoteJidAlt.split('@')[0]}`;
                
                for (const num of admin) { await sock.sendMessage(num, { text: rapport }); }
            }
        }
    } catch (e) {
        console.error("⚠️ Erreur:", e.message);
        await sock.sendMessage(chatId, { text: "Désolé, reformulez votre demande svp. 😊" });
    } finally {
        await sock.sendPresenceUpdate("paused", chatId);
    }
}

async function loadHistory(chatId) {
    const { data } = await supabase.from('conversations')
        .select('role, content')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: false })
        .limit(MAX_HISTORY);
    return (data || []).reverse();
}

setInterval(async () => {
    if (sock?.user) { try { await sock.sendPresenceUpdate('available'); } catch { } }
}, 45000);

startBot();

