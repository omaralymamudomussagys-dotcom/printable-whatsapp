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

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.WHATSAPP_API_KEY || 'printable-wa-secret';
const logger = pino({ level: 'silent' }); // silencioso nos logs do Baileys

// ─── Estado global ────────────────────────────────────────────────────────────
let sock = null;
let qrBase64 = null;
let isConnected = false;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let dynamicWebhooks = {}; // Armazena { instanceName: webhookUrl } dinamicamente

// ─── Middleware de autenticação ───────────────────────────────────────────────
function requireApiKey(req, res, next) {
    // Nexboard e Evolution API usam o header 'apikey', mas suportamos 'x-api-key' também
    const key = req.headers['x-api-key'] || req.headers['apikey'];
    if (!key || key !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized. Missing or invalid API Key.' });
    }
    next();
}

// ─── Inicializar WhatsApp ─────────────────────────────────────────────────────
async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_session');
    const { version } = await fetchLatestBaileysVersion();

    console.log(`[Baileys] Iniciando com WA v${version.join('.')}`);
    connectionStatus = 'connecting';

    sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },

        browser: ['Printable Server', 'Chrome', '120.0'],
        generateHighQualityLinkPreview: false,
    });

    // Guardar credenciais sempre que atualizadas
    sock.ev.on('creds.update', saveCreds);

    // Gerir eventos de conexão
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('[Baileys] Novo QR Code gerado — acesse GET /qr para ver');
            qrBase64 = await QRCode.toDataURL(qr);
            connectionStatus = 'qr_ready';
        }

        if (connection === 'close') {
            isConnected = false;
            connectionStatus = 'disconnected';
            qrBase64 = null;

            const shouldReconnect =
                (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;

            console.log(`[Baileys] Conexão encerrada. Reconectar: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(connectWhatsApp, 3000);
            }
        }

        if (connection === 'open') {
            isConnected = true;
            connectionStatus = 'connected';
            qrBase64 = null;
            console.log('[Baileys] ✅ WhatsApp conectado com sucesso!');
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

        const instancesToNotify = Object.keys(dynamicWebhooks);
        
        // Fallback: se não existir nenhuma instância em memória mas existir no .env
        if (instancesToNotify.length === 0 && process.env.WEBHOOK_URL) {
            const fallbackInstance = process.env.INSTANCE_NAME || 'Printable';
            dynamicWebhooks[fallbackInstance] = process.env.WEBHOOK_URL;
            instancesToNotify.push(fallbackInstance);
        }

        for (const instanceName of instancesToNotify) {
            const webhookUrl = dynamicWebhooks[instanceName];
            if (!webhookUrl) continue;

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
                // Usando fetch nativo (Node >= 18)
                const response = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': process.env.WHATSAPP_API_KEY || 'printable-wa-secret'
                    },
                    body: JSON.stringify(payload)
                });
                console.log(`[Webhook] ✅ Webhook enviado para instância '${instanceName}' (${webhookUrl}). Status: ${response.status}`);
            } catch (error) {
                console.error(`[Webhook] ❌ Erro ao enviar webhook para '${instanceName}':`, error.message);
            }
        }
    });
}

// ─── Rotas ────────────────────────────────────────────────────────────────────

// Status da conexão (público — para monitoramento)
app.get('/status', (req, res) => {
    res.json({
        status: connectionStatus,
        connected: isConnected,
        has_qr: !!qrBase64,
    });
});

// QR Code (público — necessário para escanear)
app.get('/qr', (req, res) => {
        if (isConnected) {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Printable WhatsApp - Conectado</title>
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
                        <p>O seu servidor está pronto para enviar mensagens.</p>
                        <p style="font-size: 0.9rem; color: #999;">Pode fechar esta janela agora.</p>
                    </div>
                </body>
                </html>
            `);
        }
        if (!qrBase64) {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head><meta http-equiv="refresh" content="3"><title>Carregando...</title></head>
                <body style="font-family:sans-serif; text-align:center; padding-top:20%;">
                    <h2>A gerar QR Code...</h2>
                    <p>Aguarde um momento.</p>
                </body>
                </html>
            `);
        }
        // Retorna HTML com o QR code para fácil escaneamento
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Printable WhatsApp QR Code</title>
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
                    // Verificar status a cada 3 segundos
                    setInterval(async () => {
                        try {
                            const res = await fetch('/status');
                            const data = await res.json();
                            if (data.connected) {
                                location.reload(); // Vai cair no bloco 'isConnected' acima
                            }
                        } catch (e) {}
                    }, 3000);
                </script>
            </head>
            <body>
                <div class="card">
                    <h1>🔗 Conectar WhatsApp</h1>
                    <p><span class="status-dot"></span> Aguardando escaneamento...</p>
                    <img src="${qrBase64}" alt="QR Code" />
                    <p style="font-size:0.85rem; color:#888; margin-top:1.5rem;">
                        Abra o WhatsApp no telemóvel > Dispositivos Vinculados > Conectar um dispositivo.
                    </p>
                </div>
            </body>
            </html>
        `);
    });

