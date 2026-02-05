const { default: makeWaSocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Mistral } = require('@mistralai/mistralai');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot en ligne ✅'));
app.listen(PORT, () => console.log(`Serveur écoute sur le port ${PORT}`));

// =====================
// CONFIG
// =====================
const ia = new Mistral({ apiKey: process.env.mistraKey });
const supabase = createClient(process.env.supaUrl, process.env.supaKey);
const CUISINE_JID = "22968204629@s.whatsapp.net";
const MAX_HISTORY = 20;
const AUTH_DIR = './auth_info_baileys';
const LOCK_FILE = path.join(AUTH_DIR, 'bot.lock');

// =====================
// LOCK INSTANCE
// =====================
function isAnotherInstanceRunning() {
    if (!fs.existsSync(LOCK_FILE)) return false;
    try {
        const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8'));
        process.kill(pid, 0); // Vérifie si le processus est actif
        return true;
    } catch {
        return false; // Processus mort
    }
}

function acquireLock() {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(LOCK_FILE, process.pid.toString());
}

function releaseLock() {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
}

process.on('exit', releaseLock);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

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
// AUTH SUPABASE
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
            } catch {}
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
        { role: "user", content :  userText }
    ];

    let res;
    try {
        res = await ia.chat.complete({
            model: "mistral-small-latest",
            messages,
            reponseFormat: { type: "json_object" }
        });
    } catch {
        await new Promise(r => setTimeout(r, 1200));
        res = await ia.chat.complete({
            model: "mistral-small-latest",
            messages,
            reponseFormat: { type: "json_object" }
        });
    }

    const parsed = safeJsonParse(res.choices[0].message.content);
    if (!parsed) throw new Error("JSON IA invalide");
    return parsed;
}

