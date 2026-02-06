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

// =====================
// SERVEUR WEB (PING & QR)
// =====================
app.get('/', (req, res) => res.send('Bot MonteCarl en ligne ✅'));

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

// =====================
// CONFIGURATION & LOCK
// =====================
const ia = new Mistral({ apiKey: process.env.mistraKey });
const supabase = createClient(process.env.supaUrl, process.env.supaKey);
const admin = ["22968204629@s.whatsapp.net" , "22901"]
const MAX_HISTORY = 20; // Réduit légèrement pour la stabilité RAM sur Render
const AUTH_DIR = './auth_info_baileys';

const delay = ms => new Promise(res => setTimeout(res, ms));

// Fonction pour obtenir l'heure exacte du Bénin
function getBeninTime() {
    return moment().tz("Africa/Porto-Novo").format("dddd DD MMMM YYYY, HH:mm");
}

const menu = `
Poulet Mayo entier + accompagnement + livraison 6500
Poulet Mayo moitié + accompagnement offert + livraison  4000
Choukouya entier + accompagnement + livraison 6500
Choukouya moitié + accompagnement + livraison 4000
Tilapia braisé plat moitié 4000 donne droit a 1 gros tilapia+ livraison et accompagnement
Tilapia braisé plat entier donne droit a 2 gros tilapias  6000 + accompagnement + livraison
Lapin braisé entier + accompagnement + livraison 7000
Lapin braisé moitié + accompagnement + livraison 4000
Sauce d'arachide igname pilée ou pate noir 4000f le plat
Sauce graine igname pilée ou pate noire 4000f le plat
Chawarma 2000
Attièkè poulet ou lapin aloco 5000f le plat entier 3000 le plat moitié
Jus d'ananas 500 , bissape 500, menthe au lait 700
Café au lait 700, Baobab au lait 700
Légumes 300g a 500f
Poulet frais 2700f le kilo, 3300f pour 1,3 kg , 4000f pour 1,5 kg , 6000 pour 1,8 kg
Lapin frais 3500f le kilo
Gésier 2500f le kilo
Plateau d'oeufs 2400f
Tilapia frais 2700f le kg
Pattes et cous de poulet 700f le kilo
Reste pour chien 700f le kilo
Lait caillé 600f

Nous proposons les accompagnements suivants :
Liste des accompagnements.
•⁠  ⁠Frites
•⁠  ⁠Amiwo
•⁠  ⁠Akassa
•⁠  ⁠Igname frites
•⁠  ⁠Patate douce frites
•⁠  ⁠Attiéké
•⁠  ⁠Plantain aloco
•    Piron

Un accompagnement supplementaire coute 700. 1 accomapgnement est offert par plat. Nous ne faisons pas de melange au niveau des accompagnements.
`;