// Enviar mensagem de texto (protegido por API Key)
app.post('/send-text', requireApiKey, async (req, res) => {
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Campos obrigatórios: phone, message' });
    }

    if (!isConnected || !sock) {
        return res.status(503).json({ error: 'WhatsApp não está conectado. Verifique /status e /qr.' });
    }

    try {
        // Formatar número (garantir que tem @s.whatsapp.net)
        const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

        const result = await sock.sendMessage(jid, { text: message });
        console.log(`[Baileys] ✅ Mensagem enviada para ${phone}`);
        res.json({ success: true, messageId: result?.key?.id });
    } catch (error) {
        console.error(`[Baileys] ❌ Erro ao enviar para ${phone}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// ─── Endpoints Compatíveis com Evolution API (Para a Nexboard) ───────────────

// 1. Gerar/Obter QR Code
app.all('/instance/connect/:instance', requireApiKey, (req, res) => {
    if (isConnected) {
        return res.json({ instance: { instanceName: req.params.instance, state: 'open' } });
    }
    if (qrBase64) {
        return res.json({ 
            instance: { instanceName: req.params.instance, state: 'connecting' }, 
            base64: qrBase64 
        });
    }
    return res.json({ instance: { instanceName: req.params.instance, state: 'connecting' } });
});

// 2. Obter Estado da Conexão
app.all('/instance/connectionState/:instance', requireApiKey, (req, res) => {
    return res.json({
        instance: {
            instanceName: req.params.instance,
            state: isConnected ? 'open' : (connectionStatus === 'qr_ready' ? 'connecting' : connectionStatus)
        }
    });
});

// 2b. Buscar instâncias (alguns sistemas pedem isso antes de conectar)
app.all('/instance/fetchInstances', requireApiKey, (req, res) => {
    return res.json([
        {
            instance: {
                instanceName: 'KAIZEN E PRINTABLE ATUALIZAÇÕES',
                state: isConnected ? 'open' : (connectionStatus === 'qr_ready' ? 'connecting' : connectionStatus)
            }
        }
    ]);
});

// 2c. Criar instância (mock dinâmico)
app.all('/instance/create', requireApiKey, (req, res) => {
    const instanceName = req.body.instanceName || req.query.instanceName || 'Printable';
    const webhook = req.body.webhook || req.body.webhookUrl;

    if (webhook) {
        dynamicWebhooks[instanceName] = webhook;
        console.log(`[Evolution API] Webhook configurado dinamicamente para a instância '${instanceName}': ${webhook}`);
    }

    return res.json({
        instance: {
            instanceName: instanceName,
            status: 'created'
        },
        hash: { apikey: API_KEY }
    });
});

// Endpoint adicional para setar webhook separadamente, caso a Nexboard use
app.all('/webhook/set/:instance', requireApiKey, (req, res) => {
    const instanceName = req.params.instance;
    const webhook = req.body.url || req.body.webhook || req.body.webhookUrl;
    
    if (webhook) {
        dynamicWebhooks[instanceName] = webhook;
        console.log(`[Evolution API] Webhook atualizado via /webhook/set para a instância '${instanceName}': ${webhook}`);
    }
    
    return res.json({ status: 'SUCCESS', webhook });
});

// 3. Enviar Texto
app.all('/message/sendText/:instance', requireApiKey, async (req, res) => {
    // Nexboard pode enviar como { number, text } ou as vezes variations
    const { number, text } = req.body;
    const phone = number || req.body.phone;
    if (!phone || !text) return res.status(400).json({ error: 'Campos obrigatórios: number, text' });
    if (!isConnected || !sock) return res.status(503).json({ error: 'WhatsApp não está conectado.' });

    try {
        const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
        const result = await sock.sendMessage(jid, { text });
        console.log(`[Evolution API] ✅ Texto enviado para ${phone}`);
        res.json({ key: result?.key });
    } catch (error) {
        console.error(`[Evolution API] ❌ Erro ao enviar texto para ${phone}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// 4. Enviar Media/Documento (PDF da fatura)
app.all('/message/sendMedia/:instance', requireApiKey, async (req, res) => {
    const { number, mediatype, mimetype, media, fileName, caption } = req.body;
    const phone = number || req.body.phone;
    if (!phone || !media) return res.status(400).json({ error: 'Campos obrigatórios: number, media' });
    if (!isConnected || !sock) return res.status(503).json({ error: 'WhatsApp não está conectado.' });

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

        const result = await sock.sendMessage(jid, messageOptions);
        console.log(`[Evolution API] ✅ Mídia enviada para ${phone}`);
        res.json({ key: result?.key });
    } catch (error) {
        console.error(`[Evolution API] ❌ Erro ao enviar mídia para ${phone}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// Health check simples (para o Railway saber que está vivo)
app.get('/', (req, res) => {
    res.json({ service: 'Printable WhatsApp Server', version: '1.0.0', status: connectionStatus });
});

// Handler para evitar que erros 404 retornem HTML (causando o erro '<!doctype' no Nexboard)
app.use((req, res, next) => {
    console.log(`[404] Nexboard tentou acessar: ${req.method} ${req.url}`);
    res.status(404).json({
        status: 404,
        error: "Not Found",
        message: `Endpoint ${req.method} ${req.url} não implementado no servidor fake Evolution API.`
    });
});

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Server] 🚀 Servidor rodando na porta ${PORT}`);
    connectWhatsApp();
});
