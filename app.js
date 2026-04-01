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

const chatBlock = []

function block(id){
    chatBlock.push(id)
}

function isBlock(id){
    return chatBlock.includes(id)
}

const ia = new Mistral({ apiKey: 'O2zJ5zADkoYVagGOR52tkxXrQFZ9SqQw'});

const supabase = createClient('https://qzdalzdgwnundyafardl.supabase.co', 'sb_publishable_o0UzZ3WiSqn-G9jN1IG_AA_Bk4nef6g');

const admin = [
    "22994847187@s.whatsapp.net"
    ];

const MAX_HISTORY = 200;

const AUTH_DIR = './auth';

const delay = ms => new Promise(res => setTimeout(res, ms));

const menu = `
- Attièkè+Sylvie : 2500 ou 4000 FCFA
- Attièkè+Aileron : 3500 FCFA
- Attièkè+Poulet complet : 6000 FCFA
- Attièkè+Demi poulet : 3500 FCFA
- Attièkè+Lapin entier : 8000 FCFA
- Attièkè+Demi lapin : 4500 FCFA
- Attièkè+Tilapia : 6000 ou 9000 FCFA
- Attièkè+Gésier : 2000 ou 2500 FCFA

Possibilité d'ajouter une portion d'attièkè (500 FCFA) ou d'alloco (500 FCFA)

`;

const getPromptPrincipal = () => {
    const tempsActuel = getBeninTime();
    return fs.readFileSync(path.join(__dirname , '../storage/shared/Bot/prompt.txt') , 'utf-8').replace(/\${menu}/ , menu).replace(/\${tempsActuel}/ , tempsActuel)
};

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
                try { bundle[file] = JSON.parse(fs.readFileSync(fullPath, 'utf-8')); } catch {}
            }
        }
        await supabase.from('whatsapp_auth').upsert({
            id: 'bot1',
            data: bundle,
            updated_at: new Date().toISOString()
        });
    } catch (e) { console.error("Erreur Sync Up:", e.message); }
}

async function insertRow(row) {
    await supabase.from('conversations').insert(row);
}

async function loadHistory(chatId) {
    const { data, error } = await supabase
        .from('conversations')
        .select('role, content')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: false })
        .limit(MAX_HISTORY);
    return error ? [] : (data || []).reverse();
}

async function generate(chatId, userText) {
    const history = await loadHistory(chatId);
    const messages = [
        { role: "system", content: getPromptPrincipal() },
        ...history,
        { role: "user", content: userText }
    ];

    let res;
    try {
        res = await ia.chat.complete({
            model: "mistral-large-latest",
            messages,
            responseFormat: { type: "json_object" },
            temperature : 0.0 , 
            top_p: 0.1 , 
            presence_penalty: 0.6
        });
    } catch {
        await delay(2000);
        res = await ia.chat.complete({
            model: "mistral-large-latest",
            messages,
            responseFormat: { type: "json_object" },
            temperature : 0.0 , 
            top_p: 0.1 , 
            presence_penalty: 0.6
        });
    }

    try {
        const content = res.choices[0].message.content;
        console.log("IA RAW:", content);
        const cleanJson = content.replace(/```json/g, "").replace(/```/g, "").trim();
        const parsed = JSON.parse(cleanJson);
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        throw new Error("JSON IA invalide");
    }
}


async function startBot() {
    await downloadAuthFromSupabase();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWaSocket({
        version,
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        connectTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await uploadAuthToSupabase();
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = await QRCode.toDataURL(qr);
        }

        if (connection === 'close') {
            
            if(sock){
                sock = null
        }
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnexion dans 3s...');
                setTimeout(startBot, 3000);
            }
        }

        if (connection === 'open') {
            qrCodeData = null;
            console.log('✅ Bot Dèkoungbé opérationnel');
        }
    });

sock.ev.on("messages.upsert", async ({ messages, type}) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if(!msg?.message) continue 
            
            const chatId = msg.key.remoteJid;
            
            // Ignorer les statuts
            if (chatId === 'status@broadcast') continue;
            
            // Ignorer les groupes (les IDs de groupe se terminent par @g.us)
            if (chatId.endsWith('@g.us')) continue;
            
            // Ignorer les chaînes (les IDs de chaîne se terminent par @newsletter)
            if (chatId.endsWith('@newsletter')) continue;
            
            // Ignorer les diffusions/broadcast lists
            if (chatId.endsWith('@broadcast')) continue;
            
            if(isBlock(chatId)) return 
            
            let text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            
            // Vérifier si c'est un message audio
            if (msg.message.audioMessage) {
                text = "Voice message";
            }
            
            if (!text) continue;
            
            if(text === '/stop_bot'){
                block(chatId)
                return
            }
            
            if (!msg?.message || msg.key.fromMe) continue
   
            const hasMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'].some(t => msg.message[t]);
            if (hasMedia && !msg.message.audioMessage) {
                await sock.sendMessage(chatId, { text: "⚠️ Désolé, je ne traite que le texte." });
                continue;
            }

            await delay(2000);
            await sock.readMessages([msg.key]);

            await sock.sendPresenceUpdate("composing", chatId);

            try {
                console.log(`📩 Message de ${msg.key.remoteJidAlt?.split('@')[0] || chatId}: ${text}`);
                await insertRow({ chat_id: chatId, role: "user", content: text });

                const answer = await generate(chatId, text);

                for (const item of answer) {
                    
                    if (item.type === "text") {
                        await delay(1000);
                        await sock.sendMessage(chatId, { text: item.text });
                        console.log("IA > ", item.text);
                        await insertRow({ chat_id: chatId, role: "assistant", content: item.text });
                    }
                    
                    if(item.type === "commande"){
                        
                       await insertRow({ chat_id: chatId, role: "assistant", content: '[COMMANDE]: ' + 'Heurr : ' + getBeninTime() + JSON.stringify(item) });
                        
                        const rapport = `👨‍🍳 NOUVELLE COMMANDE\n📞 Tel : ${item.phone}\n📍 Adresse : ${item.address}\n🍽️ ${item.menu}\nNuméro whatsapp : ${msg.key.remoteJidAlt?.split('@')[0] || chatId}\nHeure : ${getBeninTime()}`;

                        for (const num of admin) {
                            
                            await sock.sendPresenceUpdate("composing", num);
                            
                            await delay(2000);
                            
                            await sock.sendMessage(num, { text: rapport });
                            
                            await sock.sendPresenceUpdate("paused", num);
                            
                        } 
                    }
                      
                 }
                 
                await sock.sendPresenceUpdate("paused", chatId);

            } catch (e) {
                console.error("⚠️ Erreur :", e.message);
                await sock.sendMessage(chatId, { text: "Désolé, pouvez-vous reformuler votre demande ?" });
            }
        }
    });
    setInterval(async () => {
        if (sock?.user) {
            try { await sock.sendPresenceUpdate('available'); } catch { }
        }
    }, 45000);
}

startBot();