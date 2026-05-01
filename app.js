
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ==========================================
// 1. SUPABASE (DATABÁZA) NASTAVENIA
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================================
// 2. TWILIO WEBHOOK - PRIAME NAPOJENIE NA CARTESIA CEZ WEBSOCKET
// ==========================================
app.post('/twilio/voice', (req, res) => {
    console.log('Prišiel nový hovor z Twilia:', {
        CallSid: req.body.CallSid,
        From: req.body.From,
        To: req.body.To,
    });

    const wssUrl = `wss://${req.headers.host}/media-stream`;

    const twiml = `
<Response>
    <Connect>
        <Stream url="${wssUrl}" />
    </Connect>
</Response>`;

    res.type('text/xml');
    res.send(twiml);
});

// ==========================================
// 3. CARTESIA TOOL CALL WEBHOOK (ULOŽENIE OBJEDNÁVKY)
// ==========================================
const authenticateWebhook = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const expectedToken = `Bearer ${process.env.AGENT_WEBHOOK_SECRET}`;

    if (!authHeader || authHeader !== expectedToken) {
        console.warn('Neautorizovaný pokus o uloženie objednávky z Cartesie');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

app.post('/api/uloz-objednavku', authenticateWebhook, async (req, res) => {
    try {
        const { pizza, adresa } = req.body;

        if (!pizza || !adresa) {
            return res.status(400).json({ error: 'Chýba pizza alebo adresa' });
        }

        console.log('\n=== 🍕 NOVÁ OBJEDNÁVKA ZO SYSTEMU CARTESIA 🍕 ===');
        console.log(`Pizza:  ${pizza}`);
        console.log(`Adresa: ${adresa}`);
        console.log('==================================================\n');

        const { data, error } = await supabase
            .from('orders')
            .insert([{ pizza: pizza, adresa: adresa }])
            .select();

        if (error) {
            console.error('Chyba pri ukladaní do Supabase:', error);
            return res.status(500).json({ error: 'Chyba databázy' });
        }

        console.log(`✅ Objednávka uložená do Supabase (ID: ${data[0].id})`);

        res.status(200).json({
            status: "success",
            message: "Objednávka bola úspešne uložená."
        });

    } catch (error) {
        console.error('Chyba vo webhooku pre objednávky:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==========================================
// 4. WEBSOCKET SERVER (OBOJSMERNÝ AUDIO STREAM TWILIO <-> CARTESIA)
// ==========================================
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (twilioWs) => {
    console.log('📱 Nové Twilio WebSocket pripojenie otvorené');
    let streamSid = null;
    let cartesiaWs = null;

    twilioWs.on('message', (message) => {
        const msg = JSON.parse(message);

        switch (msg.event) {
            case 'start':
                streamSid = msg.start.streamSid;
                console.log(`▶️ Začal sa Twilio Audio Stream. SID: ${streamSid}`);

                const cartesiaUrl = 'wss://api.cartesia.ai/v1/agents/stream';

                cartesiaWs = new WebSocket(cartesiaUrl, {
                    headers: {
                        'Authorization': `Bearer ${process.env.CARTESIA_API_KEY}`,
                        'X-Cartesia-Agent-Id': process.env.CARTESIA_AGENT_ID,
                        'X-Sample-Rate': '8000'
                    }
                });

                cartesiaWs.on('open', () => {
                    console.log('✅ Úspešne pripojené na Cartesia AI WebSocket');
                });

                cartesiaWs.on('message', (cartesiaMessage) => {
                    try {
                        const data = JSON.parse(cartesiaMessage);

                        if (data.type === 'audio' && data.payload) {
                            twilioWs.send(JSON.stringify({
                                event: 'media',
                                streamSid: streamSid,
                                media: { payload: data.payload }
                            }));
                        }
                    } catch (err) {
                        console.error('Chyba pri čítaní správy od Cartesie:', err);
                    }
                });

                cartesiaWs.on('close', () => console.log('🛑 Cartesia WebSocket zatvorený'));
                cartesiaWs.on('error', (err) => console.error('❌ Cartesia WebSocket chyba:', err));
                break;

            case 'media':
                if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) {
                    cartesiaWs.send(JSON.stringify({
                        type: 'audio',
                        payload: msg.media.payload
                    }));
                }
                break;

            case 'stop':
                console.log('⏹️ Hovor ukončený');
                if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) {
                    cartesiaWs.close();
                }
                break;
        }
    });

    twilioWs.on('close', () => {
        console.log('📱 Twilio WebSocket odpojený');
        if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) {
            cartesiaWs.close();
        }
    });
});

// ==========================================
// 5. SPUSTENIE SERVERA (Pre Render.com)
// ==========================================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 API + WebSocket Server beží na porte ${PORT}`);
    console.log('Twilio voice webhook: /twilio/voice');
    console.log('Cartesia order webhook: /api/uloz-objednavku');
});
