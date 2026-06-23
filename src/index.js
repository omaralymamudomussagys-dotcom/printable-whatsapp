import express from 'express';
import cors from 'cors';
import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.WHATSAPP_API_KEY || 'printable-wa-secret';
const logger = pino({ level: 'silent' }); // silencioso nos logs do Baileys

// ─── Estado global (Multi-tenancy) ───────────────────────────────────────────
// Estrutura: { [instanceName]: { sock, qrBase64, isConnected, connectionStatus, webhookUrl } }
const instances = new Map();

// ─── Middleware de autenticação ───────────────────────────────────────────────
function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'] || req.headers['apikey'];
    if (!key || key !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized. Missing or invalid API Key.' });
    }
    next();
}

// ─── Inicializar WhatsApp (Por Instância) ──────────────────────────────────────
async function connectWhatsApp(instanceName) {
    if (!instances.has(instanceName)) {
        instances.set(instanceName, {
            sock: null,
            qrBase64: null,
            isConnected: false,
            connectionStatus: 'disconnected',
            webhookUrl: process.env.WEBHOOK_URL || null
        });
    }

    const instanceData = instances.get(instanceName);
    
    // Pasta separada para cada instância
    const sessionDir = `./sessions/auth_session_${instanceName}`;
    
    // Ler config.json se existir
    const configFile = path.join(sessionDir, 'config.json');
    if (fs.existsSync(configFile)) {
        try {
            const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            if (config.webhookUrl) {
                instanceData.webhookUrl = config.webhookUrl;
            }
        } catch (e) {
            console.error(`[Baileys][${instanceName}] Erro ao ler config.json:`, e.message);
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`[Baileys][${instanceName}] Iniciando com WA v${version.join('.')}`);
    instanceData.connectionStatus = 'connecting';

    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: [`Printable - ${instanceName}`, 'Chrome', '120.0'],
        generateHighQualityLinkPreview: false,
    });

    instanceData.sock = sock;

    // Guardar credenciais sempre que atualizadas
    sock.ev.on('creds.update', saveCreds);

    // Gerir eventos de conexão
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[Baileys][${instanceName}] Novo QR Code gerado`);
            instanceData.qrBase64 = await QRCode.toDataURL(qr);
            instanceData.connectionStatus = 'qr_ready';
        }

        if (connection === 'close') {
            instanceData.isConnected = false;
            instanceData.connectionStatus = 'disconnected';
            instanceData.qrBase64 = null;

            const shouldReconnect =
                (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;

            console.log(`[Baileys][${instanceName}] Conexão encerrada. Reconectar: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(() => connectWhatsApp(instanceName), 3000);
            } else {
                console.log(`[Baileys][${instanceName}] Sessão terminada (Logged Out).`);
                // Limpeza opcional da pasta em caso de logout:
                // fs.rmSync(sessionDir, { recursive: true, force: true });
            }
        }

        if (connection === 'open') {
            instanceData.isConnected = true;
            instanceData.connectionStatus = 'connected';
            instanceData.qrBase64 = null;
            console.log(`[Baileys][${instanceName}] ✅ WhatsApp conectado com sucesso!`);
        }
    });

    // Escutar mensagens recebidas (Webhook)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // Extrair texto da mensagem (suporta texto simples e texto estendido/respostas)
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        
        // Verificar se a mensagem começa por !venda (case insensitive)
        if (!text.toLowerCase().startsWith('!venda')) return;

        const webhookUrl = instanceData.webhookUrl;
        if (!webhookUrl) {
            console.log(`[Webhook][${instanceName}] ⚠️ Ignorado: Nenhum webhook configurado.`);
            return;
        }

        const payload = {
            event: 'messages.upsert',
            instance: instanceName,
            data: {
                key: msg.key,
                pushName: msg.pushName || 'Desconhecido',
                message: msg.message,
                messageTimestamp: msg.messageTimestamp
            }
        };

        try {
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': API_KEY
                },
                body: JSON.stringify(payload)
            });
            console.log(`[Webhook][${instanceName}] ✅ Enviado para ${webhookUrl}. Status: ${response.status}`);
        } catch (error) {
            console.error(`[Webhook][${instanceName}] ❌ Erro ao enviar:`, error.message);
        }
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getInstance(instanceName) {
    if (!instances.has(instanceName)) {
        // Inicializa automaticamente se não existir
        connectWhatsApp(instanceName);
    }
    return instances.get(instanceName);
}

// ─── Rotas (UI e Status Público) ──────────────────────────────────────────────

// Status da conexão
app.get('/status', (req, res) => {
    const instanceName = req.query.instance || 'Printable';
    const instanceData = instances.get(instanceName) || { connectionStatus: 'not_found', isConnected: false, qrBase64: null };
    
    res.json({
        instance: instanceName,
        status: instanceData.connectionStatus,
        connected: instanceData.isConnected,
        has_qr: !!instanceData.qrBase64,
    });
});