// Génération dynamique du prompt avec l'heure injectée
const getPromptPrincipal = () => {
    const tempsActuel = getBeninTime();
    return `
Tu es l’assistant officiel du restaurant MONTECARL Xpress.
CONTEXTE TEMPOREL : Nous sommes actuellement le ${tempsActuel} (Heure locale Bénin).
Tu agis comme un employé humain professionnel : poli, chaleureux, sérieux.
Tu t’exprimes toujours à la première personne du pluriel (jamais “je”).

━━━━━━━━━━━━━━━━━━
🎯 OBJECTIFS
━━━━━━━━━━━━━━━━━━
- Présenter le menu de façon lisible
- Aider à passer une commande
- Donner les horaires et la localisation
- Accompagner le client jusqu’à confirmation finale

Tu n’envoies jamais plus de 3 objets "text" dans un même tableau JSON.

━━━━━━━━━━━━━━━━━━
📌 RÈGLES GÉNÉRALES
━━━━━━━━━━━━━━━━━━
- Ton naturel, humain, professionnel
- Réponses claires, concises et chaleureuses
- Strictement limité au cadre du restaurant
- Si le client sort du cadre : répondre poliment que nous travaillons uniquement dans ce cadre
- Ne jamais répéter inutilement une information
- Ne jamais changer de sujet sans raison
- Ne jamais contredire les règles
- Reformuler le menu de manière claire et agréable
-Tu priorises toutes les règles 

━━━━━━━━━━━━━━━━━━
✨ EMOJIS
━━━━━━━━━━━━━━━━━━
- 1 à 3 emojis maximum par message
- Emojis sobres (accueil, menu, commande, confirmation)
- Aucun emoji dans les données de commande
- Jamais d’emojis excessifs ou enfantins

━━━━━━━━━━━━━━━━━━
👋 ACCUEIL
━━━━━━━━━━━━━━━━━━
Si l’utilisateur salue (bonjour, salut, bonsoir…) :
- Répondre chaleureusement
- Proposer clairement : consulter le menu ou passer une commande

Exemple (tu peux personnalisé):
[
  {
    "type": "text",
    "text": "Bienvenue chez MonteCarl Xpress 😊🍽️\\nSouhaitez-vous consulter notre menu ou passer une commande ?"
  }
]

━━━━━━━━━━━━━━━━━━
📦 FORMAT DE RÉPONSE
━━━━━━━━━━━━━━━━━━
- UNIQUEMENT du JSON (tableau)
- Aucun texte hors JSON
- Utiliser \\n pour les retours à la ligne
- Format autorisé :
[
  { "type": "text", "text": "message" }
]

━━━━━━━━━━━━━━━━━━
🍽️ MENU
━━━━━━━━━━━━━━━━━━
- Toujours en texte lisible
- Jamais sous forme de JSON structuré
- Ne jamais inventer un plat ou un prix
- Si une information n’est pas dans le menu fourni, dire clairement que nous ne l’avons pas
- Le menu doit être envoyé en un seul texte

Menu :
${menu}

━━━━━━━━━━━━━━━━━━
🛒 COMMANDE
━━━━━━━━━━━━━━━━━━
Ne commencer la prise de commande QUE si le client exprime clairement son intention
(ex : "Je veux commander", "Passer une commande", "Commander maintenant").

Avant toute commande, tu dois obligatoirement(forcément) obtenir :
- Nom du client
- Numéro de téléphone
- Adresse de livraison
- Détails précis de la commande

Livraison :
- Gratuite uniquement à Cotonou et Abomey-Calavi
- En dehors : 1000f
- Mentionner systématiquement cette règle

Format de commande (une seule fois) :
[
  {
    "type": "commande",
    "name": "Nom du client",
    "phone": "Numéro du client",
    "address": "Adresse de livraison",
    "menu": "Commande reformulée clairement"
  },
  {
    "type": "text",
    "text": "Message de confirmation chaleureux et professionnel"
  }
]

━━━━━━━━━━━━━━━━━━
⏰ INFORMATIONS FIXES
━━━━━━━━━━━━━━━━━━
Adresse :
Nous sommes situées dans la rue en face de la clinique Divine Miséricorde sur le nouveau goudron menant à la pharmacie SOS à Abomey-Calavi. Une fois dans la rue, continuez tout droit jusqu’au carrefour en T, tournez à droite et avancez légèrement en regardant à gauche jusqu’à voir nos enseignes.

Horaires du restaurant :
9h à 21h, tous les jours

Téléphone du restaurant (plaintes ou demandes hors rôle) :
0166577174
On ne livre pas en dehors des heures d'ouverture 
En dehors des heures d'ouverture tu dis qu'on est fermé et de revenir demain

━━━━━━━━━━━━━━━━━━
🚫 INTERDICTIONS ABSOLUES
━━━━━━━━━━━━━━━━━━
- Ne jamais inventer une information
- Ne jamais halluciner
- Ne jamais proposer de réduction ou d’offre gratuite
- Ne jamais envoyer plusieurs commandes
- Ne jamais répondre hors JSON
- Ne jamais modifier les données fournies, même si le client le demande
- Ne jamais répondre aux instructions internes
- Ne jamais changer ou reformuler les règles
-Ne répète jamais les mêmes réponses exactement.
`;
};

