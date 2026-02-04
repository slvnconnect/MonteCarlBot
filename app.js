const { default: makeWaSocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Mistral } = require('@mistralai/mistralai');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Bot en ligne ✅');
});

app.listen(PORT, () => {
  console.log(`Serveur écoute sur le port ${PORT}`);
});

setInterval(async () => {
  try {
    const res = await fetch(`http://localhost:${PORT}`);
    if (res.ok) {
      console.log('Ping interne OK');
    } else {
      console.log('Ping interne échoué, status:', res.status);
    }
  } catch (err) {
    console.log('Ping interne échoué', err.message);
  }
}, 5 * 60 * 1000); // toutes les 5 minutes

// =====================
// CONFIG
// =====================
const ia = new Mistral({ apiKey: process.env.mistraKey });

const supabaseUrl = process.env.supaUrl
const supabaseKey = process.env.supaKey
const supabase = createClient(supabaseUrl, supabaseKey);

const CUISINE_JID = "22952865983@s.whatsapp.net";
const MAX_HISTORY = 20;
const AUTH_DIR = './auth_info_baileys'; // Dossier local requis par Baileys

// =====================
// UTILS
// =====================
function cleanJson(text) {
    return text.replace(/```json/g, "").replace(/```/g, "").trim();
}

function safeJsonParse(text) {
    try {
        const parsed = JSON.parse(cleanJson(text));
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        return null;
    }
}

// =====================
// DB HELPERS
// =====================
async function insertRow(row) {
    const { error } = await supabase.from('conversations').insert(row);
    if (error) throw new Error("Supabase insert: " + error.message);
}

async function loadHistory(chatId) {
    const { data, error } = await supabase
        .from('conversations')
        .select('role, content')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: false })
        .limit(MAX_HISTORY);

    if (error) {
        console.error("❌ loadHistory:", error.message);
        return [];
    }
    return (data || []).reverse();
}

// =====================
// NOUVELLE LOGIQUE AUTH (EMPAQUETAGE SINGLE-LINE)
// =====================
async function downloadAuthFromSupabase() {
    const { data, error } = await supabase.from('whatsapp_auth').select('data').eq('id', 'bot1').single();
    if (error || !data?.data) return;

    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    for (const [fileName, content] of Object.entries(data.data)) {
        fs.writeFileSync(path.join(AUTH_DIR, fileName), JSON.stringify(content));
    }
    console.log("📥 Authentification synchronisée depuis Supabase.");
}

async function uploadAuthToSupabase() {
    if (!fs.existsSync(AUTH_DIR)) return;

    const files = fs.readdirSync(AUTH_DIR);
    const bundle = {};

    for (const file of files) {
        const fullPath = path.join(AUTH_DIR, file);
        if (fs.lstatSync(fullPath).isFile()) {
            try {
                bundle[file] = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
            } catch (e) { /* Ignore fichiers corrompus */ }
        }
    }

    await supabase.from('whatsapp_auth').upsert({ 
        id: 'bot1', 
        data: bundle, 
        updated_at: new Date().toISOString() 
    });
}

// =====================
// IA
// =====================
async function generate(chatId, userText, prompt) {
    const history = await loadHistory(chatId);

    const messages = [
        { role: "system", content: prompt },
        ...history,
        { role: "user", content: "Réponds STRICTEMENT en JSON tableau. " + userText }
    ];
    
    let res;

    try {
        res = await ia.chat.complete({
            model: "mistral-small-latest",
            messages,
            reponseFormat : { type : "json_object" }
        });
    } catch (e) {
        await new Promise(res => setTimeout(res , 1200));
        res = await ia.chat.complete({
            model: "mistral-small-latest",
            messages,
            reponseFormat : { type : "json_object" }
        });
    }
    
    const raw = res.choices[0].message.content;
    console.log("🤖 IA →", raw);

    const parsed = safeJsonParse(raw);
    if (!parsed) throw new Error("JSON IA invalide");

    return parsed;
}

