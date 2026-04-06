const {
    default : makeWASocket ,
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const { Mistral } = require('@mistralai/mistralai');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs'); 
const path = require('path');
const express = require('express');
const QRCode = require('qrcode')
const moment = require('moment-timezone');
const { Boom } = require('@hapi/boom');



// ==================== CONFIGURATION & SETTINGS ====================
const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_DIR = './auth';

let qrCodeData = null;
let sock = null;
let blockedUsersCache = new Set();
let cachedConfig = null;
let lastFetch = 0;
let isConnecting = false; // Anti-double lancement

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

// ==================== PROTECTIONS ANTI-CRASH GLOBALES ====================
process.on('uncaughtException', (err) => {
    console.error('💥 Erreur critique interceptée:', err);
    // On ne relance pas startBot() ici pour éviter les boucles infinies de crash
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 Promesse rejetée non gérée:', reason);
});

// ==================== SERVICES EXTERNES ====================
const ia = new Mistral({ apiKey: 'O2zJ5zADkoYVagGOR52tkxXrQFZ9SqQw' });
const supabase = createClient('https://qzdalzdgwnundyafardl.supabase.co', 'sb_publishable_o0UzZ3WiSqn-G9jN1IG_AA_Bk4nef6g');
const admin = ["22994847187@s.whatsapp.net"];

// ==================== UTILS ====================
const delay = ms => new Promise(res => setTimeout(res, ms));
function getBeninTime() { return moment().tz("Africa/Porto-Novo").format("dddd DD MMMM YYYY, HH:mm"); }

async function insertRow(row) { 
    try { await supabase.from('conversations').insert(row); } catch (e) { console.error("Erreur DB:", e.message); }
}

// ==================== GESTION DES BLOCAGES ====================
async function loadBlockedUsers() {
    try {
        const { data, error } = await supabase.from('blocked_users').select('user_id').eq('blocked', true);
        if (error) throw error;
        blockedUsersCache.clear();
        if (data) data.forEach(row => blockedUsersCache.add(row.user_id));
        console.log(`📋 ${blockedUsersCache.size} utilisateurs bloqués chargés`);
    } catch (e) { console.error("Erreur blocages:", e.message); }
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
        console.log("📤 Session synchronisée sur Supabase");
    } catch (e) { console.error("Erreur Sync Up:", e.message); }
}

// ==================== CORE BOT (LE BLINDAGE) ====================
async function startBot() {
    if (isConnecting) return;
    isConnecting = true;

    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    // --- Gestion intelligente du Lock (Anti-Zombie) ---
    const lockPath = path.join(AUTH_DIR, 'bot.lock');
    if (fs.existsSync(lockPath)) {
        const lockTime = fs.readFileSync(lockPath, 'utf8');
        // Si le lock a moins de 2 minutes, c'est peut-être une vraie instance active
        if (Date.now() - parseInt(lockTime) < 120000) {
            console.log("⚠️ Instance déjà active. Attente de sécurité...");
            isConnecting = false;
            return setTimeout(startBot, 30000);
        } else {
            console.log("🧹 Nettoyage d'un lock périmé.");
            fs.unlinkSync(lockPath);
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
        keepAliveIntervalMs: 30000,
        maxRetries: 5
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        // On n'upload pas à chaque seconde, on laisse le cycle de connexion faire
    });

     sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = await QRCode.toDataURL(qr);
        }

        if (connection === 'close') {
            isConnecting = false;
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`🔌 Connexion fermée (Code: ${statusCode})`);

            // CRUCIAL : On libère le lock pour permettre la reconnexion immédiate
            if (fs.existsSync(lockPath)) {
                try { fs.unlinkSync(lockPath); console.log("🔓 Lock libéré pour reconnexion."); } catch(e) {}
            }

            if (statusCode !== DisconnectReason.loggedOut) {
                // Si c'est une erreur 428 ou timeout, on attend un peu plus
                const retryDelay = (statusCode === 428 || statusCode === 408) ? 10000 : 5000;
                console.log(`🔄 Re-tentative dans ${retryDelay/1000}s...`);
                setTimeout(startBot, retryDelay);
            } else {
                console.log("❌ Déconnecté. Supprimez le dossier auth.");
            }
        }
        
        if (connection === 'open') {
            qrCodeData = null;
            isConnecting = false;
            console.log('✅ BOT DÈKOUNGBÉ CONNECTÉ ET PRÊT');
            await uploadAuth();

            // On met à jour le lock périodiquement pour prouver qu'on est vivant
            const lockInterval = setInterval(() => {
                if (connection === 'open' && fs.existsSync(lockPath)) {
                    fs.writeFileSync(lockPath, Date.now().toString());
                } else {
                    clearInterval(lockInterval);
                }
            }, 30000);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            processIncomingMessage(msg).catch(e => console.error("Erreur message:", e));
        }
    });
}

// ==================== LOGIQUE IA & TRAITEMENT (TEL QUEL) ====================
async function processIncomingMessage(msg) {
    if (!msg?.message) return;
    const chatId = msg.key.remoteJid;
    if(chatId.includes('@g.us')) return
    if (chatId.includes('@broadcast')) return;
    if (chatId.includes('@newsletter')) return;
    
    let text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (msg.message.audioMessage) text = "Voice message";
    
    if (!text) return;

    // ========== COMMANDES ADMIN ==========
    if (text.includes('/stop_bot')) {
        await blockUser(chatId);
        return;
    }
    if (text.includes('/unlock_bot')) {
        await unblockUser(chatId);
        return;
    }

    if (isBlocked(chatId) || msg.key.fromMe) return;

    // ========== TRAITEMENT ==========
    await sock.readMessages([msg.key]);
    await sock.sendPresenceUpdate("composing", chatId);
    
    console.log(`Message reçu de ${chatId} : ${text || "Indisponible"}`)

    try {
        const history = await loadHistory(chatId);
        const prompt = await getPrompt();
        
        const aiOptions = {
            messages: [{ role: "system", content: prompt }, ...history, { role: "user", content: text }],
            responseFormat: { type: "json_object" },
            temperature: 0.0,
            presence_penalty : 0.6
        };

        let res;
        try {
            res = await ia.chat.complete({ model: "mistral-medium-2508", ...aiOptions });
        } catch (err) {
            console.error("Repli sur mistral-medium 2505...", err.message);
            res = await ia.chat.complete({ model: "mistral-medium-2505", ...aiOptions });
        }
        
        const content = res.choices[0].message.content;
        const cleanJson = content.replace(/```json/g, "").replace(/```/g, "").replaceAll('*' , '').trim();
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
                
                rapport += `🕒 Livraison voulue : ${item.delivery_hour || 'Pas d´heure précisé' }\nHeure de lancement: ${getBeninTime()}\nNuméro WhatsApp : ${msg.key.remoteJidAlt.split('@')[0]}`;
                
                for (const num of admin) { await sock.sendMessage(num, { text: rapport }); }
            }
            else if (item.type === "plainte") {
                await insertRow({ chat_id: chatId, role: "assistant", content: `[PLAINTE]: ${JSON.stringify(item)} | ${getBeninTime()}` });
    
                const rapport = `\n⚠️ *NOUVELLE PLAINTE* ⚠️\n📝 Cause : ${item.cause}\n👤 Numéro WhatsApp : ${msg.key.remoteJidAlt.split('@')[0] || chatId}\n⏰ Heure : ${getBeninTime()}`;
    
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

startBot();