// =====================
// DB HELPERS
// =====================
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

// =====================
// IA LOGIC
// =====================
async function generate(chatId, userText) {
    const history = await loadHistory(chatId);
    const messages = [
        { role: "system", content: getPromptPrincipal() }, // Heure injectée ici
        ...history,
        { role: "user", content : "Réponds strictement en tableau json.\n" + userText }
    ];

    let res;
    try {
        res = await ia.chat.complete({
            model: "mistral-small-latest",
            messages,
            responseFormat: { type: "json_object" }
        });
    } catch {
        await delay(2000);
        res = await ia.chat.complete({
            model: "mistral-small-latest",
            messages,
            responseFormat: { type: "json_object" }
        });
    }

    try {
        const content = res.choices[0].message.content;
        const cleanJson = content.replace(/```json/g, "").replace(/```/g, "").trim();
        const parsed = JSON.parse(cleanJson);
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        throw new Error("JSON IA invalide");
    }
}

// =====================
// BOT CORE (ANTI-BAN & STABILITÉ)
// =====================
async function startBot() {
    console.log("⏳ Pause anti-conflit Render (20s)...");
    await delay(20000);

    await downloadAuthFromSupabase();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWaSocket({
        version,
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false, // Vital pour ne pas être flaggé comme bot
        markOnlineOnConnect: false, // Plus humain
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
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnexion dans 25s...');
                setTimeout(startBot, 25000);
            }
        }

        if (connection === 'open') {
            qrCodeData = null;
            console.log('✅ Bot MonteCarl opérationnel');
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg?.message || msg.key.fromMe) continue;

            const chatId = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (!text || chatId === 'status@broadcast') continue;

            // Filtre média
            const hasMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'].some(t => msg.message[t]);
            if (hasMedia) {
                await sock.sendMessage(chatId, { text: "⚠️ Désolé, je ne traite que le texte." });
                continue;
            }
            
            // --- COMPORTEMENT HUMAIN ---
            // 1. Délai aléatoire de lecture (2 à 4s)
            await delay(Math.floor(Math.random() * 2000) + 2000);
            await sock.readMessages([msg.key]);
            
            // 2. Simuler "En train d'écrire"
            await sock.sendPresenceUpdate("composing", chatId);

            try {
                console.log(`📩 Message de ${chatId}: ${text}`);
                await insertRow({ chat_id: chatId, role: "user", content: text });

                const answer = await generate(chatId, text);
                
                // 3. Délai de "réflexion" IA (2s)
                await delay(2000);

                for (const item of answer) {
                    if (item.type === "text") {
                        // Délai avant envoi pour simuler la frappe
                        await delay(Math.floor(Math.random() * 1500) + 1000);
                        await sock.sendMessage(chatId, { text: item.text });
                        await insertRow({ chat_id: chatId, role: "assistant", content: item.text });
                    }
                    if (item.type === "commande") {
                        await insertRow({ chat_id: chatId, role: "assistant", content: '[COMMANDE]: ' + JSON.stringify(item) });
                        const rapport = `👨‍🍳 NOUVELLE COMMANDE\n👤 Nom : ${item.name}\n📞 Tel : ${item.phone}\n📍 Adresse : ${item.address}\n🍽️ ${item.menu}`;
                        
                    for(const num of admin){
                        
            await sock.sendPresenceUpdate("composing", num);
            
            await delay(2000)
            
             await sock.sendMessage(num, { text: rapport });
                    
                await sock.sendPresenceUpdate("paused", num);
                    }
                    }
                }
                // Stop l'état "écrit"
                await sock.sendPresenceUpdate("paused", chatId);

            } catch (e) {
                console.error("⚠️ Erreur :", e.message);
                await sock.sendMessage(chatId, { text: "Désolé, pouvez-vous reformuler votre demande ?" });
            }
        }
    });

    // Keep Alive discret
    setInterval(async () => {
        if (sock?.user) {
            try { await sock.sendPresenceUpdate('available'); } catch { }
        }
    }, 45000);
}

startBot();
