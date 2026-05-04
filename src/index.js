import express from 'express';
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
app.use(express.json());

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.WHATSAPP_API_KEY || 'printable-wa-secret';
const logger = pino({ level: 'silent' }); // silencioso nos logs do Baileys

// ─── Estado global ────────────────────────────────────────────────────────────
let sock = null;
let qrBase64 = null;
let isConnected = false;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'

// ─── Middleware de autenticação ───────────────────────────────────────────────
function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!key || key !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized. Missing or invalid X-Api-Key header.' });
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
        printQRInTerminal: true,
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
        return res.json({ message: 'WhatsApp já está conectado. Nenhum QR necessário.' });
    }
    if (!qrBase64) {
        return res.json({ message: 'QR Code ainda não gerado. Aguarde alguns segundos e tente novamente.' });
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
                img { width: 280px; height: 280px; }
                h1 { color: #128C7E; }
                p { color: #666; }
                .refresh { margin-top: 1rem; padding: 0.5rem 1.5rem; background: #128C7E; color: white; border: none; border-radius: 0.5rem; cursor: pointer; font-size: 1rem; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>🔗 Printable WhatsApp</h1>
                <p>Escanei o QR Code com o WhatsApp do seu telemóvel</p>
                <img src="${qrBase64}" alt="QR Code" />
                <br/>
                <button class="refresh" onclick="location.reload()">🔄 Atualizar QR</button>
                <p style="font-size:0.8rem; margin-top:1rem;">O QR Code expira em ~60 segundos. Clique em Atualizar se expirar.</p>
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

// Health check simples (para o Railway saber que está vivo)
app.get('/', (req, res) => {
    res.json({ service: 'Printable WhatsApp Server', version: '1.0.0', status: connectionStatus });
});

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Server] 🚀 Servidor rodando na porta ${PORT}`);
    connectWhatsApp();
});