// QR Code (Interface Web)
app.get('/qr', (req, res) => {
    const instanceName = req.query.instance || 'Printable';
    const instanceData = getInstance(instanceName);

    if (instanceData.isConnected) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp - Conectado</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #e7f3ef; }
                    .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 20px rgba(0,0,0,0.1); text-align: center; border-top: 5px solid #128C7E; }
                    .icon { font-size: 4rem; color: #128C7E; margin-bottom: 1rem; }
                    h1 { color: #128C7E; margin: 0; }
                    p { color: #666; margin-top: 1rem; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="icon">✅</div>
                    <h1>WhatsApp Conectado!</h1>
                    <p>Instância: <b>${instanceName}</b></p>
                    <p>O seu servidor está pronto para enviar mensagens.</p>
                </div>
            </body>
            </html>
        `);
    }
    if (!instanceData.qrBase64) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta http-equiv="refresh" content="3"><title>Carregando...</title></head>
            <body style="font-family:sans-serif; text-align:center; padding-top:20%;">
                <h2>A gerar QR Code para ${instanceName}...</h2>
                <p>Aguarde um momento.</p>
            </body>
            </html>
        `);
    }
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp QR Code</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f0f0f0; }
                .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 20px rgba(0,0,0,0.1); text-align: center; }
                img { width: 280px; height: 280px; border: 1px solid #ddd; padding: 10px; border-radius: 10px; }
                h1 { color: #128C7E; }
                p { color: #666; }
                .status-dot { height: 10px; width: 10px; background-color: #ffcc00; border-radius: 50%; display: inline-block; margin-right: 5px; }
            </style>
            <script>
                setInterval(async () => {
                    try {
                        const res = await fetch('/status?instance=${instanceName}');
                        const data = await res.json();
                        if (data.connected) location.reload();
                    } catch (e) {}
                }, 3000);
            </script>
        </head>
        <body>
            <div class="card">
                <h1>🔗 Conectar WhatsApp</h1>
                <p><span class="status-dot"></span> Instância: <b>${instanceName}</b></p>
                <img src="${instanceData.qrBase64}" alt="QR Code" />
                <p style="font-size:0.85rem; color:#888; margin-top:1.5rem;">
                    Abra o WhatsApp no telemóvel > Dispositivos Vinculados > Conectar um dispositivo.
                </p>
            </div>
        </body>
        </html>
    `);
});

// Enviar mensagem de texto (Genérico, requer query param ?instance=)
app.post('/send-text', requireApiKey, async (req, res) => {
    const { phone, message } = req.body;
    const instanceName = req.query.instance || 'Printable';

    if (!phone || !message) {
        return res.status(400).json({ error: 'Campos obrigatórios: phone, message' });
    }

    const instanceData = instances.get(instanceName);
    if (!instanceData || !instanceData.isConnected || !instanceData.sock) {
        return res.status(503).json({ error: `Instância '${instanceName}' não conectada. Verifique /status.` });
    }

    try {
        const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
        const result = await instanceData.sock.sendMessage(jid, { text: message });
        console.log(`[Baileys][${instanceName}] ✅ Mensagem enviada para ${phone}`);
        res.json({ success: true, messageId: result?.key?.id });
    } catch (error) {
        console.error(`[Baileys][${instanceName}] ❌ Erro ao enviar para ${phone}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// ─── Endpoints Compatíveis com Evolution API (Para a Nexboard) ───────────────

app.all('/instance/connect/:instance', requireApiKey, (req, res) => {
    const instanceName = req.params.instance;
    const instanceData = getInstance(instanceName);

    if (instanceData.isConnected) {
        return res.json({ instance: { instanceName, state: 'open' } });
    }
    if (instanceData.qrBase64) {
        return res.json({ 
            instance: { instanceName, state: 'connecting' }, 
            base64: instanceData.qrBase64 
        });
    }
    return res.json({ instance: { instanceName, state: 'connecting' } });
});

app.all('/instance/connectionState/:instance', requireApiKey, (req, res) => {
    const instanceName = req.params.instance;
    const instanceData = instances.get(instanceName) || { connectionStatus: 'not_found', isConnected: false };

    return res.json({
        instance: {
            instanceName,
            state: instanceData.isConnected ? 'open' : (instanceData.connectionStatus === 'qr_ready' ? 'connecting' : instanceData.connectionStatus)
        }
    });
});

app.all('/instance/fetchInstances', requireApiKey, (req, res) => {
    const arr = [];
    for (const [instanceName, instanceData] of instances.entries()) {
        arr.push({
            instance: {
                instanceName,
                state: instanceData.isConnected ? 'open' : (instanceData.connectionStatus === 'qr_ready' ? 'connecting' : instanceData.connectionStatus)
            }
        });
    }
    return res.json(arr);
});

app.all('/instance/create', requireApiKey, (req, res) => {
    const instanceName = req.body.instanceName || req.query.instanceName || 'Printable';
    const webhook = req.body.webhook || req.body.webhookUrl;

    const instanceData = getInstance(instanceName);

    if (webhook) {
        instanceData.webhookUrl = webhook;
        console.log(`[Evolution API] Webhook configurado para '${instanceName}': ${webhook}`);
        
        const sessionDir = `./sessions/auth_session_${instanceName}`;
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        fs.writeFileSync(path.join(sessionDir, 'config.json'), JSON.stringify({ webhookUrl: webhook }));
    }

    return res.json({
        instance: { instanceName, status: 'created' },
        hash: { apikey: API_KEY }
    });
});

app.all('/webhook/set/:instance', requireApiKey, (req, res) => {
    const instanceName = req.params.instance;
    const webhook = req.body.url || req.body.webhook || req.body.webhookUrl;
    
    const instanceData = getInstance(instanceName);
    
    if (webhook) {
        instanceData.webhookUrl = webhook;
        console.log(`[Evolution API] Webhook atualizado via /webhook/set para '${instanceName}': ${webhook}`);
        
        const sessionDir = `./sessions/auth_session_${instanceName}`;
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        fs.writeFileSync(path.join(sessionDir, 'config.json'), JSON.stringify({ webhookUrl: webhook }));
    }
    
    return res.json({ status: 'SUCCESS', webhook });
});

app.all('/message/sendText/:instance', requireApiKey, async (req, res) => {
    const instanceName = req.params.instance;
    const { number, text } = req.body;
    const phone = number || req.body.phone;

    if (!phone || !text) return res.status(400).json({ error: 'Campos obrigatórios: number, text' });
    
    const instanceData = instances.get(instanceName);
    if (!instanceData || !instanceData.isConnected || !instanceData.sock) {
        return res.status(503).json({ error: `Instância ${instanceName} não está conectada.` });
    }

    try {
        const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
        const result = await instanceData.sock.sendMessage(jid, { text });
        console.log(`[Evolution API][${instanceName}] ✅ Texto enviado para ${phone}`);
        res.json({ key: result?.key });
    } catch (error) {
        console.error(`[Evolution API][${instanceName}] ❌ Erro ao enviar texto para ${phone}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

app.all('/message/sendMedia/:instance', requireApiKey, async (req, res) => {
    const instanceName = req.params.instance;
    const { number, mediatype, mimetype, media, fileName, caption } = req.body;
    const phone = number || req.body.phone;

    if (!phone || !media) return res.status(400).json({ error: 'Campos obrigatórios: number, media' });
    
    const instanceData = instances.get(instanceName);
    if (!instanceData || !instanceData.isConnected || !instanceData.sock) {
        return res.status(503).json({ error: `Instância ${instanceName} não está conectada.` });
    }

    try {
        const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
        
        let mediaContent;
        if (media.startsWith('http')) {
            mediaContent = { url: media };
        } else {
            const base64Data = media.includes('base64,') ? media.split('base64,')[1] : media;
            mediaContent = Buffer.from(base64Data, 'base64');
        }

        const messageOptions = {};
        if (mediatype === 'document' || (mimetype && mimetype.includes('pdf'))) {
            messageOptions.document = mediaContent;
            messageOptions.mimetype = mimetype || 'application/pdf';
            if (fileName) messageOptions.fileName = fileName;
            if (caption) messageOptions.caption = caption;
        } else if (mediatype === 'image') {
            messageOptions.image = mediaContent;
            if (caption) messageOptions.caption = caption;
        } else {
            messageOptions.document = mediaContent;
            messageOptions.mimetype = mimetype || 'application/octet-stream';
            if (fileName) messageOptions.fileName = fileName;
            if (caption) messageOptions.caption = caption;
        }

        const result = await instanceData.sock.sendMessage(jid, messageOptions);
        console.log(`[Evolution API][${instanceName}] ✅ Mídia enviada para ${phone}`);
        res.json({ key: result?.key });
    } catch (error) {
        console.error(`[Evolution API][${instanceName}] ❌ Erro ao enviar mídia para ${phone}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.json({ service: 'Printable WhatsApp Server', version: '1.1.0 (Multi-tenant)' });
});

app.use((req, res, next) => {
    res.status(404).json({
        status: 404,
        error: "Not Found",
        message: `Endpoint ${req.method} ${req.url} não encontrado.`
    });
});

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Server] 🚀 Servidor rodando na porta ${PORT}`);
    
    // Garantir que a diretoria de sessões existe
    if (!fs.existsSync('./sessions')) {
        fs.mkdirSync('./sessions');
    }

    // Restabelecer sessões guardadas
    const sessions = fs.readdirSync('./sessions', { withFileTypes: true });
    for (const dirent of sessions) {
        if (dirent.isDirectory() && dirent.name.startsWith('auth_session_')) {
            const instanceName = dirent.name.replace('auth_session_', '');
            console.log(`[Server] Restabelecendo instância: ${instanceName}`);
            connectWhatsApp(instanceName);
        }
    }

    // Inicializar instância padrão (se não tiver sido iniciada pelas sessões guardadas)
    const defaultInstance = process.env.INSTANCE_NAME || 'Printable';
    if (!instances.has(defaultInstance)) {
        connectWhatsApp(defaultInstance);
    }
});