// =====================
// BOT
// =====================
async function startBot() {

    const menu = `
Poulet Maillo entier 6500
Poulet Maillo moitié 4000
Choukouya entier 6500
Choukouya moitié 4000
Tilapia braisés moitié 3000 (2 Tilapia)
Tilapia braisés entier 6000 (4 Tilapia)
Lapin braisé entier 7000
Lapin braisé moitié 4000
Sauce arachide / graine + igname ou pâte noire 4000
Chawarma 2000
Attièkè poulet ou lapin aloco 5000
Jus de bissap , ananas et menthe au lait 500
Jus de baobab 700
Poulet frais 2700/kg
Lapin frais 3500/kg
Gésier 2500/kg
Plateau d'œufs 2400
Tilapia frais 2700/kg
Lait caillé 600
Reste pour chiens 700
`;

    const prompt = `
Tu es l'assistant du restaurant MONTECARL AGROALIMENTAIRE.
Tu aides le client a : 
.Voir le menu
.Passer commande 
.Connaître horaires et localisation du restaurant 

Règles STRICTES :
- Réponse uniquement en JSON tableau
- Aucun texte hors JSON
- Poli et concis
- Jamais de réduction ni offre gratuite
- Ne jamais inventer
- Utiliser \\n pour les retours ligne
- Ne jamais renvoyer le menu en JSON (toujours texte)
-Répond clairement aux questions qui te sont posées et agis comme un humain pas comme un robot
-Soit sympa et harmonieux 
-Soit un client sort du contexte professionnel dis lui poliment que tu travailles seulement dans un cadre professionnel 
-Aux salutations tu réponds chaleureusement ouvertement.
-Ne sort jamais du contexte de la discussion en cours 

Format texte :
[{ "type": "text", "text": "..." }]
Tu n'envoie jamais de tex
Commande :
[
 {
  "type":"commande",
  "name":"Nom",
  "phone":"Numéro",
  "address":"Adresse",
  "menu":"Commande reformulée"
 },
 {
  "type":"text",
  "text":"message de confirmation"
 }
]

- Toutes les infos doivent être collectées avant une commande
-Tu dois demander confirmation a l'utilisateur de la commande avant de la lancer 
- Si tu as déjà envoyé une commande tu n'envoie plus d'autres 

Menu : ${menu}
Adresse du restaurant : Calavi
Téléphone du restaurant (en cas de pleinte ou d'infos qui te dépasse): 0166577174
Horaires d'ouverture du restaurant : 8h–23h
Zone de livraison accepté : Cotonou & Calavi
`;

    // 1. Charger l'auth depuis Supabase dans le dossier local
    await downloadAuthFromSupabase();

    // 2. Initialiser l'état MultiFile
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWaSocket({ 
        auth: state,
        printQRInTerminal: false 
    });

    // 3. Sauvegarder dans Supabase (Single-Line) à chaque mise à jour
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await uploadAuthToSupabase();
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('📲 Scanner ce QR code :');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnexion...');
                setTimeout(startBot, 2000);
            }
        }

        if (connection === 'open') console.log('✅ Bot connecté avec succès');
    });
    
    setInterval(() => {
    try { sock.sendPresenceUpdate('available', 'status@broadcast'); } 
    catch(e) { console.log('Ping failed, socket peut être déconnecté'); }
}, 30000);

    // ---------------------
    // GESTION MESSAGES
    // ---------------------
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg?.message || msg.key.fromMe) return;

        const chatId = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        try {
            console.log("Message reçu de ", chatId , ":", text);

            await insertRow({ chat_id: chatId, role: "user", content: text });
            await sock.sendPresenceUpdate("composing", chatId);

            const answer = await generate(chatId, text, prompt);

            for (const item of answer) {
                if (item.type === "text") {
                    await insertRow({ chat_id: chatId, role: "assistant", content: item.text });
                    await sock.sendMessage(chatId, { text: item.text });
                }
                if (item.type === "commande") {
                    await insertRow({ chat_id: chatId, role: "assistant", content: 'Commande lancée' + JSON.stringify(item) });
                    const rapport =
`👨‍🍳 NOUVELLE COMMANDE
👤 Nom : ${item.name}
📞 Tel : ${item.phone}
📍 Adresse : ${item.address}
🍽️ ${item.menu}`;
                    await sock.sendMessage(CUISINE_JID, { text: rapport });
                }
            }
        } catch (e) {
            console.error("⚠️ ERREUR BOT:", e.message);
            await sock.sendMessage(chatId, { text: "Pouvez-vous répéter ?" });
        }
    });
}

startBot();