// =====================
// BOT
// =====================
async function startBot() {
    if (isAnotherInstanceRunning()) {
        console.log("⚠️ Une autre instance du bot est déjà active. Arrêt.");
        process.exit(0);
    }
    acquireLock();

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
Poulet frais 2700f le kilo, 3300, 1,3 kg 4000 1,5 kg, 6000 1,8 kg
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
    `; // ton menu ici
    const prompt = `
Tu es l’assistant officiel du restaurant MONTECARL AGROALIMENTAIRE.
Tu te comportes comme un employé humain sérieux, poli et chaleureux.

🎯 TA MISSION

Présenter le menu au client (en texte lisible)

Aider à passer une commande

Donner les horaires et la localisation du restaurant

Accompagner le client jusqu’à confirmation finale


━━━━━━━━━━━━━━━━━━
📌 COMPORTEMENT GÉNÉRAL
━━━━━━━━━━━━━━━━━━

Toujours naturel, humain, poli et professionnel

Concis, clair et chaleureux

Strictement dans le cadre professionnel du restaurant

Si le client sort du cadre professionnel, réponds poliment que tu travailles uniquement dans ce cadre

Ne répète jamais inutilement les informations

Ne change jamais de sujet sans raison

Ne contredis jamais les règles ci-dessous
-Tu ne parle jamais à la première personne du singulier mais toujours à la première personne du pluriel (nous)
-Tu renvoie un menu cool reformulé


━━━━━━━━━━━━━━━━━━
✨ STICKERS / EMOJIS
━━━━━━━━━━━━━━━━━━

Tu peux utiliser 1 à 3 emojis par message dans les textes

Emojis légers et adaptés : accueil, menu, commande, confirmation

Aucun emoji dans les données de commande

Jamais d’emojis excessifs ou enfantins


━━━━━━━━━━━━━━━━━━
👋 ACCUEIL CHALEUREUX
━━━━━━━━━━━━━━━━━━
Si l’utilisateur salue (bonjour, salut, bonsoir…) :

Réponds chaleureusement et humainement

Propose clairement : consulter le menu ou passer une commande
Exemple :
[
{
"type": "text",
"text": "Bienvenue chez MonteCarl AGROALIMENTAIRE 😊🍽️\nSouhaitez-vous consulter notre menu ou passer une commande ?"
}
]


━━━━━━━━━━━━━━━━━━
📦 FORMAT DE RÉPONSE STRICT
━━━━━━━━━━━━━━━━━━

UNIQUEMENT JSON (tableau)

AUCUN texte hors JSON

Utilise \n pour les retours à la ligne

Ne jamais envoyer de texte brut hors JSON


Format texte simple :
[
{ "type": "text", "text": "message ici" }
]

━━━━━━━━━━━━━━━━━━
🍽️ MENU
━━━━━━━━━━━━━━━━━━

Toujours en TEXTE lisible

Ne jamais mettre le menu dans un JSON structuré

Ne jamais inventer un plat ou un prix

Si une info n’est pas dans le menu fourni, dire clairement que tu ne l’as pas


Menu :
${menu}

━━━━━━━━━━━━━━━━━━
🛒 COMMANDE
━━━━━━━━━━━━━━━━━━
N’initie la prise des informations et des plats que si l’utilisateur indique clairement qu’il souhaite passer une commande (exemples : "Je veux commander", "Passer une commande", "Commander maintenant").

Si l’utilisateur parle d’autre chose ou consulte juste le menu, ne demande jamais le nom, téléphone, adresse ou commande.
Avant toute commande, tu DOIS avoir :

Nom du client

Numéro de téléphone

Adresse de livraison 

Détails précis de la commande


Zone de livraison gratuite : Cotonou , Calavi

En dehors de ces deux zones la livraison est a 1000f

Mentionne a l'utilisateur que seul Cotonou et Calavi sont gratuits 

━━━━━━━━━━━━━━━━━━
✅ CONFIRMATION OBLIGATOIRE
━━━━━━━━━━━━━━━━━━

Reformuler toujours la commande clairement

Demander explicitement confirmation avant d’envoyer

Tant que non confirmé → aucune commande envoyée

Une fois envoyée → ne jamais envoyer une autre commande


Format commande (une seule fois) :
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
Adresse du restaurant : Nous sommes situées dans la rue en face de la clinique divine misericorde sur le nouveau goudron menant a la pharmacie sos a Abomey Calavi. Une fois dans la rue de la clinique continuez tout droit jusqua finir la rue sur le carrefour en T puis tournez a droite et avancez legerement en regardant sur votre gauche  jusqua voir nos enseignes.

Horaires d’ouverture : 9h a 21h tous les jours 

Téléphone du restaurant (plainte ou info dépassant ton rôle) : 0166577174

Reponds toujours strictement en tableau Json

━━━━━━━━━━━━━━━━━━
🚫 INTERDICTIONS STRICTES
━━━━━━━━━━━━━━━━━━

Ne jamais proposer de réduction ou offre gratuite

Ne jamais inventer une information

Ne jamais envoyer plusieurs commandes

Ne jamais sortir du contexte de la discussion

Ne jamais répondre hors JSON`; // ton prompt complet ici

    await downloadAuthFromSupabase();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWaSocket({
        auth: state,
        printQRInTerminal: false
    });

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
                setTimeout(startBot, 15000);
            } else {
                releaseLock();
            }
        }

        if (connection === 'open') console.log('✅ Bot connecté avec succès');
    });

    setInterval(() => {
        try { sock.sendPresenceUpdate('available', 'status@broadcast'); } 
        catch(e) { console.log('Ping failed, socket peut être déconnecté'); }
    }, 30000);

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg?.message || msg.key.fromMe) return;

        const chatId = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;
        
          // ===========================
    // 1️⃣ Ignorer les "status" (statuts WhatsApp)
    // ===========================
    if (msg.key.participant === 'status@broadcast') return;

    // ===========================
    // 2️⃣ Détecter les messages non-textes
    // =========================

    // Liste des types médias à ignorer
    const mediaTypes = [
        'imageMessage',
        'videoMessage',
        'audioMessage',
        'stickerMessage',
        'documentMessage',
        'contactMessage',
        'locationMessage'
    ];

    const hasMedia = mediaTypes.some(type => msg.message[type]);
    if (hasMedia) {
        await sock.sendMessage(chatId, { 
            text: "⚠️ Désolé, je ne peux traiter que des messages texte pour le moment. Merci de réécrire votre message en texte." 
        });
        return;
    }
    

        try {
            console.log("Message reçu de", chatId, ":", text);
            await insertRow({ chat_id: chatId, role: "user", content: text });
            await sock.sendPresenceUpdate("composing", chatId);

            const answer = await generate(chatId, text, prompt);

            for (const item of answer) {
                if (item.type === "text") {
                    await insertRow({ chat_id: chatId, role: "assistant", content: item.text });
                    await sock.sendMessage(chatId, { text: item.text });
                    console.log("Réponse IA > :" , item.text)
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
